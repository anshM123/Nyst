/**
 * EFFECTSPEC SEMANTICS — pure validation, and authoritative consequence metadata.
 *
 * Two jobs, both of which must happen BEFORE anything durable is written and
 * before Blast Radius consumes a single unit of budget.
 *
 * 1. PURE VALIDATION.
 *    Is this input semantically valid for this exact EffectSpec? No I/O, no
 *    provider call, no database. An invalid request must cost nothing: it must
 *    not consume budget, must not write an admission row, must not be counted
 *    as an action an Agent took. v0.2.2 admitted first and validated inside the
 *    provider commit, so a caller could exhaust an Agent's blast-radius budget
 *    with a stream of malformed requests that never touched a provider.
 *
 * 2. AUTHORITATIVE CONSEQUENCE METADATA.
 *    What money, if any, does this consequence move? Only EffectSpecs with
 *    declared financial semantics may answer with an amount. Nyst does not
 *    scrape an `amount_minor` key out of arbitrary caller JSON — a GitHub
 *    permission change carrying `{"amount_minor": 1}` is not a one-cent
 *    consequence, it is a caller trying to slip under a monetary budget, or a
 *    confused one. Either way the answer is no.
 *
 * THE FAIL-CLOSED RULE.
 *    For an effect that DOES move money, a missing amount or a missing currency
 *    is a refusal, never a zero. Zero would silently pass every monetary budget
 *    ever configured.
 */
import { normalizePublicGitHubInput } from "../providers/github/githubInput.js";
import { normalizePublicOktaInput } from "../providers/okta/oktaInput.js";
import { normalizePublicStripeInput } from "../providers/stripe/stripeInput.js";
import { GITHUB_EFFECT_NAME } from "../providers/github/types.js";
import { OKTA_EFFECT_NAME } from "../providers/okta/types.js";
import { STRIPE_CAPTURE_EFFECT, STRIPE_REFUND_EFFECT } from "../providers/stripe/types.js";
import { SchemaError } from "../core/validate.js";

/** What kind of budget an EffectSpec's consequences can be measured against. */
export type BudgetSemantics = "count_only" | "monetary";

export interface EffectSemantics {
  effect_name: string;
  budget_semantics: BudgetSemantics;
  /**
   * Pure, side-effect-free validation of the caller-supplied input.
   * Throws with a bounded, non-sensitive message when the input is invalid.
   */
  validate(input: unknown): void;
  /**
   * The authoritative amount this consequence moves, in integer minor units.
   * Only defined for `monetary` effects. Returns null when the effect declares
   * no amount, which for a monetary effect is a refusal, not a zero.
   */
  amount_minor(input: unknown): number | null;
  /** ISO-4217 lowercase. Only defined for `monetary` effects. */
  currency(input: unknown): string | null;
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

/** Integer minor units, or null. Never coerces, never rounds, never defaults. */
function minorUnits(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

function currencyCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toLowerCase() : null;
}

const COUNT_ONLY: ReadonlyArray<[string, (input: unknown) => void]> = [
  // GitHub and Okta consequences are measured by COUNT. There is no amount of
  // money in "make Alice a collaborator" or "suspend Bob", and pretending
  // otherwise would let a caller declare one.
  [GITHUB_EFFECT_NAME, (input) => { normalizePublicGitHubInput(input); }],
  [OKTA_EFFECT_NAME, (input) => { normalizePublicOktaInput(input); }],
];

const MONETARY: ReadonlyArray<[string, (input: unknown) => void]> = [
  [STRIPE_REFUND_EFFECT, (input) => { normalizePublicStripeInput(input); }],
  [STRIPE_CAPTURE_EFFECT, (input) => { normalizePublicStripeInput(input); }],
];

const SEMANTICS = new Map<string, EffectSemantics>();

for (const [effectName, validate] of COUNT_ONLY) {
  SEMANTICS.set(effectName, {
    effect_name: effectName,
    budget_semantics: "count_only",
    validate(input) {
      // A count-only effect that is HANDED an amount is refused outright. It is
      // not ignored: silently dropping it would leave the caller believing a
      // monetary budget had been applied to this action.
      const fields = record(input);
      if ("amount_minor" in fields || "currency" in fields) {
        throw new EffectInputError(
          `${effectName} has no authoritative financial semantics, so amount_minor and currency may not be supplied. This EffectSpec is measured by action count.`,
        );
      }
      validate(input);
    },
    amount_minor: () => null,
    currency: () => null,
  });
}

for (const [effectName, validate] of MONETARY) {
  SEMANTICS.set(effectName, {
    effect_name: effectName,
    budget_semantics: "monetary",
    validate(input) { validate(input); },
    amount_minor: (input) => minorUnits(record(input).amount_minor),
    currency: (input) => currencyCode(record(input).currency),
  });
}

export class EffectInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) { super(message); this.name = "EffectInputError"; }
}

/** The declared semantics for an EffectSpec, or null when it declares none. */
export function effectSemantics(effectName: string): EffectSemantics | null {
  return SEMANTICS.get(effectName) ?? null;
}

export interface AuthoritativeConsequenceMetadata {
  amount_minor: number | null;
  currency: string | null;
  budget_semantics: BudgetSemantics;
}

/**
 * Validate the input and derive the authoritative consequence metadata, in one
 * pure step. Throws `EffectInputError` on anything invalid.
 *
 * `unknownEffectIsCountOnly` exists for the development fake and any EffectSpec
 * without declared semantics: they are validated by the runtime later and are
 * measured by count. They can never emit an amount.
 */
export function authoritativeConsequenceMetadata(effectName: string, input: unknown): AuthoritativeConsequenceMetadata {
  const semantics = effectSemantics(effectName);

  if (!semantics) {
    // No declared financial semantics means no amount, ever. An effect Nyst
    // does not have monetary semantics for cannot be budgeted monetarily, and
    // must not be able to claim it can.
    const fields = record(input);
    if ("amount_minor" in fields || "currency" in fields) {
      throw new EffectInputError(
        `${effectName} has no declared financial semantics, so amount_minor and currency may not be supplied.`,
      );
    }
    return { amount_minor: null, currency: null, budget_semantics: "count_only" };
  }

  try {
    semantics.validate(input);
  } catch (error) {
    if (error instanceof EffectInputError) throw error;
    throw new EffectInputError(describeInvalidInput(effectName, error));
  }

  if (semantics.budget_semantics === "count_only") {
    return { amount_minor: null, currency: null, budget_semantics: "count_only" };
  }

  const amount = semantics.amount_minor(input);
  const currency = semantics.currency(input);
  // FAIL CLOSED. A monetary effect with no amount is not a free action.
  if (amount === null) {
    throw new EffectInputError(
      `${effectName} moves money, so it requires an authoritative amount_minor in integer minor units. Nyst will not treat a missing amount as zero.`,
    );
  }
  if (currency === null) {
    throw new EffectInputError(
      `${effectName} moves money, so it requires an ISO-4217 currency. Nyst will not compare amounts across unknown currencies.`,
    );
  }
  return { amount_minor: amount, currency, budget_semantics: "monetary" };
}

/** A bounded, non-sensitive description of why an input was rejected. */
function describeInvalidInput(effectName: string, error: unknown): string {
  const detail = error instanceof SchemaError ? error.issues.join("; ")
    : error instanceof Error ? error.message : "the input did not match the EffectSpec";
  return `Input is not valid for ${effectName}: ${detail.replace(/[\r\n\0]/g, " ").slice(0, 400)}`;
}
