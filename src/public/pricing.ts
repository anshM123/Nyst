/**
 * THE CANONICAL PRICING CONFIGURATION.
 *
 * One definition, used by the pricing page, the configurator, the quote
 * summary and the entitlement model. A second copy of a price is a promise
 * waiting to disagree with itself in front of a customer.
 *
 * Sales-led. There is no Stripe subscription billing in this release, and
 * nothing here charges anyone: these are published prices and the CTAs lead to
 * a conversation.
 *
 * Every figure carries "starts at" or "approximately" where that is the honest
 * word. A hard number a customer can hold Nyst to should be a number Nyst can
 * actually hold to.
 */

export type PlanId = "shadow_trial" | "protect" | "scale" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  price: string;
  /** The qualifier, when there is one. Never hidden in small print. */
  price_note: string | null;
  /** One sentence: who this is for. */
  summary: string;
  includes: readonly string[];
  cta: { label: string; href: string };
  /** What this plan explicitly does NOT include, where that matters. */
  excludes?: readonly string[];
}

export const PLANS: readonly Plan[] = Object.freeze([
  Object.freeze({
    id: "shadow_trial" as const,
    name: "Shadow Trial",
    price: "$0",
    price_note: "14 days, no credit card",
    summary: "Watch your existing Agents. Nyst evaluates outcomes independently and shows you the gap, without being in the path.",
    includes: Object.freeze([
      "1 Agent",
      "Up to 10,000 Shadow evaluations",
      "Outcome Shadow",
      "Failure Lab",
      "Protection Report",
      "No credit card",
    ]),
    // Said out loud on the plan itself. A trial that quietly cannot enforce is
    // a trial that ends in a surprise.
    excludes: Object.freeze([
      "Enforced production control — Shadow observes, it does not act",
    ]),
    cta: { label: "Start in Shadow", href: "/signup?plan=shadow_trial" },
  }),
  Object.freeze({
    id: "protect" as const,
    name: "Protect",
    price: "Starts at $1,500",
    price_note: "per month",
    summary: "Nyst in the path. Outcome assurance for a first set of production workloads.",
    includes: Object.freeze([
      "Approximately up to 5 Agents",
      "Approximately up to 100,000 consequential actions per month",
      "Outcome assurance",
      "Shadow, Canary and Enforced",
      "Current built-in Outcome Packs",
      "Current supported EffectSpecs",
      "Blast Radius",
      "Emergency Freeze",
      "Incident Inbox",
      "Signed Effect Receipts",
      "Signed Outcome Receipts",
      "Slack notifications",
      "Standard onboarding",
    ]),
    cta: { label: "Configure your deployment", href: "/configure?plan=protect" },
  }),
  Object.freeze({
    id: "scale" as const,
    name: "Scale",
    price: "Starts at $4,500",
    price_note: "per month",
    summary: "More Agents, more environments, more of your estate under outcome assurance.",
    includes: Object.freeze([
      "Approximately up to 25 Agents",
      "Approximately up to 1,000,000 consequential actions per month",
      "Multiple environments",
      "Larger Outcome usage",
      "Priority onboarding",
      "Expanded integration footprint",
    ]),
    cta: { label: "Configure your deployment", href: "/configure?plan=scale" },
  }),
  Object.freeze({
    id: "enterprise" as const,
    name: "Enterprise",
    price: "Custom annual pricing",
    price_note: null,
    summary: "For estates past the Scale envelope, or deployments that cannot run in our cloud.",
    includes: Object.freeze([
      "25+ Agents",
      "More than 1,000,000 consequential actions",
      "Private or self-hosted deployment",
      "Customer Relay",
      "Custom Outcome Packs",
      "Custom Effect Intelligence",
      "Enterprise identity",
      "Custom integration and evidence adapters",
      "Security review",
      "Support and SLA",
    ]),
    cta: { label: "Talk to us", href: "/contact?topic=enterprise" },
  }),
]);

export function plan(id: string): Plan | null {
  return PLANS.find((item) => item.id === id) ?? null;
}

/** The line under the pricing table. It is the positioning, not a slogan. */
export const PRICING_PROMISE = "Prove the risk first. Pay when you enforce.";

/**
 * What Nyst will not do to you commercially, stated on the pricing page.
 *
 * Every item is a real constraint in the code, not a marketing promise. The
 * entitlement model can refuse to enable a commercial feature; it can never
 * relax a safety constraint, and `commercialEntitlement.ts` has no path to.
 */
export const COMMERCIAL_GUARANTEES: readonly string[] = Object.freeze([
  "Your commercial plan can never widen what an Agent is allowed to do. Entitlement gates features; policy, EffectSpec safety, the Autonomy Line, Freeze, Blast Radius and Outcome requirements are unaffected by what you pay.",
  "Running out of trial does not disable your safety controls. It stops new enforcement being enabled; it does not turn off a Freeze or lift a Blast Radius budget.",
  "There is no usage-based surprise. These are published starting prices and the conversation happens before anything is enforced.",
]);
