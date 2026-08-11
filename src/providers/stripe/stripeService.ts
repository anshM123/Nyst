import type { ClockAttestor } from "../../core/clock.js";
import type { ActionContext } from "../../model/metadata.js";
import type { CommitOptions, CommitResult, NystRuntime } from "../../runtime/nystRuntime.js";
import { StripeRestClient } from "./stripeClient.js";
import { normalizePublicStripeInput } from "./stripeInput.js";
import { readStripeSnapshot } from "./stripeSnapshot.js";
import { STRIPE_CAPTURE_EFFECT, STRIPE_REFUND_EFFECT, StripePreconditionError, type StripeEffectName, type StripeOperation } from "./types.js";

export class StripeEffectService {
  constructor(private readonly effect: StripeEffectName, private readonly runtime: NystRuntime, private readonly client: StripeRestClient, private readonly clock: ClockAttestor) {}
  async commit(businessKey: string, publicInput: unknown, context: ActionContext, options: CommitOptions = {}): Promise<CommitResult> {
    const input = normalizePublicStripeInput(publicInput);
    if (context.credential_ref !== null && context.credential_ref !== input.credential_ref) throw new StripePreconditionError("Context credential reference does not match Stripe input");
    if (context.value_minor_units !== null && context.value_minor_units !== input.amount_minor) throw new StripePreconditionError("Context monetary value does not match Stripe input");
    if (context.value_currency !== null && context.value_currency.toLowerCase() !== input.currency) throw new StripePreconditionError("Context currency does not match Stripe input");
    const snapshot = await readStripeSnapshot(this.client, input);
    let operation: StripeOperation;
    if (this.effect === STRIPE_REFUND_EFFECT) operation = refundOperation(snapshot, input.amount_minor);
    else operation = captureOperation(snapshot, input.amount_minor);
    const deadline = new Date(Date.parse(this.clock.now().timestamp) + 5 * 60_000).toISOString();
    return this.runtime.commit(this.effect, businessKey, {
      account_id: snapshot.account.id, payment_intent_id: snapshot.payment_intent.id, charge_id: snapshot.charge.id,
      amount_minor: input.amount_minor, currency: input.currency, credential_ref: input.credential_ref, livemode: false,
      operation, preflight_payment_intent_status: snapshot.payment_intent.status, consistency_deadline: deadline,
    }, { ...context, value_minor_units: input.amount_minor, value_currency: input.currency, credential_ref: input.credential_ref }, options);
  }
}

function refundOperation(snapshot: Awaited<ReturnType<typeof readStripeSnapshot>>, amount: number): StripeOperation {
  const exact = snapshot.refunds.filter((r) => r.amount === amount);
  const other = snapshot.refunds.filter((r) => r.amount !== amount);
  if (other.length || exact.length > 1 || snapshot.charge.amount_refunded > 0 && snapshot.charge.amount_refunded !== amount) throw new StripePreconditionError("Partial or multiple-refund topology is unsupported");
  if (snapshot.payment_intent.status !== "succeeded" || !snapshot.charge.paid) throw new StripePreconditionError("Refund requires one succeeded paid PaymentIntent/Charge");
  if (exact.length === 1) return "observe_only";
  if (snapshot.charge.amount_refunded !== 0 || snapshot.charge.refunded) throw new StripePreconditionError("Inconsistent preexisting refund topology");
  return "create_refund";
}
function captureOperation(snapshot: Awaited<ReturnType<typeof readStripeSnapshot>>, amount: number): StripeOperation {
  const pi = snapshot.payment_intent;
  if (snapshot.refunds.length > 0 || snapshot.charge.amount_refunded !== 0 || snapshot.charge.refunded) throw new StripePreconditionError("Capture fixture has an unsupported refund topology");
  if (pi.status === "succeeded" && pi.amount_received === amount && pi.amount_capturable === 0) return "observe_only";
  if (pi.status !== "requires_capture" || pi.capture_method !== "manual" || pi.amount_received !== 0 || pi.amount_capturable !== amount) {
    throw new StripePreconditionError("Only an exact uncaptured manual full-capture topology is supported");
  }
  return "capture_payment_intent";
}

export function stripeRefundService(runtime: NystRuntime, client: StripeRestClient, clock: ClockAttestor): StripeEffectService { return new StripeEffectService(STRIPE_REFUND_EFFECT, runtime, client, clock); }
export function stripeCaptureService(runtime: NystRuntime, client: StripeRestClient, clock: ClockAttestor): StripeEffectService { return new StripeEffectService(STRIPE_CAPTURE_EFFECT, runtime, client, clock); }
