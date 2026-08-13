/**
 * COMMERCIAL ENTITLEMENT.
 *
 * Not billing. There is no Stripe subscription in this release and nothing
 * here charges anyone. This is the small model that answers one question:
 *
 *     Is this organization entitled to TURN ON this commercial feature?
 *
 * THE INVARIANT THAT MATTERS MOST IN THIS FILE.
 *
 * Entitlement may only ever REFUSE. It can stop a trial organization enabling
 * Enforced production control. It can never — under any plan, at any price,
 * for any customer — relax a policy, widen an EffectSpec's safety semantics,
 * move the Autonomy Line, lift a Freeze, raise a Blast Radius budget, or
 * satisfy an Outcome requirement.
 *
 * A paying customer and a trial customer get exactly the same safety. They get
 * different amounts of product. The function below returns `allowed` or
 * `refused` and nothing else: there is no return value that grants authority,
 * and `evaluateAuthority` does not take entitlement as an input.
 */

export type CommercialState = "trial" | "protect" | "scale" | "enterprise";

export const COMMERCIAL_STATES: readonly CommercialState[] = Object.freeze([
  "trial", "protect", "scale", "enterprise",
]);

/** Features entitlement gates. Every one is an amount of product, not a safety level. */
export const GATED_FEATURES = [
  "enforced_mode",
  "canary_mode",
  "additional_agents",
  "additional_environments",
  "custom_outcome_packs",
  "customer_relay",
  "self_hosted_deployment",
  "enterprise_identity",
  "priority_onboarding",
] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

export interface Entitlement {
  state: CommercialState;
  features: readonly GatedFeature[];
  max_agents: number | null;
  max_consequential_actions_per_month: number | null;
  max_shadow_evaluations: number | null;
  /** Null for paid plans. A date for a trial. */
  expires_at: string | null;
  /** True for design partners backfilled by configuration. */
  grandfathered: boolean;
}

const BASE: Readonly<Record<CommercialState, Omit<Entitlement, "expires_at" | "grandfathered" | "state">>> = Object.freeze({
  trial: {
    // A trial organization gets Shadow and everything read-only. It does not
    // get to put Nyst in the path of production consequence automatically,
    // because that is a decision that deserves a conversation.
    features: Object.freeze([]),
    max_agents: 1,
    max_consequential_actions_per_month: 0,
    max_shadow_evaluations: 10_000,
  },
  protect: {
    features: Object.freeze(["enforced_mode", "canary_mode", "additional_agents"] as GatedFeature[]),
    max_agents: 5,
    max_consequential_actions_per_month: 100_000,
    max_shadow_evaluations: null,
  },
  scale: {
    features: Object.freeze([
      "enforced_mode", "canary_mode", "additional_agents", "additional_environments", "priority_onboarding",
    ] as GatedFeature[]),
    max_agents: 25,
    max_consequential_actions_per_month: 1_000_000,
    max_shadow_evaluations: null,
  },
  enterprise: {
    features: Object.freeze([...GATED_FEATURES]),
    max_agents: null,
    max_consequential_actions_per_month: null,
    max_shadow_evaluations: null,
  },
});

export function entitlementFor(input: {
  state: CommercialState;
  expires_at?: string | null;
  grandfathered?: boolean;
  /** Design-partner overrides, applied by configuration rather than by code. */
  feature_overrides?: readonly GatedFeature[];
}): Entitlement {
  const base = BASE[input.state];
  const features = new Set<GatedFeature>([...base.features, ...(input.feature_overrides ?? [])]);
  return {
    state: input.state,
    features: [...features].sort(),
    max_agents: base.max_agents,
    max_consequential_actions_per_month: base.max_consequential_actions_per_month,
    max_shadow_evaluations: base.max_shadow_evaluations,
    expires_at: input.expires_at ?? null,
    grandfathered: input.grandfathered === true,
  };
}

export interface EntitlementDecision {
  /** Only two values. There is no "allowed with reduced safety". */
  decision: "allowed" | "refused";
  /** Why, in words a customer can act on. Never "upgrade to continue". */
  reason: string;
  /** What would change the answer. Null when nothing commercial would. */
  remedy: string | null;
}

/**
 * May this organization enable this feature?
 *
 * Notice the shape: this returns a decision about a FEATURE. It is not
 * consulted anywhere in the authority path, does not appear in
 * `AuthorityRequest`, and has no way to express "and also allow more".
 */
export function mayEnable(
  entitlement: Entitlement,
  feature: GatedFeature,
  now: Date = new Date(),
): EntitlementDecision {
  if (entitlement.expires_at && new Date(entitlement.expires_at).getTime() <= now.getTime()) {
    return {
      decision: "refused",
      // An expired trial does not disable anything already protecting them.
      reason: `This ${entitlement.state} period ended on ${entitlement.expires_at}. Existing safety controls are unaffected: freezes stay active, blast-radius budgets still apply, and nothing already enforced has been turned off.`,
      remedy: "Talk to us to continue.",
    };
  }
  if (entitlement.features.includes(feature)) {
    return { decision: "allowed", reason: `The ${entitlement.state} plan includes ${feature.replace(/_/g, " ")}.`, remedy: null };
  }
  return {
    decision: "refused",
    reason: `${feature.replace(/_/g, " ")} is not included in the ${entitlement.state} plan.`,
    remedy: entitlement.state === "enterprise"
      ? "This should not happen on Enterprise; please contact us."
      : "Configure a deployment to include it.",
  };
}

/**
 * The sentence shown wherever entitlement refuses something.
 *
 * It exists because the natural thing to write is "upgrade to unlock", and
 * that phrasing invites a customer to believe the paid tier is SAFER. It is
 * not. It is larger.
 */
export const ENTITLEMENT_DISCLAIMER =
  "Your plan controls how much of Nyst you can turn on. It never controls how safely Nyst behaves. " +
  "Policy, EffectSpec safety, the Autonomy Line, Emergency Freeze, Blast Radius and Outcome requirements are identical on every plan, including the free trial.";
