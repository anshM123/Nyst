/**
 * THE CANONICAL OFFBOARDING STAGE ORDER (Phase 20).
 *
 * ONE definition, imported by the runtime, the coordinator, the tests, the
 * Failure Lab, the demo, the UI, onboarding, the docs, and the Protection
 * Report examples. Nothing may state a different order, because telling a
 * customer "GitHub then Okta" while the implementation does "Okta then GitHub"
 * is exactly the kind of quiet inconsistency Nyst exists to eliminate.
 *
 * The order is a safety decision, not a preference:
 *
 *   1. OKTA   — suspend the identity first. While the account is still active
 *               the person can re-authenticate anywhere, so removing repository
 *               access first buys nothing.
 *   2. GITHUB — remove repository access only after Okta suspension is
 *               established. If Okta is ambiguous, Nyst holds here rather than
 *               continuing on an unproven premise.
 *
 * Do not change this order casually. `tests/v022Phase13to20` pins it.
 */
import { GITHUB_EFFECT_NAME } from "../providers/github/types.js";
import { OKTA_EFFECT_NAME } from "../providers/okta/types.js";

export interface OffboardingStage {
  index: 1 | 2;
  key: "okta" | "github";
  effect_name: string;
  title: string;
  /** Why this stage is at this position. Surfaced in the UI and the docs. */
  rationale: string;
  /** What must be established before the NEXT stage may begin. */
  continuation_requirement: string;
}

export const CANONICAL_OFFBOARDING_STAGES: readonly OffboardingStage[] = Object.freeze([
  Object.freeze({
    index: 1, key: "okta", effect_name: OKTA_EFFECT_NAME,
    title: "Suspend the identity in Okta",
    rationale:
      "The identity is the root of access. While the account is active the person can re-authenticate, so revoking downstream access first would not actually contain anything.",
    continuation_requirement:
      "The exact Okta lifecycle status must be established as SUSPENDED, and continuation must be allowed, before GitHub access removal may begin.",
  }),
  Object.freeze({
    index: 2, key: "github", effect_name: GITHUB_EFFECT_NAME,
    title: "Remove repository access in GitHub",
    rationale:
      "With the identity suspended, repository access is removed to close the remaining direct path. Inherited organization or team access is reported rather than assumed away.",
    continuation_requirement:
      "The effective GitHub role must match the desired role with no inherited access remaining for the run to be complete.",
  }),
] as const);

/** The stage order as plain effect names, for assertions and rendering. */
export const CANONICAL_OFFBOARDING_ORDER: readonly string[] = Object.freeze(
  CANONICAL_OFFBOARDING_STAGES.map((stage) => stage.effect_name),
);

/** Human-readable one-liner used wherever the flow is described in prose. */
export const CANONICAL_OFFBOARDING_SUMMARY = "Okta suspension → GitHub access removal";

export function offboardingStage(key: "okta" | "github"): OffboardingStage {
  const stage = CANONICAL_OFFBOARDING_STAGES.find((item) => item.key === key);
  if (!stage) throw new Error(`Unknown offboarding stage ${key}`);
  return stage;
}
