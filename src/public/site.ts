/**
 * THE PUBLIC SITE.
 *
 * It should feel like a causal control room, not generic AI SaaS. The visual
 * metaphor is one idea carried the whole way down:
 *
 *     Actions are paths.
 *     Uncertainty breaks the path.
 *     Evidence repairs the path.
 *     Outcomes combine multiple paths.
 *     Authority decides whether the next path may open.
 *
 * THE RULES THE MOTION MUST OBEY, and the reason they are rules.
 *
 * Animation here teaches the product; it is not decoration. But a visitor who
 * wants to email us must be able to, at every single frame. So: normal browser
 * scrolling, no wheel hijacking, no forced timeline, nav usable before anything
 * animates, Contact never hidden or delayed, and every animation gated behind
 * `prefers-reduced-motion`. Fast scrolling naturally skips the animation
 * because it is scroll-driven rather than time-driven.
 *
 * The logo does not spin.
 */
import { escape } from "../product/dashboard.js";
import { PLANS, PRICING_PROMISE, COMMERCIAL_GUARANTEES } from "./pricing.js";
import { ENTITLEMENT_DISCLAIMER } from "./commercialEntitlement.js";

const NAV = [
  ["/product", "Product"],
  ["/outcomes-explained", "Outcomes"],
  ["/integrations-public", "Integrations"],
  ["/security", "Security"],
  ["/pricing", "Pricing"],
  ["/contact", "Contact"],
] as const;

/**
 * The shell.
 *
 * The nav renders first, in the markup, before any scene. Nothing here has
 * `pointer-events: none`, nothing is `visibility: hidden` until an animation
 * finishes, and Contact is a plain anchor to a plain page.
 */
