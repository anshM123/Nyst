/**
 * MemoryStore — deterministic in-memory implementation used by unit tests.
 *
 * It mirrors the PostgreSQL constraints:
 *  - unique (effect_name, business_key) with input-hash collision detection
 *  - append-only evidence with per-action monotonic seq
 *  - internal-state transitions validated against the legal transition map
 *
 * Writes are serialized through an internal promise chain so concurrent
 * `recordIntent` calls behave like serialized SQL transactions.
 * Records handed out are deep-frozen; there is no update/delete API for
 * evidence at all.
 */
import { newUuid } from "../core/ids.js";
import { canonicalHash } from "../core/canonical.js";
import {
  ActionRecordSchema,
  DispatchPlanSchema,
  InputCollisionError,
  type ActionRecord,
  type DispatchPlan,
} from "../model/action.js";
import { assertTransition, type InternalState } from "../model/internalState.js";
import { EvidenceRecordSchema, type EvidenceRecord } from "../model/evidence.js";
import { OutcomeResolutionSchema, type OutcomeResolution } from "../model/resolution.js";
import { assertNoRawCredential } from "../model/metadata.js";
import type {
  ActionLedger,
  EvidenceLedger,
  NewActionIntent,
  NewEvidence,
  ResolutionStore,
  RuntimeLedger,
  Store,
  DispatchGuard,
} from "./store.js";
import type { DispatchClaim, DispatchStatus, RuntimeState } from "../runtime/runtimeState.js";
import type { EffectState } from "../model/effectState.js";
import { MemoryOffboardingRunLedger } from "../offboarding/offboardingRun.js";

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) {
      deepFreeze((v as Record<string, unknown>)[k]);
    }
  }
  return v;
}

const clone = <T>(v: T): T => structuredClone(v);

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

class MemoryActions implements ActionLedger {
  private byId = new Map<string, ActionRecord>();
  private byIdentity = new Map<string, string>(); // effect_name\0business_key -> action_id
  private mutex = new Mutex();

  private key(effect: string, bk: string): string {
    return effect + "\u0000" + bk;
  }

  has(action_id: string): boolean {
    return this.byId.has(action_id);
  }

  recordIntent(intent: NewActionIntent): Promise<{ action: ActionRecord; created: boolean }> {
    return this.mutex.run(() => {
      assertNoRawCredential(intent.context);
      const k = this.key(intent.effect_name, intent.business_key);
      const existingId = this.byIdentity.get(k);
      if (existingId !== undefined) {
        const existing = this.byId.get(existingId)!;
        if (existing.input_hash !== intent.input_hash) {
          throw new InputCollisionError(
            intent.effect_name,
            intent.business_key,
            existing.input_hash,
            intent.input_hash
          );
        }
        return { action: existing, created: false };
      }
      const record: ActionRecord = ActionRecordSchema.parse({
        action_id: newUuid(),
        effect_name: intent.effect_name,
        business_key: intent.business_key,
        input_hash: intent.input_hash,
        input: clone(intent.input),
        spec_version: intent.spec_version,
        internal_state: "intent_recorded",
        dispatch_plan: null,
        context: clone(intent.context),
        created_at: intent.clock.timestamp,
        created_clock: clone(intent.clock),
      });
      deepFreeze(record);
      this.byId.set(record.action_id, record);
      this.byIdentity.set(k, record.action_id);
      return { action: record, created: true };
    });
  }

  async getAction(action_id: string): Promise<ActionRecord | null> {
    return this.byId.get(action_id) ?? null;
  }

  async findByIdentity(effect_name: string, business_key: string): Promise<ActionRecord | null> {
    const id = this.byIdentity.get(this.key(effect_name, business_key));
    return id ? (this.byId.get(id) ?? null) : null;
  }

  transition(action_id: string, from: InternalState, to: InternalState): Promise<ActionRecord> {
    return this.mutex.run(() => {
      const existing = this.byId.get(action_id);
      if (!existing) throw new Error(`Unknown action ${action_id}`);
      if (existing.internal_state !== from) {
        throw new Error(
          `Stale transition: action is in ${existing.internal_state}, expected ${from}`
        );
      }
      assertTransition(from, to);
      if (to === "dispatching" && existing.dispatch_plan === null) {
        throw new Error(
          `Refusing to enter 'dispatching' without a persisted dispatch plan — ` +
            `execution identity must be durable BEFORE any mutation (use prepare()).`
        );
      }
      const next = deepFreeze({ ...clone(existing), internal_state: to });
      this.byId.set(action_id, next);
      return next;
    });
  }

  prepare(action_id: string, plan: DispatchPlan): Promise<ActionRecord> {
    return this.mutex.run(() => {
      const existing = this.byId.get(action_id);
      if (!existing) throw new Error(`Unknown action ${action_id}`);
      if (existing.internal_state !== "intent_recorded") {
        throw new Error(
          `Stale transition: action is in ${existing.internal_state}, expected intent_recorded`
        );
      }
      assertTransition("intent_recorded", "prepared");
      const parsed = DispatchPlanSchema.parse(clone(plan));
      const next = deepFreeze({
        ...clone(existing),
        internal_state: "prepared" as const,
        dispatch_plan: parsed,
      });
      this.byId.set(action_id, next);
      return next;
    });
  }
}

