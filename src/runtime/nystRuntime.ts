import { canonicalJson } from "../core/canonical.js";
import type { ClockAttestor } from "../core/clock.js";
import { newUuid } from "../core/ids.js";
import type { Signer } from "../core/signing.js";
import { ControlDecisionSchema, type ControlDecision } from "../model/controlDecision.js";
import { assertEffectState } from "../model/effectState.js";
import type { ActionContext } from "../model/metadata.js";
import { computeInputHash, type ActionRecord, type DispatchPlan } from "../model/action.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_STRENGTHS, VERIFICATION_METHODS } from "../model/evidence.js";
import {
  OutcomeResolutionSchema,
  RESOLUTION_VERSION,
  signablePortion,
  type OutcomeResolution,
} from "../model/resolution.js";
import type { EffectAssessment, EffectSpec } from "../spec/effectSpec.js";
import type { DispatchGuard, NewEvidence, Store } from "../store/store.js";
import { applySafetyFloors } from "../engine/safetyFloors.js";
import { DECISION_POLICY_VERSION } from "../engine/resolver.js";
import type { DispatchClaim, DispatchStatus } from "./runtimeState.js";
import {
  ProcessCrashError,
  type ProviderAdapter,
  type RuntimeFaultInjector,
  type RuntimeFaultPoint,
} from "./provider.js";
import { EffectRegistry } from "./registry.js";

export class StaleDecisionError extends Error {
  override name = "StaleDecisionError";
}

export interface CommitResult {
  action: ActionRecord;
  created: boolean;
  resolution: OutcomeResolution;
}

export interface NystRuntimeOptions {
  fault_injector?: RuntimeFaultInjector;
  /** Product hosts may require a durable ownership record before preparation/dispatch. */
  dispatch_eligibility?: (action: ActionRecord) => Promise<void>;
}

export interface ContinuationGuard {
  action_id: string;
  resolution_id: string;
}

export interface CommitOptions {
  continuation_guard?: ContinuationGuard;
  /** Runs after intent persistence (and its crash boundary), before a DispatchPlan may exist. */
  establish_dispatch_eligibility?: (action: ActionRecord) => Promise<void>;
}

