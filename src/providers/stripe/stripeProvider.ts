import { canonicalHash, canonicalJson } from "../../core/canonical.js";
import type { ClockAttestor } from "../../core/clock.js";
import type { ActionRecord, DispatchPlan } from "../../model/action.js";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from "../../model/evidence.js";
import type { DispatchResult, ProviderAdapter } from "../../runtime/provider.js";
import type { NewEvidence } from "../../store/store.js";
import { StripeRestClient } from "./stripeClient.js";
import { parseResolvedStripeInput } from "./stripeInput.js";
import { readStripeSnapshot } from "./stripeSnapshot.js";
import {
  STRIPE_API_VERSION,
  STRIPE_CAPTURE_EFFECT,
  STRIPE_REFUND_EFFECT,
  StripeContractError,
  StripeObservationError,
  StripeTransportError,
  type StripeEffectName,
  type StripeResolvedEffectInput,
  type StripeSafeHeaders,
  type StripeSnapshot,
} from "./types.js";

interface Evaluation {
  goal: boolean;
  pending: boolean;
  terminal_failure: boolean;
  inconsistent: boolean;
  attributed: boolean;
  provider_object_id: string;
  observed_status: string;
}

export class StripeEffectProvider implements ProviderAdapter {
  constructor(
    readonly effect_name: StripeEffectName,
    private readonly client: StripeRestClient,
    private readonly clock: ClockAttestor
  ) {}

  async dispatch(action: ActionRecord, plan: DispatchPlan, onMutation?: () => void | Promise<void>): Promise<DispatchResult> {
    const input = parseResolvedStripeInput(action.input);
    this.assertPlan(action, plan, input);
    let snapshot: StripeSnapshot;
    try { snapshot = await readStripeSnapshot(this.client, input, input.account_id); }
    catch (error) { return this.failure(action, error, "pre_dispatch_revalidation", false); }
    const current = evaluate(this.effect_name, input, snapshot, action.action_id);
    if (input.operation === "observe_only" || current.goal || current.pending || current.terminal_failure) {
      return { send_certainty: "sent", evidence: [this.snapshotEvidence(action, input, snapshot, false)] };
    }
    if (!preconditionStillValid(this.effect_name, input, snapshot)) {
      return { send_certainty: "definitely_not_sent", evidence: [this.transportEvidence(action, "precondition_changed_before_send", "definitely_not_sent")] };
    }
    let response;
    try {
      const key = requiredIdempotencyKey(plan);
      response = this.effect_name === STRIPE_REFUND_EFFECT
        ? await this.client.createRefund(input.payment_intent_id, input.amount_minor, action.action_id, key, input.credential_ref)
        : await this.client.capturePaymentIntent(input.payment_intent_id, input.amount_minor, action.action_id, key, input.credential_ref);
    } catch (error) { return this.failure(action, error, "mutation_transport", true); }
    // Runtime consequence-boundary hooks deliberately sit outside the
    // transport catch. A process crash after a successful Stripe mutation is
    // not a provider response and must propagate to restart recovery.
    if (response.status === 200) await onMutation?.();
    return { send_certainty: "sent", evidence: [this.responseEvidence(action, input, response.status, response.headers)] };
  }

  async observe(action: ActionRecord, plan: DispatchPlan, priorEvidence: readonly EvidenceRecord[] = []): Promise<NewEvidence[]> {
    const input = parseResolvedStripeInput(action.input);
    this.assertPlan(action, plan, input);
    let snapshot: StripeSnapshot;
    try { snapshot = await readStripeSnapshot(this.client, input, input.account_id); }
    catch (error) {
      if (error instanceof StripeObservationError) return [this.observationFailure(action, error)];
      throw error;
    }
    const provenNotSent = priorEvidence.some((item) => item.source === "nyst.dispatch-boundary" &&
      item.payload && typeof item.payload === "object" &&
      (item.payload as { send_certainty?: unknown }).send_certainty === "definitely_not_sent");
    const evidence = this.snapshotEvidence(action, input, snapshot, provenNotSent);
    const prior = priorEvidence.filter((item) => item.source === `stripe.${this.effect_name === STRIPE_REFUND_EFFECT ? "refund" : "payment-capture"}` &&
      payloadType(item.payload) === "stripe_effect_snapshot").at(-1);
    if (prior && prior.provider_event_id !== evidence.provider_event_id) evidence.supersedes_evidence_id = prior.evidence_id;
    return [evidence];
  }