export function publicShell(title: string, current: string, body: string, options: { description?: string } = {}): string {
  const description = options.description
    ?? "Nyst independently establishes the outcome of consequential AI-agent actions and controls what they may safely do next.";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — Nyst</title>
<meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)} — Nyst">
<meta property="og:description" content="${escape(description)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="/${current === "/" ? "" : escape(current.replace(/^\//, ""))}">
<link rel="icon" href="/brand/favicon.png">
<link rel="stylesheet" href="/assets/site.css">
</head><body class="site">
<a class="skip" href="#main">Skip to content</a>
<header class="site-nav">
  <a class="site-brand" href="/" aria-label="Nyst — home">
    <img src="/brand/nyst-mark.png" alt="" width="28" height="28"><span>nyst</span>
  </a>
  <nav aria-label="Primary">
    ${NAV.map(([href, label]) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${escape(label)}</a>`).join("")}
  </nav>
  <div class="site-cta">
    <a class="site-signin" href="/login">Sign in</a>
    <a class="button subtle" href="/contact">Talk to us</a>
    <a class="button primary" href="/signup?plan=shadow_trial">Start in Shadow</a>
  </div>
</header>
<main id="main">${body}</main>
<footer class="site-foot">
  <div>
    <a class="site-brand" href="/"><img src="/brand/nyst-mark.png" alt="" width="24" height="24"><span>nyst</span></a>
    <p class="small">Know what changed. Prove the outcome. Then continue.</p>
  </div>
  <nav aria-label="Footer">
    ${NAV.map(([href, label]) => `<a href="${href}">${escape(label)}</a>`).join("")}
    <a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/login">Sign in</a>
  </nav>
</footer>
<script src="/assets/site.js" defer></script>
</body></html>`;
}

/**
 * THE HOME PAGE.
 *
 * The opening establishes the name, then gets to the technical claim inside
 * the first viewport. It does NOT say Nyst literally means outcome — it does
 * not, and a company that opens with a slightly-false etymology has told you
 * something about how it treats everything else.
 */
export function homePage(): string {
  return publicShell("Know what your agents actually changed", "/", `
  <section class="hero">
    <div class="hero-mark" aria-hidden="true">
      <!-- The loop. It does not spin; a single point may trace it once during
           a genuine reconciliation, and nowhere else. -->
      <svg viewBox="0 0 120 120" class="loop" role="presentation">
        <path class="loop-path" d="M60 14 C 90 14, 106 38, 106 60 C 106 84, 86 106, 60 106 C 34 106, 14 84, 14 60 C 14 38, 30 14, 60 14 Z"
              fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
      </svg>
    </div>
    <p class="wordmark">nyst</p>
    <p class="devanagari" lang="sa">निष्ठा</p>
    <p class="translit" lang="sa-Latn">niṣṭhā</p>
    <p class="gloss">steadfastness · constancy · a state firmly established</p>
    <p class="gloss-note">For Nyst, the outcome must be established before software is allowed to act again.</p>

    <h1>Know what your agents actually changed.</h1>
    <p class="lede">Nyst independently establishes the outcome of consequential AI-agent actions and
      controls what they may safely do next.</p>
    <div class="hero-cta">
      <a class="button primary" href="/signup?plan=shadow_trial">Start in Shadow</a>
      <a class="button subtle" href="/contact">Talk to us</a>
    </div>
    <p class="small hero-note">Shadow is observation only. Nyst is not in the path, and says so on every number it shows you.</p>
  </section>

  ${scrollStory()}

  <section class="band">
    <h2>Know what changed. Prove the outcome. Then continue.</h2>
    <div class="hero-cta">
      <a class="button primary" href="/signup?plan=shadow_trial">Start in Shadow</a>
      <a class="button subtle" href="/contact">Talk to us</a>
    </div>
  </section>`);
}

/**
 * THE SIGNATURE SCROLL STORY.
 *
 * Thirteen scenes, each a plain section in normal document flow. The visual
 * state is driven by an `is-visible` class an IntersectionObserver adds — so
 * scrolling fast skips the animation instead of queuing it, browser back
 * works, and with JavaScript off every scene renders in its final state.
 */
function scrollStory(): string {
  const scene = (index: number, eyebrow: string, heading: string, body: string, figure: string): string => `
  <section class="scene" data-scene="${index}" aria-labelledby="scene-${index}-heading">
    <div class="scene-copy">
      <p class="eyebrow">${escape(eyebrow)}</p>
      <h2 id="scene-${index}-heading">${escape(heading)}</h2>
      <p>${body}</p>
    </div>
    <div class="scene-figure" aria-hidden="true">${figure}</div>
  </section>`;

  return `<div class="story">
  ${scene(1, "Scene one", "An Agent is trusted to act.",
    "A workflow you already run. An HR Offboarding Agent, with a job to do and permission to do it.",
    node("agent", "HR Offboarding Agent", "known"))}

  ${scene(2, "Scene two", "Offboard Alice.",
    "The instruction is one line. What it actually requires is a <strong>real-world condition</strong>: Alice has no effective production access through the configured controls. That is the outcome, and it is the thing Nyst will hold you to.",
    `<div class="required-outcome"><p class="eyebrow">Required outcome</p>
       <p>Alice has no effective production access through the configured controls.</p></div>`)}

  ${scene(3, "Scene three", "Two systems hold that access.",
    "GitHub and Okta are configured. AWS is not part of this deployment, so Nyst makes no claim about it — and says so rather than leaving you to assume.",
    `<div class="branches">${node("github", "GitHub", "known")}${node("okta", "Okta", "known")}
       ${node("aws", "AWS — not configured", "absent")}</div>`)}

  ${scene(4, "Scene four", "The action leaves.",
    "A single causal trace: the Agent asks Nyst, Nyst dispatches to GitHub. One consequence, one identity, recorded before it is sent.",
    trace("solid"))}

  ${scene(5, "Scene five", "The request left. The response didn't come back.",
    "The effect happened at the provider. The acknowledgement never arrived. Everything downstream of this moment is a guess unless something goes and looks.",
    `${trace("dashed")}<div class="uncertainty" role="presentation"><span class="open-node"></span><span>uncertain</span></div>`)}

  ${scene(6, "Scene six", "Do not retry.",
    "The obvious next move is the dangerous one. A retry here can re-apply a change someone already reversed, or double an effect that already landed. Nyst puts a bar across that path.",
    `${trace("dashed")}<div class="control-bar"><span>DO NOT RETRY</span></div>`)}

  ${scene(7, "Scene seven", "Evidence repairs the path.",
    "Nyst reads GitHub back. Direct access is gone. The atomic path becomes solid — not because the API returned 204, but because an authoritative read says so.",
    `${trace("solid")}<div class="evidence-point"><span></span><p>Direct access = NONE</p></div>`)}

  ${scene(8, "Scene eight", "The API call worked. Reality still doesn't match.",
    "Alice is in a team that grants WRITE to the same repository. Her effective access never changed. Every log in your stack says this offboarding succeeded.",
    `<div class="reveal">
       <p class="claim claim-ok"><strong>ACTION VERIFIED</strong><span>The operation Nyst performed was independently established.</span></p>
       <p class="claim claim-alarm"><strong>OUTCOME UNSATISFIED</strong><span>Inherited team access = WRITE. The required condition is false.</span></p>
     </div>`)}

  ${scene(9, "Scene nine", "So the next step holds.",
    "Anything downstream that depended on this offboarding being complete reaches a barrier, with the exact reason attached. Not a generic error — the specific invariant that is false.",
    `<div class="control-bar hold"><span>HOLD</span></div>
     <p class="reason">Required GitHub effective-access invariant is false.</p>`)}

  ${scene(10, "Scene ten", "Correct it, and Nyst watches the world change.",
    "The inherited path is removed. Okta is suspended and observed SUSPENDED. Each required invariant becomes solid on its own evidence, independently.",
    `<div class="branches">${node("github", "GitHub — effective access NONE", "known")}
       ${node("okta", "Okta — SUSPENDED", "known")}</div>`)}

  ${scene(11, "Scene eleven", "Outcome satisfied.",
    "Every required invariant holds on fresh, authoritative evidence. The top-level node changes only when the evaluator actually changes it — never on a timer, never for effect.",
    `<div class="outcome-node satisfied"><span>OUTCOME</span><strong>SATISFIED</strong></div>`)}

  ${scene(12, "Scene twelve", "Now the next path may open.",
    "A signed ContinuationGrant, narrow and expiring, naming exactly which effects and which resources it permits. The barrier lifts for that, and nothing else.",
    `<div class="grant"><span>ContinuationGrant</span><p class="small">github.repository_permission_change · acme/production · expires in 10 minutes</p></div>`)}

  ${scene(13, "Scene thirteen", "And you have something to show.",
    "A signed Outcome Receipt: what was required, what was observed, which sources it rested on, and what Nyst could not see. It packages truth already established. It creates none.",
    `<div class="receipt"><span>Outcome Receipt</span><p class="small">signed · ed25519 · verifiable offline</p></div>`)}
</div>`;
}

function node(kind: string, label: string, state: "known" | "unknown" | "absent"): string {
  return `<div class="cnode cnode-${escape(kind)} state-${state}"><span class="dot"></span><span>${escape(label)}</span></div>`;
}

function trace(state: "solid" | "dashed"): string {
  return `<div class="trace trace-${state}"><span class="from">Agent</span><span class="line"></span>
    <span class="via">Nyst</span><span class="line"></span><span class="to">GitHub</span></div>`;
}

/* ============================================================== PRICING */

export function pricingPage(): string {
  return publicShell("Pricing", "/pricing", `
  <section class="page-head-public">
    <p class="eyebrow">Pricing</p>
    <h1>${escape(PRICING_PROMISE)}</h1>
    <p class="lede">Start by watching. Nyst shows you the gap between what your Agents believe and
      what is actually true, before it is in the path of anything.</p>
  </section>

  <section class="plans">
    ${PLANS.map((item) => `<article class="plan${item.id === "protect" ? " plan-featured" : ""}">
      <h2>${escape(item.name)}</h2>
      <p class="plan-price">${escape(item.price)}${item.price_note ? `<span>${escape(item.price_note)}</span>` : ""}</p>
      <p class="plan-summary">${escape(item.summary)}</p>
      <ul>${item.includes.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
      ${item.excludes?.length ? `<ul class="plan-excludes">${item.excludes.map((line) =>
        `<li>${escape(line)}</li>`).join("")}</ul>` : ""}
      <a class="button ${item.id === "protect" ? "primary" : "subtle"}" href="${escape(item.cta.href)}">${escape(item.cta.label)}</a>
    </article>`).join("")}
  </section>

  <section class="band band-quiet">
    <h2>What your plan does not change</h2>
    <ul class="guarantees">
      ${COMMERCIAL_GUARANTEES.map((line) => `<li>${escape(line)}</li>`).join("")}
    </ul>
    <p class="small">${escape(ENTITLEMENT_DISCLAIMER)}</p>
  </section>`, { description: PRICING_PROMISE });
}

/* ========================================================== OTHER PAGES */

export function productPage(): string {
  return publicShell("Product", "/product", `
  <section class="page-head-public">
    <p class="eyebrow">Product</p>
    <h1>Three questions, kept separate.</h1>
    <p class="lede">Most systems collapse these into one, and that is where the failure lives.</p>
  </section>
  <section class="layers">
    ${layer("Authority", "What may this Agent do?",
      "An envelope, not a trust score. GitHub revoke autonomous, GitHub grant human, AWS disabled — because removing access and granting it are opposite risks and a single number cannot tell them apart.")}
    ${layer("Effect", "What happened to this operation?",
      "Six states, established from authoritative read-back rather than from a status code. A lost response is not a failure, and a 204 is not proof.")}
    ${layer("Outcome", "What became true in the world?",
      "Three verdicts. An action can be perfectly verified while the thing you actually wanted is still false — and Nyst will tell you that in those words.")}
  </section>
  <section class="band">
    <h2>Nyst refuses to guess, and says which kind of not-knowing it is.</h2>
    <p class="lede">A missing observation, a stale one, one that rests only on a corroborating source,
      and two authoritative sources that disagree are four different situations. All four are
      INDETERMINATE, and none of them is a failure.</p>
    <a class="button primary" href="/signup?plan=shadow_trial">Start in Shadow</a>
  </section>`);
}

function layer(name: string, question: string, body: string): string {
  return `<article class="layer"><p class="eyebrow">${escape(name)}</p>
    <h2>${escape(question)}</h2><p>${escape(body)}</p></article>`;
}

export function outcomesExplainedPage(): string {
  return publicShell("Outcomes", "/outcomes-explained", `
  <section class="page-head-public">
    <p class="eyebrow">Outcomes</p>
    <h1>An action succeeding is not the same as the thing you wanted being true.</h1>
    <p class="lede">The offboarding agent removed Alice's direct repository access. The action was
      verified. Alice is in a team that grants WRITE to the same repository.</p>
  </section>
  <section class="band">
    <p class="claim claim-ok"><strong>ACTION VERIFIED</strong></p>
    <p class="claim claim-alarm"><strong>OUTCOME UNSATISFIED</strong></p>
    <p class="lede">Nyst evaluates the outcome against declared invariants, using evidence it can
      name, with freshness and authority requirements. It never concludes from a status code.</p>
  </section>
  <section class="page-head-public">
    <h2>Coverage, stated honestly</h2>
    <p class="lede">If a system is not connected, Nyst's coverage drops and it says so. A missing
      integration reduces what Nyst can see. It never invents certainty, and an outcome that
      requires evidence Nyst cannot obtain stays INDETERMINATE rather than becoming satisfied.</p>
  </section>`);
}

export function integrationsPublicPage(): string {
  return publicShell("Integrations", "/integrations-public", `
  <section class="page-head-public">
    <p class="eyebrow">Integrations</p>
    <h1>Nyst does not need to integrate with everything.</h1>
    <p class="lede">It needs to be honest about what it can see.</p>
  </section>
  <section class="layers">
    ${layer("First-party", "GitHub, Okta, Stripe",
      "Nyst holds a credential and reads the provider itself, with verified semantics for each supported effect — including what a successful response does and does not establish.")}
    ${layer("Evidence Ingest", "Your systems, pushed",
      "Push structured observations from anything you already run. You push evidence; Nyst evaluates truth. A source may only report the properties you registered it for.")}
    ${layer("Relay", "Your network, your credentials",
      "Run a small service inside your own network. Nyst sends a signed, scoped, single-use read request and gets back an observation. Your provider credentials never leave.")}
  </section>
  <section class="band band-quiet">
    <h2>What is not built yet</h2>
    <p class="lede">Mutation through the Relay is not implemented. It needs a durable dispatch
      boundary on your side and a two-phase protocol for the ambiguous window, and a partial version
      would put a duplicate external effect exactly where Nyst promises there is none.</p>
  </section>`);
}

export function securityPage(): string {
  return publicShell("Security", "/security", `
  <section class="page-head-public">
    <p class="eyebrow">Security</p>
    <h1>What Nyst holds, and what it refuses to.</h1>
  </section>
  <section class="layers">
    ${layer("Credentials", "Opaque references only",
      "Nyst stores a reference to your credential, never the credential. Values resolve through a SecretProvider at the moment of use and are never written to a log, a receipt, an export or a screen.")}
    ${layer("Receipts", "Signed, and verifiable without us",
      "Every Effect Receipt and Outcome Receipt is Ed25519-signed over a canonical form. You can verify one offline, with our public key, after we are gone.")}
    ${layer("History", "Append-only where it matters",
      "Evidence, resolutions, world facts, authority decisions and exceptions are append-only at the database level, enforced by triggers. Correction is a new record, never an edit.")}
    ${layer("No override", "There is no Force Continue",
      "No button, route, SDK method or support tool marks something verified or declares an outcome satisfied. A human can authorize continuation despite what Nyst observed — attributed, reasoned, time-limited — and the observation stays exactly as it was.")}
  </section>
  <section class="band band-quiet">
    <h2>Where Nyst is blind, it says so</h2>
    <p class="lede">A read-only preflight cannot prove a write capability without performing a write.
      Where a provider publishes its own authorization metadata, Nyst reads it. Where it does not,
      the capability is shown as claimed-not-observed, with the name of the person who claimed it.</p>
    <a class="button subtle" href="/contact?topic=security">Request a security review</a>
  </section>`);
}


/* =============================================================== SIGN UP */

/**
 * Start in Shadow.
 *
 * Every "Start in Shadow" button on this site points here, and until now this
 * page did not exist — six dead links on the primary call to action. The site
 * test asserted the LINK was present without ever checking it RESOLVED, which
 * is the same mistake as a button labelled "Request re-observation" that
 * requests nothing.
 *
 * What signing up actually gets you, stated on the page rather than discovered
 * later: a Shadow environment. Nyst observes and evaluates outcomes; it does
 * not control anything until you deliberately move an environment to Canary or
 * Enforced, and the trial entitlement cannot enable that on its own.
 */
export function signupPage(input: {
  plan: string | null;
  /** Null when this deployment can create accounts. A sentence when it cannot. */
  unavailable_reason: string | null;
  error: string | null;
  submitted?: { organization?: string; organization_slug?: string; email?: string; display_name?: string };
}): string {
  const value = (field: keyof NonNullable<typeof input.submitted>) => escape(String(input.submitted?.[field] ?? ""));
  return publicShell("Start in Shadow", "/signup", `
  <section class="page-head-public">
    <p class="eyebrow">Shadow trial</p>
    <h1>Start in Shadow</h1>
    <p class="lede">Nyst watches your existing agents and evaluates outcomes independently.
      It is not in the path of anything, and it will tell you so on every number it shows you.</p>
  </section>

  ${input.unavailable_reason ? `<section class="band band-quiet">
    <h2>Not on this deployment</h2>
    <p class="lede">${escape(input.unavailable_reason)}</p>
    <div class="hero-cta">
      <a class="button primary" href="/contact?topic=general">Talk to us</a>
      <a class="button subtle" href="/pricing">See what is included</a>
    </div>
  </section>` : `
  <section class="configure">
    ${input.error ? `<div class="panel panel-pad note-strong gap-below-l"><p>${escape(input.error)}</p></div>` : ""}
    <form method="post" action="/signup" class="steps">
      <fieldset class="step">
        <legend>Your organization</legend>
        <label>Organization name
          <input type="text" name="organization" maxlength="120" value="${value("organization")}" required></label>
        <label>Short name
          <input type="text" name="organization_slug" maxlength="63" pattern="[a-z][a-z0-9-]{1,62}"
                 value="${value("organization_slug")}" required>
          <span class="small">Lowercase letters, digits and hyphens. This is what you type when you sign in — not the display name.</span>
        </label>
      </fieldset>

      <fieldset class="step">
        <legend>You</legend>
        <label>Your name <input type="text" name="display_name" maxlength="120" value="${value("display_name")}" required></label>
        <label>Work email <input type="email" name="email" maxlength="320" value="${value("email")}" required></label>
        <label>Password
          <input type="password" name="password" minlength="8" maxlength="1024" required autocomplete="new-password">
          <span class="small">At least 8 characters. Nyst stores a bcrypt hash and never the password itself.</span>
        </label>
      </fieldset>

      <input type="hidden" name="plan" value="${escape(input.plan ?? "shadow_trial")}">
      <div class="step-actions">
        <button type="submit" class="button primary">Create my Shadow environment</button>
        <a class="button subtle" href="/login">I already have an account</a>
      </div>
    </form>

    <div class="panel panel-pad gap-l">
      <h3>What this creates</h3>
      <ul>
        <li>One organization, one project, one environment — in <strong>Shadow</strong>.</li>
        <li>Shadow observes and evaluates. It controls nothing, holds nothing and prevents nothing.</li>
        <li>Moving to Canary or Enforced is a deliberate, separate decision, and the trial entitlement does not include it.</li>
        <li>No credit card, and nothing here charges anything.</li>
      </ul>
    </div>
  </section>`}`, { description: "Start a Nyst Shadow trial. Observation only — Nyst is not in the path of anything." });
}

/* ================================================== PASSWORD RECOVERY */

/**
 * Forgot password.
 *
 * The page NEVER says whether an address is known. That is not politeness, it
 * is the whole security property: a form that distinguishes "sent" from "no
 * such account" enumerates your customer list for anyone who wants it.
 */
export function forgotPasswordPage(input: {
  submitted: boolean;
  /** Set only when this deployment cannot send mail at all. */
  delivery_unavailable?: boolean;
  sales_email?: string | null;
} = { submitted: false }): string {
  const body = input.submitted
    ? (input.delivery_unavailable
      ? `<section class="band band-quiet">
        <h2>This deployment cannot send email.</h2>
        <p class="lede">No mail transport is configured, so no reset link was sent. Nothing has changed
          about your account.${input.sales_email ? ` Contact <a href="mailto:${escape(input.sales_email)}">${escape(input.sales_email)}</a> for help.` : ""}</p>
      </section>`
      : `<section class="band band-quiet">
        <h2>Check your email.</h2>
        <p class="lede">If an account exists for that address, a reset link is on its way. It works once
          and expires in 30 minutes.</p>
        <p class="small">Nothing about your account has changed yet. It changes only when you open the
          link and choose a new password — and doing that will sign out every device.</p>
      </section>`)
    : "";

  return publicShell("Reset your password", "/forgot-password", `
  <section class="page-head-public">
    <p class="eyebrow">Account</p>
    <h1>Reset your password</h1>
    <p class="lede">Enter the address you sign in with and we will send a link.</p>
  </section>

  ${body}

  <section class="configure">
    <form method="post" action="/forgot-password" class="steps">
      <fieldset class="step">
        <legend>Your account</legend>
        <label>Email <input type="email" name="email" maxlength="320" required autofocus></label>
      </fieldset>
      <div class="step-actions"><button type="submit" class="button primary">Send reset link</button></div>
    </form>
    <p class="small"><a href="/login">Back to sign in</a></p>
  </section>`);
}

/**
 * Choose a new password.
 *
 * `valid` is false for a link that is wrong, used, cancelled or expired — all
 * four look identical, because telling someone holding a stolen link WHICH
 * kind of stale it is tells them something useful.
 */
export function resetPasswordPage(input: {
  token: string;
  valid: boolean;
  error?: string | null;
  done?: boolean;
}): string {
  if (input.done) {
    return publicShell("Password changed", "/reset-password", `
  <section class="page-head-public">
    <p class="eyebrow">Account</p>
    <h1>Your password is changed.</h1>
    <p class="lede">Every device that was signed in to this account has been signed out, including any
      you did not recognise. Sign in again with your new password.</p>
  </section>
  <section class="configure"><p><a class="button primary" href="/login">Sign in</a></p></section>`);
  }

  if (!input.valid) {
    return publicShell("That link is no longer valid", "/reset-password", `
  <section class="page-head-public">
    <p class="eyebrow">Account</p>
    <h1>That link is no longer valid.</h1>
    <p class="lede">Reset links work once and expire after 30 minutes. Requesting a new one also
      cancels any older link.</p>
  </section>
  <section class="configure"><p><a class="button primary" href="/forgot-password">Request a new link</a></p></section>`);
  }

  return publicShell("Choose a new password", "/reset-password", `
  <section class="page-head-public">
    <p class="eyebrow">Account</p>
    <h1>Choose a new password</h1>
    <p class="lede">At least 12 characters. Length is what makes a password hard to guess — there are no
      rules here about symbols, because those mostly produce <em>Password1!</em></p>
  </section>

  ${input.error ? `<section class="band band-quiet"><h2>That did not work.</h2>
    <p class="lede">${escape(input.error)}</p></section>` : ""}

  <section class="configure">
    <form method="post" action="/reset-password" class="steps">
      <input type="hidden" name="token" value="${escape(input.token)}">
      <fieldset class="step">
        <legend>New password</legend>
        <label>New password <input type="password" name="password" minlength="12" maxlength="1024"
          autocomplete="new-password" required autofocus></label>
      </fieldset>
      <div class="step-actions"><button type="submit" class="button primary">Change password</button></div>
    </form>
    <p class="small">This will sign out every device currently signed in to this account.</p>
  </section>`);
}
