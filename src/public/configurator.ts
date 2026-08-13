/**
 * CONFIGURE NYST — the deployment configurator, and Contact.
 *
 * A compact multi-step flow that ends in a quote summary and a conversation.
 * It does not take payment, does not promise a price it cannot honour, and
 * does not pretend a number is exact when it is a starting point.
 *
 * ACCESSIBILITY AND NO-JAVASCRIPT ARE NOT AFTERTHOUGHTS HERE.
 *
 * Every step is a real fieldset in one real form with a real method and action.
 * With JavaScript disabled the whole thing submits in one go and works. The
 * script only adds progressive disclosure — it never becomes the mechanism.
 * A visitor who cannot use our clever flow must still be able to talk to us.
 */
import { escape } from "../product/dashboard.js";
import { publicShell } from "./site.js";
import { PLANS, plan as findPlan, type PlanId } from "./pricing.js";

export interface QuoteInput {
  agents: number;
  consequential_actions_per_month: number;
  environments: number;
  providers: readonly string[];
  outcome_packs: readonly string[];
  deployment: "nyst_cloud" | "self_hosted" | "relay";
  identity: "google" | "enterprise_oidc" | "local";
  needs_security_review: boolean;
  company: string;
  email: string;
  notes: string;
}

export interface QuoteResult {
  recommended_plan: PlanId;
  /** The reason for the recommendation, in the customer's own numbers. */
  rationale: readonly string[];
  /** True when the honest answer is "this needs a conversation". */
  requires_conversation: boolean;
  price_display: string;
  /** Things Nyst will NOT be covering, given these answers. */
  uncovered: readonly string[];
}

const PROVIDERS = ["github", "okta", "stripe", "aws", "other"] as const;
const OUTCOME_PACKS = ["employee_offboarding"] as const;

/**
 * Recommend a plan. Deterministic, and every branch is explainable.
 *
 * Deliberately conservative: anything at or past an envelope boundary rolls up
 * rather than being squeezed into the cheaper tier. A customer discovering at
 * month two that they are over the line is a worse outcome than a slightly
 * higher first conversation.
 */
export function recommendPlan(input: QuoteInput): QuoteResult {
  const rationale: string[] = [];
  const uncovered: string[] = [];
  let recommended: PlanId = "protect";
  let conversation = false;

  if (input.deployment === "self_hosted" || input.deployment === "relay") {
    recommended = "enterprise";
    conversation = true;
    rationale.push(input.deployment === "self_hosted"
      ? "A private or self-hosted deployment is an Enterprise arrangement."
      : "Running a customer-side Relay is an Enterprise arrangement.");
  }
  if (input.identity === "enterprise_oidc") {
    recommended = "enterprise";
    conversation = true;
    rationale.push("Enterprise identity is part of the Enterprise plan.");
  }
  if (input.needs_security_review) {
    recommended = "enterprise";
    conversation = true;
    rationale.push("A formal security review is part of the Enterprise plan.");
  }

  if (recommended !== "enterprise") {
    if (input.agents > 25 || input.consequential_actions_per_month > 1_000_000) {
      recommended = "enterprise";
      conversation = true;
      rationale.push(`${input.agents} Agents and ${input.consequential_actions_per_month.toLocaleString("en-US")} actions per month is past the Scale envelope.`);
    } else if (input.agents > 5 || input.consequential_actions_per_month > 100_000 || input.environments > 1) {
      recommended = "scale";
      rationale.push(`${input.agents} Agents, ${input.consequential_actions_per_month.toLocaleString("en-US")} actions per month and ${input.environments} environments fits Scale.`);
    } else {
      rationale.push(`${input.agents} Agents and ${input.consequential_actions_per_month.toLocaleString("en-US")} actions per month fits Protect.`);
    }
  }

  // Coverage honesty. A provider we do not have a first-party integration for
  // is not a coverage gap we hide behind "custom adapters available".
  const supported = new Set(["github", "okta", "stripe"]);
  const unsupported = input.providers.filter((provider) => !supported.has(provider));
  for (const provider of unsupported) {
    if (provider === "aws") {
      uncovered.push("AWS evidence is an optional module. Until it is connected, Nyst makes no claim about AWS access, and an outcome that requires it stays INDETERMINATE.");
    } else {
      uncovered.push(`Nyst has no first-party integration for "${provider}". You can push observations from it through Evidence Ingest, or run a Relay — but Nyst will not claim coverage it does not have.`);
      conversation = true;
    }
  }
  if (!input.outcome_packs.length) {
    uncovered.push("No Outcome Pack selected. Nyst will control atomic effects but will not establish an end-to-end outcome until a contract exists.");
  }

  const chosen = findPlan(recommended)!;
  return {
    recommended_plan: recommended,
    rationale,
    requires_conversation: conversation || recommended === "enterprise",
    price_display: chosen.price_note ? `${chosen.price} ${chosen.price_note}` : chosen.price,
    uncovered,
  };
}

