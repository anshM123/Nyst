import type { ClockAttestor } from "../../core/clock.js";
import type { SendCertainty } from "../../runtime/provider.js";

export const STRIPE_API_ORIGIN = "https://api.stripe.com";
export const STRIPE_API_VERSION = "2026-02-25.clover";
export const STRIPE_REFUND_EFFECT = "stripe.refund";
export const STRIPE_CAPTURE_EFFECT = "stripe.payment_capture";
export const STRIPE_REFUND_SPEC_VERSION = `${STRIPE_REFUND_EFFECT}/1.0.0`;
export const STRIPE_CAPTURE_SPEC_VERSION = `${STRIPE_CAPTURE_EFFECT}/1.0.0`;
export const STRIPE_CREDENTIAL_REF = "env:NYST_STRIPE_CREDENTIAL";

export type StripeEffectName = typeof STRIPE_REFUND_EFFECT | typeof STRIPE_CAPTURE_EFFECT;
export type StripeOperation = "observe_only" | "create_refund" | "capture_payment_intent";
export type StripeRefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
export type StripePaymentIntentStatus =
  | "requires_payment_method" | "requires_confirmation" | "requires_action"
  | "processing" | "requires_capture" | "canceled" | "succeeded";

export interface StripePublicEffectInput {
  payment_intent_id: string;
  charge_id: string;
  amount_minor: number;
  currency: string;
  credential_ref: typeof STRIPE_CREDENTIAL_REF;
}

export interface StripeResolvedEffectInput extends StripePublicEffectInput {
  account_id: string;
  livemode: false;
  operation: StripeOperation;
  preflight_payment_intent_status: StripePaymentIntentStatus;
  consistency_deadline: string;
}

export interface StripeAccount { id: string; object: "account"; }
export interface StripePaymentIntent {
  id: string;
  object: "payment_intent";
  livemode: boolean;
  amount: number;
  amount_received: number;
  amount_capturable: number;
  currency: string;
  status: StripePaymentIntentStatus;
  capture_method: string;
  latest_charge: string | null;
  metadata: Readonly<Record<string, string>>;
}
export interface StripeCharge {
  id: string;
  object: "charge";
  livemode: boolean;
  amount: number;
  amount_refunded: number;
  currency: string;
  paid: boolean;
  refunded: boolean;
  payment_intent: string | null;
}
export interface StripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: StripeRefundStatus;
  payment_intent: string | null;
  charge: string | null;
  metadata: Readonly<Record<string, string>>;
}

export interface StripeSnapshot {
  account: StripeAccount;
  payment_intent: StripePaymentIntent;
  charge: StripeCharge;
  refunds: StripeRefund[];
  request_id: string | null;
}

export interface StripeSafeHeaders {
  request_id: string | null;
  retry_after: string | null;
  rate_limited_reason: string | null;
}
export interface StripeApiResponse<T> { status: number; data: T | null; headers: StripeSafeHeaders; }
export interface StripeHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string | null;
  timeout_ms: number;
}
export interface StripeHttpResponse { status: number; headers: Readonly<Record<string, string>>; body: unknown; }
export interface StripeTransport { send(request: StripeHttpRequest): Promise<StripeHttpResponse>; }
export interface StripeCredentialSource { resolve(reference: string): Promise<string>; }

export class EnvironmentStripeCredentialSource implements StripeCredentialSource {
  /**
   * A REFERENCE NAMES A VARIABLE, AND THIS ONE DID NOT (v0.3.1).
   *
   * `STRIPE_CREDENTIAL_REF` is `env:NYST_STRIPE_CREDENTIAL`, and that is the
   * reference an operator must store — `EXPECTED_PROVIDER_REFS` refuses to
   * admit a Stripe action configured with anything else. But this then read a
   * DIFFERENT environment variable — the old Stripe API-key name — entirely.
   *
   * So following the documented reference produced an integration that passed
   * admission and then failed to resolve its credential at execution. GitHub
   * and Okta both read exactly the variable their own reference names; Stripe
   * was the only one where the two disagreed. `v031EnvTemplate` now asserts the
   * general property so a fourth provider cannot reintroduce it.
   */
  async resolve(reference: string): Promise<string> {
    if (reference !== STRIPE_CREDENTIAL_REF) throw new StripeCredentialError("Unsupported Stripe credential reference");
    const key = process.env.NYST_STRIPE_CREDENTIAL;
    if (!key) throw new StripeCredentialError("Stripe credential is unavailable");
    requireTestStripeKey(key);
    return key;
  }
}

export function requireTestStripeKey(key: string): void {
  if (/^[\s]|[\s]$|[\r\n]/.test(key) || !/^(?:sk|rk)_test_[A-Za-z0-9_]{8,255}$/.test(key)) {
    throw new StripeCredentialError("Stripe credential must be a test or restricted-test key");
  }
}

export class StripeCredentialError extends Error { override name = "StripeCredentialError"; }
export class StripeContractError extends Error { override name = "StripeContractError"; }
export class StripePreconditionError extends Error { override name = "StripePreconditionError"; }
export class StripeObservationError extends StripePreconditionError {
  override name = "StripeObservationError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers: StripeSafeHeaders,
    public readonly category: "rate_limited" | "authentication_or_visibility" | "provider_rejection"
  ) { super(message); }
}
export class StripeTransportError extends Error {
  override name = "StripeTransportError";
  constructor(message: string, public readonly send_certainty: SendCertainty) { super(message); }
}
export interface StripeClientOptions {
  clock: ClockAttestor;
  transport?: StripeTransport;
  timeout_ms?: number;
  max_response_bytes?: number;
}
