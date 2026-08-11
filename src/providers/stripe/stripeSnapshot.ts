import { StripeRestClient } from "./stripeClient.js";
import {
  StripeContractError,
  StripeObservationError,
  StripePreconditionError,
  type StripeResolvedEffectInput,
  type StripeSafeHeaders,
  type StripeSnapshot,
} from "./types.js";

export async function readStripeSnapshot(
  client: StripeRestClient,
  input: Pick<StripeResolvedEffectInput, "payment_intent_id" | "charge_id" | "amount_minor" | "currency" | "credential_ref">,
  expectedAccountId?: string
): Promise<StripeSnapshot> {
  const account = await client.getAccount(input.credential_ref); require200(account.status, account.headers, "account");
  const payment = await client.getPaymentIntent(input.payment_intent_id, input.credential_ref); require200(payment.status, payment.headers, "PaymentIntent");
  const charge = await client.getCharge(input.charge_id, input.credential_ref); require200(charge.status, charge.headers, "Charge");
  const refunds = await client.listRefunds(input.payment_intent_id, input.credential_ref); require200(refunds.status, refunds.headers, "Refund inventory");
  if (!account.data || !payment.data || !charge.data || !refunds.data) throw new StripeContractError("Stripe snapshot response was empty");
  if (expectedAccountId && account.data.id !== expectedAccountId) throw new StripeContractError("Stripe account identity changed");
  if (payment.data.livemode || charge.data.livemode) throw new StripePreconditionError("Stripe Gate 7 accepts sandbox/test-mode objects only");
  if (payment.data.latest_charge !== charge.data.id || charge.data.payment_intent !== payment.data.id) {
    throw new StripeContractError("Stripe PaymentIntent/Charge identity mismatch");
  }
  if (payment.data.amount !== input.amount_minor || charge.data.amount !== input.amount_minor ||
      payment.data.currency !== input.currency || charge.data.currency !== input.currency) {
    throw new StripePreconditionError("Stripe amount/currency does not match the exact requested goal");
  }
  for (const refund of refunds.data) {
    if (refund.payment_intent !== payment.data.id || refund.charge !== charge.data.id || refund.currency !== input.currency) {
      throw new StripeContractError("Stripe Refund inventory identity/currency mismatch");
    }
  }
  return { account: account.data, payment_intent: payment.data, charge: charge.data, refunds: refunds.data, request_id: refunds.headers.request_id };
}

function require200(status: number, headers: StripeSafeHeaders, label: string): void {
  if (status === 200) return;
  const category = status === 429 ? "rate_limited" : status === 401 || status === 403 || status === 404
    ? "authentication_or_visibility" : "provider_rejection";
  throw new StripeObservationError(`Stripe ${label} observation returned HTTP ${status}`, status, headers, category);
}