export function configuratorPage(preselected: string | null, result: QuoteResult | null, submitted: QuoteInput | null): string {
  const selected = (value: string, current: string | null) => (value === current ? " selected" : "");
  return publicShell("Configure Nyst", "/configure", `
  <section class="page-head-public">
    <p class="eyebrow">Configure</p>
    <h1>Configure your deployment</h1>
    <p class="lede">Six questions. At the end you get a recommended plan, a starting price, and — just
      as importantly — a list of what Nyst would <em>not</em> be covering for you.</p>
  </section>

  ${result && submitted ? quoteSummary(result, submitted) : ""}

  <section class="configure">
    <form method="post" action="/configure" class="steps" novalidate>
      <fieldset class="step" data-step="1">
        <legend>Scale</legend>
        <label>How many Agents take consequential actions?
          <input type="number" name="agents" min="1" max="500" value="${submitted?.agents ?? 3}" required></label>
        <label>Roughly how many consequential actions per month?
          <input type="number" name="consequential_actions_per_month" min="0" max="100000000"
                 value="${submitted?.consequential_actions_per_month ?? 50000}" required></label>
        <label>How many environments?
          <input type="number" name="environments" min="1" max="50" value="${submitted?.environments ?? 1}" required></label>
      </fieldset>

      <fieldset class="step" data-step="2">
        <legend>Systems</legend>
        <p class="small">Which systems hold the access you care about?</p>
        ${PROVIDERS.map((provider) => `<label class="check">
          <input type="checkbox" name="providers" value="${provider}"${submitted?.providers.includes(provider) ? " checked" : ""}>
          ${escape(provider)}</label>`).join("")}
      </fieldset>

      <fieldset class="step" data-step="3">
        <legend>Outcomes</legend>
        ${OUTCOME_PACKS.map((pack) => `<label class="check">
          <input type="checkbox" name="outcome_packs" value="${pack}"${submitted?.outcome_packs.includes(pack) ? " checked" : ""}>
          ${escape(pack.replace(/_/g, " "))}</label>`).join("")}
      </fieldset>

      <fieldset class="step" data-step="4">
        <legend>Deployment</legend>
        <label>Where should Nyst run?
          <select name="deployment">
            <option value="nyst_cloud"${selected("nyst_cloud", submitted?.deployment ?? null)}>Nyst cloud</option>
            <option value="relay"${selected("relay", submitted?.deployment ?? null)}>Nyst cloud, with a Relay in our network</option>
            <option value="self_hosted"${selected("self_hosted", submitted?.deployment ?? null)}>Self-hosted</option>
          </select></label>
        <label>How do people sign in?
          <select name="identity">
            <option value="google"${selected("google", submitted?.identity ?? null)}>Google</option>
            <option value="local"${selected("local", submitted?.identity ?? null)}>Email and password</option>
            <option value="enterprise_oidc"${selected("enterprise_oidc", submitted?.identity ?? null)}>Enterprise OIDC</option>
          </select></label>
        <label class="check"><input type="checkbox" name="needs_security_review"${submitted?.needs_security_review ? " checked" : ""}>
          We need a formal security review</label>
      </fieldset>

      <fieldset class="step" data-step="5">
        <legend>You</legend>
        <label>Company <input type="text" name="company" maxlength="120" value="${escape(submitted?.company ?? "")}" required></label>
        <label>Work email <input type="email" name="email" maxlength="320" value="${escape(submitted?.email ?? "")}" required></label>
        <label>Anything else? <textarea name="notes" maxlength="2000" rows="4">${escape(submitted?.notes ?? "")}</textarea></label>
      </fieldset>

      <input type="hidden" name="plan" value="${escape(preselected ?? "")}">
      <div class="step-actions">
        <button type="submit" class="button primary">See my configuration</button>
        <a class="button subtle" href="/contact">Or just talk to us</a>
      </div>
      <p class="small">This does not charge anything and does not sign you up. It produces a summary
        and, if you give us an email, starts a conversation.</p>
    </form>
  </section>`);
}