  private snapshotEvidence(action: ActionRecord, input: StripeResolvedEffectInput, snapshot: StripeSnapshot, forceElapsed: boolean): NewEvidence {
    const now = this.clock.now();
    const state = evaluate(this.effect_name, input, snapshot, action.action_id);
    const elapsed = forceElapsed || new Date(now.timestamp).getTime() >= new Date(input.consistency_deadline).getTime();
    const payload = {
      type: "stripe_effect_snapshot",
      effect_name: this.effect_name,
      account_id: snapshot.account.id,
      payment_intent_id: snapshot.payment_intent.id,
      charge_id: snapshot.charge.id,
      amount_minor: input.amount_minor,
      currency: input.currency,
      livemode: false,
      observed_status: state.observed_status,
      goal_matches: state.goal,
      pending: state.pending,
      terminal_failure: state.terminal_failure,
      inconsistent: state.inconsistent,
      attribution_matches: state.attributed,
      consistency_window_elapsed: elapsed,
      request_id: snapshot.request_id,
    };
    const material = { ...payload, request_id: undefined };
    return this.base(action, {
      kind: state.goal ? "provider_read" : elapsed || state.terminal_failure ? "absence_probe" : "provider_read",
      strength: state.goal || elapsed || state.terminal_failure ? "authoritative" : "circumstantial",
      verification_method: state.goal || !elapsed ? "provider_read_back" : "absence_window_probe",
      observed_disposition: state.goal ? "effect_present" : elapsed || state.terminal_failure ? "effect_absent" : "indeterminate",
      attribution: state.goal ? state.attributed ? "attributed" : "unattributed" : "indeterminate",
      provider_object_id: state.provider_object_id,
      provider_event_id: `stripe:snapshot:${canonicalHash(material)}`,
      payload,
    });
  }

  private responseEvidence(action: ActionRecord, input: StripeResolvedEffectInput, status: number, headers: StripeSafeHeaders): NewEvidence {
    return this.base(action, {
      kind: "provider_response", strength: "corroborative", verification_method: "response_inspection",
      observed_disposition: "indeterminate", attribution: "indeterminate",
      provider_object_id: `stripe:payment_intent:${input.payment_intent_id}`,
      provider_event_id: `stripe:mutation:${headers.request_id ?? `${action.action_id}:${status}`}`,
      payload: { type: "stripe_mutation_response", effect_name: this.effect_name, operation: input.operation, http_status: status, request_id: headers.request_id },
    });
  }

  private observationFailure(action: ActionRecord, error: StripeObservationError): NewEvidence {
    const now = this.clock.now();
    const nextCheckAt = error.category === "rate_limited" ? boundedNextCheck(now.timestamp, error.headers) : null;
    const payload = { type: "stripe_observation_failure", effect_name: this.effect_name, category: error.category, http_status: error.status, next_check_at: nextCheckAt };
    return this.base(action, {
      kind: "provider_response", strength: "corroborative", verification_method: "response_inspection",
      observed_disposition: "indeterminate", attribution: "indeterminate", provider_object_id: null,
      provider_event_id: `stripe:observation-failure:${canonicalHash(payload)}`, payload,
    });
  }

  private failure(action: ActionRecord, error: unknown, stage: string, afterSendBoundary: boolean): DispatchResult {
    const certainty = error instanceof StripeTransportError ? error.send_certainty : afterSendBoundary ? "may_have_been_sent" : "definitely_not_sent";
    return { send_certainty: certainty, evidence: [this.transportEvidence(action, stage, certainty)] };
  }
  private transportEvidence(action: ActionRecord, category: string, certainty: "definitely_not_sent" | "may_have_been_sent" | "sent"): NewEvidence {
    return this.base(action, {
      kind: "transport_error", strength: "transport_only", verification_method: "none", observed_disposition: "indeterminate",
      attribution: "indeterminate", provider_object_id: null, provider_event_id: null,
      payload: { type: "stripe_transport_failure", effect_name: this.effect_name, category, send_certainty: certainty },
    });
  }
  private base(action: ActionRecord, over: Pick<NewEvidence, "kind" | "strength" | "verification_method" | "observed_disposition" | "attribution" | "provider_object_id" | "provider_event_id" | "payload">): NewEvidence {
    const now = this.clock.now();
    return { action_id: action.action_id, evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: `stripe.${this.effect_name === STRIPE_REFUND_EFFECT ? "refund" : "payment-capture"}`,
      observed_at: now.timestamp, provider_timestamp: null,
      correlation: { method: "nyst_action_id", value: action.action_id }, signing: null, clock: now, supersedes_evidence_id: null, ...over };
  }
  private assertPlan(action: ActionRecord, plan: DispatchPlan, input: StripeResolvedEffectInput): void {
    const expected = stripeDispatchPlan(this.effect_name, action, input);
    if (canonicalJson(plan) !== canonicalJson(expected)) throw new StripeContractError("Persisted Stripe DispatchPlan does not match the bound action");
  }
}