class MemoryEvidence implements EvidenceLedger {
  private byAction = new Map<string, EvidenceRecord[]>();
  private mutex = new Mutex();

  constructor(private readonly actionExists: (action_id: string) => boolean) {}

  append(ev: NewEvidence): Promise<EvidenceRecord> {
    return this.mutex.run(() => {
      if (!this.actionExists(ev.action_id)) throw new Error(`Unknown action ${ev.action_id}`);
      const list = this.byAction.get(ev.action_id) ?? [];
      if (ev.provider_event_id) {
        const duplicate = list.find((item) => item.provider_event_id === ev.provider_event_id);
        if (duplicate) return duplicate;
      }
      const record: EvidenceRecord = EvidenceRecordSchema.parse({
        ...clone(ev),
        evidence_id: newUuid(),
        seq: list.length + 1,
        // The ledger computes the hash from the payload it stores; a caller
        // can never persist {payload: X, hash: hash(Y)}.
        payload_hash: canonicalHash(ev.payload ?? null),
      });
      if (record.supersedes_evidence_id) {
        const target = list.find((e) => e.evidence_id === record.supersedes_evidence_id);
        if (!target) {
          throw new Error(
            `supersedes_evidence_id ${record.supersedes_evidence_id} does not exist for this action`
          );
        }
      }
      deepFreeze(record);
      this.byAction.set(ev.action_id, [...list, record]);
      return record;
    });
  }

  async listForAction(action_id: string): Promise<EvidenceRecord[]> {
    // Records are frozen; return the array copy, elements shared intentionally
    return [...(this.byAction.get(action_id) ?? [])];
  }

  latestSequence(action_id: string): number {
    return this.byAction.get(action_id)?.at(-1)?.seq ?? 0;
  }
}

class MemoryResolutions implements ResolutionStore {
  private byAction = new Map<string, OutcomeResolution[]>();
  constructor(private readonly actionExists: (action_id: string) => boolean) {}
  async save(resolution: OutcomeResolution): Promise<void> {
    OutcomeResolutionSchema.parse(resolution);
    if (!this.actionExists(resolution.action_id)) {
      throw new Error(`Unknown action ${resolution.action_id}`);
    }
    const list = this.byAction.get(resolution.action_id) ?? [];
    if (list.some((item) => item.resolution_id === resolution.resolution_id)) {
      throw new Error(`Duplicate resolution_id ${resolution.resolution_id}`);
    }
    if (
      resolution.runtime &&
      list.some((item) =>
        item.runtime?.resolution_sequence === resolution.runtime!.resolution_sequence
      )
    ) {
      throw new Error(
        `Duplicate resolution sequence ${resolution.runtime.resolution_sequence} for ${resolution.action_id}`
      );
    }
    this.byAction.set(resolution.action_id, [...list, deepFreeze(clone(resolution))]);
  }
  async latestForAction(action_id: string): Promise<OutcomeResolution | null> {
    return this.latest(action_id);
  }

  latest(action_id: string): OutcomeResolution | null {
    const list = this.byAction.get(action_id) ?? [];
    return [...list].sort((a, b) => {
      const as = a.runtime?.resolution_sequence ?? 0;
      const bs = b.runtime?.resolution_sequence ?? 0;
      return as - bs || a.trust.resolved_at.localeCompare(b.trust.resolved_at) ||
        a.resolution_id.localeCompare(b.resolution_id);
    }).at(-1) ?? null;
  }
}

class MemoryRuntime implements RuntimeLedger {
  private byAction = new Map<string, RuntimeState>();
  private mutex = new Mutex();

  constructor(
    private readonly evidenceSequence: (action_id: string) => number,
    private readonly actionExists: (action_id: string) => boolean,
    private readonly latestResolution: (action_id: string) => OutcomeResolution | null
  ) {}

  initialize(action_id: string): Promise<RuntimeState> {
    return this.mutex.run(() => {
      if (!this.actionExists(action_id)) throw new Error(`Unknown action ${action_id}`);
      const existing = this.byAction.get(action_id);
      if (existing) return existing;
      const created = deepFreeze<RuntimeState>({
        action_id,
        dispatch_status: "not_started",
        dispatch_attempts: 0,
        dispatch_claim_token: null,
        compensation_claim_token: null,
        compensation_attempts: 0,
        resolution_sequence: 0,
        evidence_sequence: 0,
        next_check_at: null,
        last_effect_state: null,
      });
      this.byAction.set(action_id, created);
      return created;
    });
  }

  async get(action_id: string): Promise<RuntimeState | null> {
    const state = this.byAction.get(action_id);
    if (!state) return null;
    return deepFreeze<RuntimeState>({
      ...clone(state),
      evidence_sequence: this.evidenceSequence(action_id),
    });
  }