function quoteSummary(result: QuoteResult, input: QuoteInput): string {
  const chosen = PLANS.find((item) => item.id === result.recommended_plan)!;
  return `<section class="quote">
    <p class="eyebrow">Your configuration</p>
    <h2>${escape(chosen.name)} — ${escape(result.price_display)}</h2>
    <ul class="rationale">${result.rationale.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
    ${result.uncovered.length ? `<div class="uncovered">
      <h3>What Nyst would not be covering</h3>
      <ul>${result.uncovered.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
    </div>` : ""}
    <p class="small">${result.requires_conversation
      ? "This configuration needs a conversation before a firm price. We will come back with a real number, not a range."
      : "This is a starting price. The conversation is about your actual estate, not about upselling you."}</p>
    <div class="hero-cta">
      <a class="button primary" href="/contact?topic=quote&amp;company=${encodeURIComponent(input.company)}">Talk to us</a>
      <a class="button subtle" href="/signup?plan=shadow_trial">Start in Shadow first</a>
    </div>
  </section>`;
}

/* ============================================================== CONTACT */

/**
 * Contact.
 *
 * Reachable from every page, at every animation frame, with no signup, no
 * gate, and a plain email address for anyone who does not want to use a form.
 */
export function contactPage(topic: string | null, sent: boolean): string {
  return publicShell("Contact", "/contact", `
  <section class="page-head-public">
    <p class="eyebrow">Contact</p>
    <h1>Talk to us</h1>
    <p class="lede">No signup, no gate, no qualification form disguised as a conversation.</p>
  </section>

  ${sent ? `<section class="band band-quiet"><h2>Thank you — we have it.</h2>
    <p class="lede">Someone will reply. If it is urgent, email us directly at the address below.</p></section>` : ""}

  <section class="configure">
    <form method="post" action="/contact" class="steps">
      <fieldset class="step">
        <legend>Your message</legend>
        <label>Name <input type="text" name="name" maxlength="120" required></label>
        <label>Work email <input type="email" name="email" maxlength="320" required></label>
        <label>Company <input type="text" name="company" maxlength="120"></label>
        <label>What is this about?
          <select name="topic">
            <option value="general"${topic === "general" || !topic ? " selected" : ""}>General</option>
            <option value="quote"${topic === "quote" ? " selected" : ""}>A configuration or quote</option>
            <option value="security"${topic === "security" ? " selected" : ""}>Security review</option>
            <option value="enterprise"${topic === "enterprise" ? " selected" : ""}>Enterprise</option>
          </select></label>
        <label>Message <textarea name="message" rows="6" maxlength="4000" required></textarea></label>
      </fieldset>
      <div class="step-actions"><button type="submit" class="button primary">Send</button></div>
    </form>
    <p class="small">Or email <a href="mailto:hello@nyst.ai">hello@nyst.ai</a> directly.</p>
  </section>`);
}