export function stripeDispatchPlan(effect: StripeEffectName, action: ActionRecord, input: StripeResolvedEffectInput): DispatchPlan {
  return {
    correlation: { method: "nyst_action_id", value: action.action_id },
    idempotency_key: `nyst:${effect}:${action.action_id}`,
    description: `Stripe ${input.operation} for ${input.payment_intent_id}, exact ${input.amount_minor} ${input.currency}`,
    provider: "stripe", operation: input.operation, api_version: STRIPE_API_VERSION, credential_ref: input.credential_ref,
    target: { account_id: input.account_id, payment_intent_id: input.payment_intent_id, charge_id: input.charge_id,
      amount_minor: input.amount_minor, currency: input.currency, livemode: false, consistency_deadline: input.consistency_deadline },
  };
}

export function evaluate(effect: StripeEffectName, input: StripeResolvedEffectInput, snapshot: StripeSnapshot, actionId: string): Evaluation {
  if (effect === STRIPE_REFUND_EFFECT) {
    const exact = snapshot.refunds.filter((r) => r.amount === input.amount_minor);
    const inconsistent = snapshot.refunds.length > 1 || snapshot.refunds.some((r) => r.amount !== input.amount_minor) ||
      ![0, input.amount_minor].includes(snapshot.charge.amount_refunded) ||
      snapshot.charge.refunded !== (snapshot.charge.amount_refunded === input.amount_minor);
    const succeeded = exact.find((r) => r.status === "succeeded");
    const pending = exact.some((r) => r.status === "pending" || r.status === "requires_action");
    const failed = exact.some((r) => r.status === "failed" || r.status === "canceled");
    const goal = !inconsistent && Boolean(succeeded) && snapshot.charge.amount_refunded === input.amount_minor && snapshot.charge.refunded;
    return { goal, pending: !inconsistent && !goal && pending, terminal_failure: !inconsistent && !goal && failed, inconsistent,
      attributed: Boolean(succeeded?.metadata.nyst_action_id === actionId),
      provider_object_id: succeeded ? `stripe:refund:${succeeded.id}` : `stripe:payment_intent:${input.payment_intent_id}`,
      observed_status: succeeded?.status ?? exact[0]?.status ?? "no_refund" };
  }
  const pi = snapshot.payment_intent;
  const inconsistent = snapshot.refunds.length > 0 || snapshot.charge.amount_refunded !== 0 || snapshot.charge.refunded ||
    pi.amount_received < 0 || pi.amount_received > input.amount_minor || pi.amount_capturable > input.amount_minor ||
    (pi.status === "succeeded" && (pi.amount_received !== input.amount_minor || pi.amount_capturable !== 0));
  const goal = !inconsistent && pi.status === "succeeded" && pi.amount_received === input.amount_minor && pi.amount_capturable === 0;
  return { goal, pending: !inconsistent && pi.status === "processing", terminal_failure: !inconsistent && pi.status === "canceled", inconsistent,
    attributed: goal && pi.metadata.nyst_action_id === actionId,
    provider_object_id: `stripe:payment_intent:${pi.id}`, observed_status: pi.status };
}

function preconditionStillValid(effect: StripeEffectName, input: StripeResolvedEffectInput, snapshot: StripeSnapshot): boolean {
  if (effect === STRIPE_REFUND_EFFECT) return snapshot.payment_intent.status === "succeeded" && snapshot.charge.paid &&
    snapshot.charge.amount_refunded === 0 && snapshot.refunds.length === 0;
  return snapshot.payment_intent.status === "requires_capture" && snapshot.payment_intent.capture_method === "manual" &&
    snapshot.payment_intent.amount_received === 0 && snapshot.payment_intent.amount_capturable === input.amount_minor;
}
function requiredIdempotencyKey(plan: DispatchPlan): string {
  if (!plan.idempotency_key || plan.idempotency_key.length > 255) throw new StripeContractError("Stripe idempotency key is missing or invalid");
  return plan.idempotency_key;
}
function payloadType(value: unknown): string | null { return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string" ? (value as { type: string }).type : null; }
function boundedNextCheck(nowIso: string, headers: StripeSafeHeaders): string {
  const now = Date.parse(nowIso); const seconds = headers.retry_after && /^\d+$/.test(headers.retry_after) ? Number(headers.retry_after) : 60;
  return new Date(Math.min(now + 5 * 60_000, Math.max(now + 60_000, now + seconds * 1000))).toISOString();
}