  claimDispatch(
    action_id: string,
    allowed: readonly DispatchStatus[],
    guard?: DispatchGuard | undefined
  ): Promise<DispatchClaim> {
    return this.mutex.run(() => {
      const state = this.byAction.get(action_id);
      if (!state) throw new Error(`Runtime state missing for ${action_id}`);
      const continuation = guard?.continuation;
      const sourceState = continuation ? this.byAction.get(continuation.action_id) : undefined;
      const sourceResolution = continuation
        ? this.latestResolution(continuation.action_id)
        : null;
      const continuationCurrent = !continuation || Boolean(
        sourceState &&
        sourceResolution?.resolution_id === continuation.resolution_id &&
        sourceResolution.control.continuation === "allowed" &&
        sourceState.resolution_sequence === continuation.resolution_sequence &&
        this.evidenceSequence(continuation.action_id) === continuation.evidence_sequence
      );
      if (
        !allowed.includes(state.dispatch_status) ||
        state.dispatch_attempts >= 2 ||
        !continuationCurrent ||
        (guard !== undefined &&
          ((guard.resolution_sequence !== undefined &&
              state.resolution_sequence !== guard.resolution_sequence) ||
            (guard.evidence_sequence !== undefined &&
              this.evidenceSequence(action_id) !== guard.evidence_sequence)))
      ) {
        return {
          claimed: false,
          token: null,
          state: deepFreeze<RuntimeState>({
            ...clone(state),
            evidence_sequence: this.evidenceSequence(action_id),
          }),
        };
      }
      const token = newUuid();
      const next = deepFreeze<RuntimeState>({
        ...clone(state),
        dispatch_status: "claimed",
        dispatch_claim_token: token,
        dispatch_attempts: state.dispatch_attempts + 1,
      });
      this.byAction.set(action_id, next);
      return { claimed: true, token, state: next };
    });
  }

  finishDispatch(
    action_id: string,
    token: string,
    status: Exclude<DispatchStatus, "claimed">
  ): Promise<RuntimeState> {
    return this.mutex.run(() => {
      const state = this.byAction.get(action_id);
      if (!state || state.dispatch_status !== "claimed" || state.dispatch_claim_token !== token) {
        throw new Error(`Stale dispatch claim for ${action_id}`);
      }
      const next = deepFreeze<RuntimeState>({
        ...clone(state),
        dispatch_status: status,
        dispatch_claim_token: null,
      });
      this.byAction.set(action_id, next);
      return next;
    });
  }

  setDispatchStatus(
    action_id: string,
    from: DispatchStatus,
    to: Exclude<DispatchStatus, "claimed">
  ): Promise<RuntimeState> {
    return this.mutex.run(() => {
      const state = this.byAction.get(action_id);
      if (!state || state.dispatch_status !== from) {
        throw new Error(`Stale dispatch status for ${action_id}: expected ${from}`);
      }
      const next = deepFreeze<RuntimeState>({ ...clone(state), dispatch_status: to });
      this.byAction.set(action_id, next);
      return next;
    });
  }

  claimCompensation(action_id: string): Promise<DispatchClaim> {
    return this.mutex.run(() => {
      const state = this.byAction.get(action_id);
      if (!state) throw new Error(`Runtime state missing for ${action_id}`);
      if (state.compensation_claim_token !== null || state.compensation_attempts > 0) {
        return { claimed: false, token: null, state };
      }
      const token = newUuid();
      const next = deepFreeze<RuntimeState>({
        ...clone(state),
        compensation_claim_token: token,
        compensation_attempts: 1,
      });
      this.byAction.set(action_id, next);
      return { claimed: true, token, state: next };
    });
  }

  finishCompensation(action_id: string, token: string): Promise<RuntimeState> {
    return this.mutex.run(() => {
      const state = this.byAction.get(action_id);
      if (!state || state.compensation_claim_token !== token) {
        throw new Error(`Stale compensation claim for ${action_id}`);
      }
      const next = deepFreeze<RuntimeState>({ ...clone(state), compensation_claim_token: null });
      this.byAction.set(action_id, next);
      return next;
    });
  }

  nextResolutionSequence(
    action_id: string,
    effect_state: EffectState,
    next_check_at: string | null
  ): Promise<number> {
    return this.mutex.run(() => {
      const state = this.byAction.get(action_id);
      if (!state) throw new Error(`Runtime state missing for ${action_id}`);
      const sequence = state.resolution_sequence + 1;
      const next = deepFreeze<RuntimeState>({
        ...clone(state),
        resolution_sequence: sequence,
        next_check_at,
        last_effect_state: effect_state,
        evidence_sequence: this.evidenceSequence(action_id),
      });
      this.byAction.set(action_id, next);
      return sequence;
    });
  }
}

export function createMemoryStore(): Store {
  const actions = new MemoryActions();
  const evidence = new MemoryEvidence((action_id) => actions.has(action_id));
  const resolutions = new MemoryResolutions((action_id) => actions.has(action_id));
  return {
    actions,
    evidence,
    resolutions,
    runtime: new MemoryRuntime(
      (action_id) => evidence.latestSequence(action_id),
      (action_id) => actions.has(action_id),
      (action_id) => resolutions.latest(action_id)
    ),
    offboarding: new MemoryOffboardingRunLedger(),
  };
}