export class NystRuntime {
  private readonly providers = new Map<string, ProviderAdapter>();
  private readonly fault?: RuntimeFaultInjector | undefined;
  private readonly dispatchEligibility?: ((action: ActionRecord) => Promise<void>) | undefined;
  /** Dispatches currently owned by this live runtime instance. */
  private readonly activeDispatches = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly registry: EffectRegistry,
    providers: readonly ProviderAdapter[],
    private readonly signer: Signer,
    private readonly clock: ClockAttestor,
    options: NystRuntimeOptions = {}
  ) {
    for (const provider of providers) this.providers.set(provider.effect_name, provider);
    this.fault = options.fault_injector;
    this.dispatchEligibility = options.dispatch_eligibility;
  }

  async commit(
    effect_name: string,
    business_key: string,
    input: unknown,
    context: ActionContext,
    options: CommitOptions = {}
  ): Promise<CommitResult> {
    const prior = await this.store.actions.findByIdentity(effect_name, business_key);
    const spec = prior
      ? this.registry.get(prior.effect_name, prior.spec_version)
      : this.registry.latest(effect_name);
    const parsedInput = spec.input_schema.parse(input);
    const recorded = await this.store.actions.recordIntent({
      effect_name,
      business_key,
      input: parsedInput,
      input_hash: computeInputHash(spec.semantic_fields, parsedInput),
      spec_version: spec.schema_version,
      context,
      clock: this.clock.now(),
    });
    await this.store.runtime.initialize(recorded.action.action_id);
    if (recorded.created) await this.hit("after_intent_persistence", recorded.action);
    await options.establish_dispatch_eligibility?.(recorded.action);
    await this.assertDispatchEligibility(recorded.action);
    await this.hit("after_dispatch_eligibility", recorded.action);
    await this.hit("before_dispatch_plan", recorded.action);

    let action = await this.ensureDispatchPlan(recorded.action, spec);
    const runtime = await this.store.runtime.get(action.action_id);
    if (!runtime) throw new Error(`Runtime state missing for ${action.action_id}`);
    if (runtime.dispatch_status === "not_started") {
      let continuation;
      if (options.continuation_guard) {
        const source = await this.requireCurrentResolution(
          options.continuation_guard.action_id,
          options.continuation_guard.resolution_id
        );
        if (!source.runtime) throw new StaleDecisionError("Continuation has no durable basis");
        if (source.control.continuation !== "allowed") {
          throw new Error("Current resolution blocks dependent continuation");
        }
        continuation = {
          action_id: source.action_id,
          resolution_id: source.resolution_id,
          resolution_sequence: source.runtime.resolution_sequence,
          evidence_sequence: source.runtime.evidence_sequence,
        };
      }
      const dispatched = await this.dispatch(
        action,
        spec,
        ["not_started"],
        continuation ? { continuation } : undefined
      );
      if (!dispatched && continuation) {
        const afterClaim = await this.store.runtime.get(action.action_id);
        if (afterClaim?.dispatch_status === "not_started") {
          throw new StaleDecisionError(
            "Continuation became stale before downstream dispatch ownership was acquired"
          );
        }
      }
    }
    action = (await this.store.actions.getAction(action.action_id)) ?? action;
    const resolution = await this.reconcile(action.action_id);
    return { action, created: recorded.created, resolution };
  }

  async recover(action_id: string): Promise<OutcomeResolution> {
    let action = await this.requireAction(action_id);
    const spec = this.registry.get(action.effect_name, action.spec_version);
    await this.assertDispatchEligibility(action);
    await this.store.runtime.initialize(action_id);
    action = await this.ensureDispatchPlan(action, spec);
    const runtime = await this.store.runtime.get(action_id);
    if (!runtime) throw new Error(`Runtime state missing for ${action_id}`);

    if (runtime.dispatch_status === "not_started") {
      await this.dispatch(action, spec, ["not_started"]);
    } else if (runtime.dispatch_status === "claimed" && runtime.dispatch_claim_token) {
      const liveOwner = this.activeDispatches.get(action_id);
      if (liveOwner) {
        // A concurrent request must not steal a still-live dispatch claim and
        // manufacture a not-sent boundary while its owner may be sending.
        await liveOwner;
      } else {
        // No owner exists in this restarted runtime. The claim was persisted
        // before the exact consequence boundary and is safely recoverable.
        await this.store.runtime.finishDispatch(
          action_id,
          runtime.dispatch_claim_token,
          "definitely_not_sent"
        );
        await this.store.evidence.append(this.definitelyNotSentEvidence(action));
      }
    }
    await this.normalizeLifecycle(action_id);
    return this.reconcile(action_id);
  }

  async reconcile(action_id: string): Promise<OutcomeResolution> {
    const action = await this.requireAction(action_id);
    const spec = this.registry.get(action.effect_name, action.spec_version);
    const provider = this.requireProvider(action.effect_name);
    if (!action.dispatch_plan) throw new Error(`Action ${action_id} has no persisted DispatchPlan`);
    await this.normalizeLifecycle(action_id);
    await this.hit("before_reconciliation", action);

    try {
      const priorEvidence = await this.store.evidence.listForAction(action_id);
      const observed = await provider.observe(action, action.dispatch_plan, priorEvidence);
      await this.appendEvidence(action, observed);
    } catch (error) {
      if (error instanceof ProcessCrashError) throw error;
      await this.store.evidence.append(
        this.internalTransportEvidence(action, `provider observation failed: ${this.errorMessage(error)}`)
      );
    }

    return this.deriveAndPersist(action, spec);
  }

  async retry(action_id: string, resolution_id: string): Promise<OutcomeResolution> {
    const action = await this.requireAction(action_id);
    await this.assertDispatchEligibility(action);
    const spec = this.registry.get(action.effect_name, action.spec_version);
    const latest = await this.requireCurrentResolution(action_id, resolution_id);
    if (!latest.runtime) throw new StaleDecisionError("Resolution has no durable evidence basis");

    const provider = this.requireProvider(action.effect_name);
    if (!action.dispatch_plan) throw new Error(`Action ${action_id} has no persisted DispatchPlan`);
    const priorEvidence = await this.store.evidence.listForAction(action_id);
    const observations = await provider.observe(action, action.dispatch_plan, priorEvidence);
    await this.appendEvidence(action, observations);
    const evidence = await this.store.evidence.listForAction(action_id);
    const currentEvidenceSequence = evidence.at(-1)?.seq ?? 0;
    if (currentEvidenceSequence !== latest.runtime.evidence_sequence) {
      await this.deriveAndPersist(action, spec);
      throw new StaleDecisionError(
        `Resolution ${resolution_id} is stale after material evidence changed`
      );
    }
    if (
      latest.effect.state !== "not_applied" ||
      latest.control.retry !== "allowed" ||
      latest.control.primary !== "retry"
    ) {
      throw new Error("Current resolution does not authorize retry");
    }
    if (!spec.provider_idempotency_semantics) {
      const runtime = await this.store.runtime.get(action_id);
      if (runtime?.dispatch_status !== "definitely_not_sent") {
        throw new Error("Retry requires a proven not-sent boundary or provider idempotency semantics");
      }
    }
    const dispatched = await this.dispatch(
      action,
      spec,
      ["definitely_not_sent", "attempted"],
      {
        resolution_sequence: latest.runtime.resolution_sequence,
        evidence_sequence: latest.runtime.evidence_sequence,
      }
    );
    if (!dispatched) {
      const current = await this.store.resolutions.latestForAction(action_id);
      const currentEvidence = await this.store.evidence.listForAction(action_id);
      if (
        current?.runtime?.resolution_sequence !== latest.runtime.resolution_sequence ||
        (currentEvidence.at(-1)?.seq ?? 0) !== latest.runtime.evidence_sequence
      ) {
        throw new StaleDecisionError("Retry decision changed before dispatch ownership was acquired");
      }
      throw new Error("Retry dispatch ownership unavailable or retry budget exhausted");
    }
    return this.reconcile(action_id);
  }

  async compensate(action_id: string): Promise<OutcomeResolution> {
    const action = await this.requireAction(action_id);
    await this.assertDispatchEligibility(action);
    const spec = this.registry.get(action.effect_name, action.spec_version);
    const provider = this.requireProvider(action.effect_name);
    if (!spec.compensation.supported || !provider.compensate) {
      throw new Error(`Compensation is unsupported for ${action.effect_name}`);
    }
    if (!action.dispatch_plan) throw new Error(`Action ${action_id} has no persisted DispatchPlan`);
    const claim = await this.store.runtime.claimCompensation(action_id);
    if (!claim.claimed || !claim.token) throw new Error("Compensation already attempted or in progress");
    try {
      const result = await provider.compensate(action, action.dispatch_plan);
      await this.appendEvidence(action, result.evidence);
      await this.store.runtime.finishCompensation(action_id, claim.token);
    } catch (error) {
      if (error instanceof ProcessCrashError) throw error;
      // Keep the attempted claim durable; an exception must never manufacture
      // `compensated` or silently authorize another compensation mutation.
      throw error;
    }
    return this.reconcile(action_id);
  }

  async authorizeContinuation(action_id: string, resolution_id: string): Promise<void> {
    const latest = await this.requireCurrentResolution(action_id, resolution_id);
    if (!latest.runtime) throw new StaleDecisionError("Resolution has no durable evidence basis");
    const evidence = await this.store.evidence.listForAction(action_id);
    if ((evidence.at(-1)?.seq ?? 0) !== latest.runtime.evidence_sequence) {
      throw new StaleDecisionError("Continuation decision is stale because evidence changed");
    }
    if (latest.control.continuation !== "allowed") {
      throw new Error("Current resolution blocks dependent continuation");
    }
  }

  private async ensureDispatchPlan(action: ActionRecord, spec: EffectSpec): Promise<ActionRecord> {
    if (action.dispatch_plan) return action;
    if (action.internal_state !== "intent_recorded") {
      throw new Error(`Action ${action.action_id} lacks a DispatchPlan in ${action.internal_state}`);
    }
    const candidate = spec.prepareDispatch(action);
    try {
      const prepared = await this.store.actions.prepare(action.action_id, candidate);
      await this.hit("after_dispatch_plan_persistence", prepared);
      return prepared;
    } catch (error) {
      if (error instanceof ProcessCrashError) throw error;
      const winner = await this.requireAction(action.action_id);
      if (!winner.dispatch_plan) throw error;
      if (canonicalJson(winner.dispatch_plan) !== canonicalJson(candidate)) {
        throw new Error("EffectSpec generated an unstable DispatchPlan for an existing action");
      }
      return winner;
    }
  }

  private async assertDispatchEligibility(action: ActionRecord): Promise<void> {
    await this.dispatchEligibility?.(action);
  }

  private async dispatch(
    action: ActionRecord,
    spec: EffectSpec,
    allowed: readonly DispatchStatus[],
    guard?: DispatchGuard | undefined
  ): Promise<boolean> {
    if (!action.dispatch_plan) throw new Error(`Action ${action.action_id} has no persisted DispatchPlan`);
    await this.hit("before_dispatch_claim", action);
    const claim = await this.store.runtime.claimDispatch(action.action_id, allowed, guard);
    if (!claim.claimed || !claim.token) {
      const liveOwner = this.activeDispatches.get(action.action_id);
      if (liveOwner) await liveOwner;
      return false;
    }
    const work = this.dispatchClaimed(action, spec, claim);
    this.activeDispatches.set(action.action_id, work);
    try {
      await work;
    } finally {
      if (this.activeDispatches.get(action.action_id) === work) {
        this.activeDispatches.delete(action.action_id);
      }
    }
    return true;
  }

  private async dispatchClaimed(
    action: ActionRecord,
    _spec: EffectSpec,
    claim: DispatchClaim
  ): Promise<void> {
    if (!claim.token || !action.dispatch_plan) throw new Error("Invalid dispatch claim");
    const provider = this.requireProvider(action.effect_name);
    await this.hit("after_dispatch_claim", action);

    // This durable transition is the exact consequence boundary. A crash
    // before it is definitely-not-sent; a crash after it is ambiguous and
    // must recover through observation, never automatic redispatch.
    await this.store.runtime.finishDispatch(action.action_id, claim.token, "attempted");
    await this.enterDispatching(action.action_id);

    let result;
    try {
      result = await provider.dispatch(action, action.dispatch_plan, () =>
        this.hit("after_provider_mutation", action)
      );
      await this.hit("before_provider_response_delivery", action);
      await this.hit("after_provider_response", action);
      await this.appendEvidence(action, result.evidence);
      if (result.send_certainty === "definitely_not_sent") {
        await this.store.runtime.setDispatchStatus(
          action.action_id,
          "attempted",
          "definitely_not_sent"
        );
        await this.store.evidence.append(this.definitelyNotSentEvidence(action));
      }
    } catch (error) {
      if (error instanceof ProcessCrashError) throw error;
      await this.store.evidence.append(
        this.internalTransportEvidence(action, `provider dispatch failed: ${this.errorMessage(error)}`)
      );
    }
    await this.normalizeLifecycle(action.action_id);
  }

  private async deriveAndPersist(
    action: ActionRecord,
    spec: EffectSpec
  ): Promise<OutcomeResolution> {
    const evidence = await this.store.evidence.listForAction(action.action_id);
    const assessment = this.validateAssessment(spec.assess(action, evidence));
    const proposed = ControlDecisionSchema.parse(spec.decide(action, assessment));
    const floored = applySafetyFloors(spec, assessment, proposed, evidence);
    await this.hit("after_state_derivation", action);
    await this.hit("after_control_derivation", action);

    const runtimeState = await this.store.runtime.get(action.action_id);
    if (!runtimeState) throw new Error(`Runtime state missing for ${action.action_id}`);
    let decision: ControlDecision = floored.decision;
    if (
      decision.retry === "allowed" &&
      !spec.provider_idempotency_semantics &&
      runtimeState.dispatch_status !== "definitely_not_sent"
    ) {
      decision = {
        ...decision,
        primary: decision.primary === "retry" ? "hold" : decision.primary,
        retry: "forbidden",
        reason_code: "CORE.RUNTIME_RETRY_REQUIRES_PROVEN_NOT_SENT",
        explanation: `${decision.explanation} [core runtime adjusted: provider has no idempotency and dispatch was not proven unsent]`,
      };
    }
    if (runtimeState.dispatch_attempts >= 2 && decision.retry === "allowed") {
      decision = {
        ...decision,
        primary: decision.primary === "retry" ? "hold" : decision.primary,
        retry: "forbidden",
        reason_code: "CORE.RUNTIME_RETRY_BUDGET_EXHAUSTED",
        explanation: `${decision.explanation} [core runtime adjusted: retry budget exhausted]`,
      };
    }

    const now = this.clock.now();
    if (floored.state === "pending") {
      decision = {
        ...decision,
        next_check_at: new Date(new Date(now.timestamp).getTime() + 60_000).toISOString(),
      };
    }
    const nextCheck = floored.state === "pending" ? (decision.next_check_at ?? null) : null;
    if (floored.state !== "pending" && decision.next_check_at !== undefined) {
      const { next_check_at: _unused, ...withoutNextCheck } = decision;
      decision = withoutNextCheck;
    }
    const sequence = await this.store.runtime.nextResolutionSequence(
      action.action_id,
      floored.state,
      nextCheck
    );
    const unsigned: OutcomeResolution = {
      resolution_version: RESOLUTION_VERSION,
      resolution_id: newUuid(),
      action_id: action.action_id,
      effect_name: action.effect_name,
      business_key: action.business_key,
      input_hash: action.input_hash,
      effect: {
        state: floored.state,
        provider_object_refs: floored.assessment.provider_object_refs,
        evidence_refs: floored.assessment.evidence_refs,
        verification_methods: floored.assessment.verification_methods,
        evidence_strength: floored.derived_strength,
      },
      control: {
        ...decision,
        policy_version: DECISION_POLICY_VERSION,
        spec_version: spec.schema_version,
      },
      context: action.context,
      runtime: {
        resolution_sequence: sequence,
        evidence_sequence: evidence.at(-1)?.seq ?? 0,
      },
      trust: {
        created_at: action.created_at,
        resolved_at: now.timestamp,
        clock: now,
        signature: null,
      },
    };
    await this.hit("before_resolution_signing", action);
    const signature = this.signer.sign(signablePortion(unsigned));
    const resolution = OutcomeResolutionSchema.parse({
      ...unsigned,
      trust: { ...unsigned.trust, signature },
    });
    await this.hit("after_resolution_signing", action);
    await this.hit("before_resolution_persistence", action);
    await this.store.resolutions.save(resolution);
    await this.hit("after_resolution_persistence", action);
    return resolution;
  }

  private validateAssessment(value: EffectAssessment): EffectAssessment {
    if (!value || typeof value !== "object") throw new Error("Malformed EffectSpec assessment");
    assertEffectState(value.proposed_state);
    if (!Array.isArray(value.evidence_refs) || !value.evidence_refs.every((v) => typeof v === "string")) {
      throw new Error("Malformed EffectSpec evidence_refs");
    }
    if (!Array.isArray(value.provider_object_refs) || !value.provider_object_refs.every((v) => typeof v === "string")) {
      throw new Error("Malformed EffectSpec provider_object_refs");
    }
    if (
      !Array.isArray(value.verification_methods) ||
      !value.verification_methods.every(
        (v) => (VERIFICATION_METHODS as readonly string[]).includes(v)
      )
    ) {
      throw new Error("Malformed EffectSpec verification_methods");
    }
    if (
      value.claimed_strength !== "none" &&
      !(EVIDENCE_STRENGTHS as readonly string[]).includes(value.claimed_strength)
    ) {
      throw new Error("Malformed EffectSpec claimed_strength");
    }
    if (typeof value.attribution_established !== "boolean") {
      throw new Error("Malformed EffectSpec attribution");
    }
    if (value.next_check_at !== undefined && Number.isNaN(Date.parse(value.next_check_at))) {
      throw new Error("Malformed EffectSpec next_check_at");
    }
    return value;
  }

  private async appendEvidence(action: ActionRecord, records: readonly NewEvidence[]): Promise<void> {
    if (records.length === 0) return;
    await this.hit("before_evidence_persistence", action);
    for (const record of records) {
      if (record.action_id !== action.action_id) {
        throw new Error("Provider attempted to append evidence for another action");
      }
      await this.store.evidence.append(record);
    }
    await this.hit("after_evidence_persistence", action);
  }

  private definitelyNotSentEvidence(action: ActionRecord): NewEvidence {
    const now = this.clock.now();
    const operation = action.dispatch_plan?.idempotency_key ?? action.dispatch_plan?.correlation.value ?? action.action_id;
    return {
      action_id: action.action_id,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: "nyst.dispatch-boundary",
      verification_method: "none",
      kind: "transport_error",
      strength: "transport_only",
      observed_disposition: "indeterminate",
      attribution: "indeterminate",
      provider_object_id: null,
      provider_event_id: `${operation}:nyst:definitely-not-sent`,
      observed_at: now.timestamp,
      provider_timestamp: null,
      payload: { boundary_crossed: false, send_certainty: "definitely_not_sent" },
      correlation: { method: "nyst_operation_id", value: operation },
      signing: null,
      clock: now,
      supersedes_evidence_id: null,
    };
  }

  private internalTransportEvidence(action: ActionRecord, detail: string): NewEvidence {
    const now = this.clock.now();
    return {
      action_id: action.action_id,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: "nyst.runtime",
      verification_method: "none",
      kind: "transport_error",
      strength: "transport_only",
      observed_disposition: "indeterminate",
      attribution: "indeterminate",
      provider_object_id: null,
      provider_event_id: null,
      observed_at: now.timestamp,
      provider_timestamp: null,
      payload: { detail },
      correlation: {
        method: "nyst_operation_id",
        value: action.dispatch_plan?.idempotency_key ?? action.action_id,
      },
      signing: null,
      clock: now,
      supersedes_evidence_id: null,
    };
  }

  private async enterDispatching(action_id: string): Promise<void> {
    const action = await this.requireAction(action_id);
    if (action.internal_state === "prepared") {
      try {
        await this.store.actions.transition(action_id, "prepared", "dispatching");
      } catch (error) {
        if (!/Stale transition/.test(this.errorMessage(error))) throw error;
        const current = await this.requireAction(action_id);
        if (current.internal_state !== "dispatching" && current.internal_state !== "observing") {
          throw error;
        }
      }
    }
  }

  private async normalizeLifecycle(action_id: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const action = await this.requireAction(action_id);
      try {
        if (action.internal_state === "prepared") {
          await this.store.actions.transition(action_id, "prepared", "dispatching");
          continue;
        }
        if (action.internal_state === "dispatching") {
          await this.store.actions.transition(action_id, "dispatching", "observing");
          continue;
        }
        return;
      } catch (error) {
        if (!/Stale transition/.test(this.errorMessage(error))) throw error;
      }
    }
    throw new Error(`Could not converge lifecycle for ${action_id} after concurrent transitions`);
  }

  private async requireAction(action_id: string): Promise<ActionRecord> {
    const action = await this.store.actions.getAction(action_id);
    if (!action) throw new Error(`Unknown action ${action_id}`);
    return action;
  }

  private requireProvider(effect_name: string): ProviderAdapter {
    const provider = this.providers.get(effect_name);
    if (!provider) throw new Error(`No provider adapter registered for ${effect_name}`);
    return provider;
  }

  private async requireCurrentResolution(
    action_id: string,
    resolution_id: string
  ): Promise<OutcomeResolution> {
    const latest = await this.store.resolutions.latestForAction(action_id);
    if (!latest || latest.resolution_id !== resolution_id) {
      throw new StaleDecisionError(`Resolution ${resolution_id} is not current for ${action_id}`);
    }
    return latest;
  }

  private async hit(point: RuntimeFaultPoint, action: ActionRecord): Promise<void> {
    await this.fault?.(point, action);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
