import { en, lit, num, obj, str, type Schema } from "../../core/validate.js";
import {
  STRIPE_CREDENTIAL_REF,
  type StripePublicEffectInput,
  type StripeResolvedEffectInput,
} from "./types.js";

const PI_ID = /^pi_[A-Za-z0-9_]{3,252}$/;
const CHARGE_ID = /^ch_[A-Za-z0-9_]{3,252}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9_]{3,250}$/;
const CURRENCY = /^[a-z]{3}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const PublicSchema: Schema<StripePublicEffectInput> = obj({
  payment_intent_id: str({ min: 6, max: 255, pattern: PI_ID }),
  charge_id: str({ min: 6, max: 255, pattern: CHARGE_ID }),
  amount_minor: num({ int: true, min: 1, max: Number.MAX_SAFE_INTEGER }),
  currency: str({ min: 3, max: 3, pattern: CURRENCY }),
  credential_ref: lit(STRIPE_CREDENTIAL_REF),
});

export const StripeResolvedInputSchema: Schema<StripeResolvedEffectInput> = obj({
  account_id: str({ min: 8, max: 255, pattern: ACCOUNT_ID }),
  payment_intent_id: str({ min: 6, max: 255, pattern: PI_ID }),
  charge_id: str({ min: 6, max: 255, pattern: CHARGE_ID }),
  amount_minor: num({ int: true, min: 1, max: Number.MAX_SAFE_INTEGER }),
  currency: str({ min: 3, max: 3, pattern: CURRENCY }),
  credential_ref: lit(STRIPE_CREDENTIAL_REF),
  livemode: lit(false),
  operation: en(["observe_only", "create_refund", "capture_payment_intent"] as const),
  preflight_payment_intent_status: en([
    "requires_payment_method", "requires_confirmation", "requires_action", "processing",
    "requires_capture", "canceled", "succeeded",
  ] as const),
  consistency_deadline: str({ min: 20, max: 40, pattern: ISO_TIMESTAMP }),
});

export function normalizePublicStripeInput(value: unknown): StripePublicEffectInput {
  const parsed = PublicSchema.parse(value);
  return { ...parsed, currency: parsed.currency.toLowerCase() };
}

export function parseResolvedStripeInput(value: unknown): StripeResolvedEffectInput {
  return StripeResolvedInputSchema.parse(value);
}
