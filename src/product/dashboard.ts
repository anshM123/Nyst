/**
 * NYST UI (Phase 24).
 *
 * Rebuilt around trust, evidence, consequence, control, operational calm and
 * buyer value. The information architecture is ten surfaces, not dozens:
 *
 *   Overview · Needs Attention · Agents · Actions · Protection
 *   Policies · Effect Registry · Failure Lab · Integrations · Settings
 *
 * Every value rendered here comes from persisted backend state. There is no
 * placeholder data anywhere in this file, and every control either works or is
 * disabled with an honest reason attached.
 */
import { currentExplanation, latestResolution, resolutionHistory, type ResolutionView } from "./actionPresentation.js";
import { sanitizeForProduct } from "./sanitize.js";
import type { CanonicalMetrics, InterventionSummary } from "./canonicalMetrics.js";
import type { EnvironmentMode } from "./controlPlane.js";
import type { GoLiveReadiness } from "./goLiveReadiness.js";
import type { ProtectionReport } from "./protectionReport.js";
import { NYST_SAFETY_FLOOR, POLICY_TEMPLATES } from "./policyTemplates.js";
import { CANONICAL_OFFBOARDING_STAGES, CANONICAL_OFFBOARDING_SUMMARY } from "../offboarding/canonicalStages.js";
import { INTERVENTION_LABELS } from "./slackNotifier.js";

/* ------------------------------------------------------------------ shell */

export interface ShellContext {
  /** Attention count drives the only badge in the navigation. */
  attention?: number;
  project?: string;
  environment?: string;
  mode?: EnvironmentMode;
  frozen?: { reason: string; actor: string; since: string; scope: string } | null;
  /** Projects and environments this session may switch between. */
  projects?: ReadonlyArray<{ project_id: string; project_name: string; environments: ReadonlyArray<{ environment_id: string; environment_name: string }> }>;
  selected_project_id?: string;
  selected_environment_id?: string;
}

const NAV = [
  ["/", "Overview"],
  ["/needs-attention", "Needs Attention"],
  // Outcomes sits above Actions on purpose. What became true in the world is
  // the question the customer actually has; the individual operations are how
  // Nyst got there.
  ["/outcomes", "Outcomes"],
  ["/shadow", "Outcome Shadow"],
  ["/agents", "Agents"],
  ["/actions", "Actions"],
  ["/protection", "Protection"],
] as const;

const NAV_CONFIGURE = [
  ["/autonomy", "Autonomy Line"],
  ["/policies", "Policies"],
  ["/effect-registry", "Effect Registry"],
  ["/failure-lab", "Failure Lab"],
  ["/integrations", "Integrations"],
  ["/settings", "Settings"],
] as const;

export function escape(value: string): string {
  return String(value).replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
}

function page(title: string, body: string, script = "/assets/app.js"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escape(title)} · Nyst</title>` +
    `<link rel="icon" href="/brand/favicon.png" type="image/png">` +
    `<link rel="stylesheet" href="/assets/app.css">` +
    `</head><body>${body}<script src="${script}" defer></script></body></html>`;
}

function shell(title: string, current: string, body: string, context: ShellContext = {}): string {
  const link = ([href, label]: readonly [string, string]): string =>
    `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${escape(label)}` +
    (href === "/needs-attention" && context.attention ? `<span class="count">${context.attention}</span>` : "") + `</a>`;

  const freeze = context.frozen
    ? `<section class="freeze-banner" role="alert">
         <div>
           <h2>Production frozen</h2>
           <p>No new consequential actions will execute in this scope. Existing ambiguous actions continue safe read-only reconciliation.</p>
           <dl>
             <div><dt>Scope</dt><dd>${escape(context.frozen.scope)}</dd></div>
             <div><dt>Activated by</dt><dd>${escape(context.frozen.actor)}</dd></div>
             <div><dt>Since</dt><dd>${escape(context.frozen.since)}</dd></div>
             ${context.frozen.reason ? `<div><dt>Reason</dt><dd>${escape(context.frozen.reason)}</dd></div>` : ""}
           </dl>
         </div>
       </section>`
    : "";

  return page(title, `<a class="skip-link" href="#main">Skip to content</a>
<div class="shell">
  <nav class="sidebar" aria-label="Primary">
    <a class="brand" href="/" aria-label="Nyst — back to Overview"><span class="brand-plate"><img src="/brand/nyst-mark.png" alt=""></span><span>nyst</span></a>
    <div class="nav">${NAV.map(link).join("")}</div>
    <p class="nav-group">Configure</p>
    <div class="nav">${NAV_CONFIGURE.map(link).join("")}</div>
    <div class="sidebar-foot"><p>Nyst v0.3.3</p></div>
  </nav>
  <div class="main">
    <header class="topbar">
      ${contextSwitcher(context)}
      <span class="spacer"></span>
      ${context.mode ? `<span class="mode ${escape(context.mode)}">${escape(context.mode)}</span>` : ""}
      ${context.frozen ? `<span class="mode frozen">frozen</span>` : ""}
      <a class="topbar-home" href="/">Overview</a>
      <button class="subtle" data-signout="true">Sign out</button>
    </header>
    <main class="content" id="main">${freeze}${body}</main>
  </div>
</div>`);
}

/**
 * Project / environment switcher.
 *
 * A real form, not a decorative label: switching posts to the server, which
 * validates that the session may actually reach that project and environment.
 * The browser never decides what a session can see.
 */
function contextSwitcher(context: ShellContext): string {
  const projects = context.projects ?? [];
  if (!projects.length) {
    return `<p class="context" id="nyst-project-context"><strong>${escape(context.project ?? "")}</strong> ${context.environment ? `· ${escape(context.environment)}` : ""}</p>`;
  }
  // ONE select, not two. A separate project picker alongside an environment
  // picker lets a person choose a pair that does not exist, and the only
  // honest answer the server can give to that is a 404. The pair is chosen
  // together, so it is always a pair that exists.
  return `<form class="context" id="nyst-project-context" method="post" action="/v1/context">
    <label class="visually-hidden" for="nyst-project">Project and environment</label>
    <select class="context-select" id="nyst-project" name="context">
      ${projects.flatMap((project) => project.environments.map((environment) =>
        `<option value="${escape(project.project_id)}:${escape(environment.environment_id)}"${environment.environment_id === context.selected_environment_id ? " selected" : ""}>${escape(project.project_name)} · ${escape(environment.environment_name)}</option>`)).join("")}
    </select>
    <button class="subtle" data-switch-context="true">Switch</button>
  </form>`;
}

/* ------------------------------------------------------------------ login */

/**
 * The sign-in page.
 *
 * `google` is passed only when a Google project is actually configured. A
 * "Sign in with Google" button that leads to a 503 is worse than no button, so
 * an unconfigured deployment simply does not render one.
 */
/**
 * The Google "G", inline.
 *
 * INLINE, NOT HOSTED, for two independent reasons. The Content-Security-Policy
 * allows images from 'self' only, so an <img> pointing at gstatic would be
 * blocked and the button would render as a broken image. And a remote asset
 * means every visitor to the sign-in page announces themselves to Google before
 * choosing to sign in with it — a request the customer did not ask for on a
 * page that has not yet asked them anything.
 *
 * The four paths and their colours are Google's own mark, unmodified, which is
 * what their identity guidelines require. The mark is not recoloured, rotated,
 * or redrawn.
 */
const GOOGLE_MARK = `<svg class="google-mark" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
  <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
  <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
  <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
  <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
</svg>`;

export function loginPage(options: { google?: boolean } = {}): string {
  // Rendered only when a Google client is actually configured. A button that
  // can only fail is harder to debug than no button at all.
  const google = options.google === true
    ? `<div class="login-alt">
    <span class="login-or">or</span>
    <a class="google-signin" href="/auth/google/start">${GOOGLE_MARK}<span>Sign in with Google</span></a>
  </div>`
    : "";
  return page("Sign in", `<main class="login">
  <section class="login-brand">
    <span class="brand-plate-wide"><img src="/brand/nyst-domain-wordmark.png" alt="nyst.ai"></span>
    <p class="eyebrow">Effect-control infrastructure</p>
    <h1>Know what happened.<br>Control what happens next.</h1>
    <p>Nyst determines what actually happened after a consequential software action — and decides what is safe to do next.</p>
  </section>
  <section class="login-card">
    <form id="login-form">
      <h2>Sign in to Nyst</h2>
      <label>Organization<input name="organization" autocomplete="organization" required autofocus></label>
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary">Continue</button>
      <p id="login-error" role="alert"></p>
      <p class="small"><a href="/forgot-password">Forgot your password?</a></p>
    </form>${google}
  </section>
</main>`, "/assets/login.js");
}

/* --------------------------------------------------------------- overview */

export function overviewPage(data: CanonicalMetrics, context: ShellContext = {}): string {
  const shadow = data.mode === "shadow";
  // The headline is a claim, so it must be earned. "Protecting" appears only
  // when Nyst is actually controlling actions and has prevented something.
  const headline = shadow
    ? "Nyst is evaluating this environment."
    : data.unsafe_retries_prevented_enforced + data.unsafe_continuations_prevented_enforced > 0
      ? "Nyst is protecting this environment."
      : data.consequential_actions > 0
        ? "Nyst is controlling this environment."
        : "No consequential actions yet.";
  const sub = shadow
    ? "Nyst applies the real EffectSpec semantics to what your software reports, and shows what Enforced Mode would have done. It is not controlling these actions."
    : data.consequential_actions > 0
      ? "Every consequential action below routed through Nyst safety control."
      : "Send your first protected action, or start in Shadow to see your risk before enforcing anything.";

  const cards: ReadonlyArray<readonly [string, number, string, boolean]> = [
    ["Actions protected", data.consequential_actions, "Durable logical actions Nyst controlled", true],
    ["Ambiguous executions", data.ambiguous_executions, "Executions where the caller could not know what happened", false],
    shadow
      ? ["Unsafe retries detected", data.unsafe_retries_detected_shadow, "Would have been blocked. Nyst did not control execution.", true] as const
      : ["Unsafe retries prevented", data.unsafe_retries_prevented_enforced, "Blocked by Nyst while controlling the action", true] as const,
    shadow
      ? ["Continuations detected", data.unsafe_continuations_detected_shadow, "Would have been held. Nyst did not control execution.", false] as const
      : ["Unsafe continuations prevented", data.unsafe_continuations_prevented_enforced, "Held until the external effect was established", false] as const,
    ["Resolved automatically", data.auto_resolved, "Ambiguity Nyst cleared with no human involved", false],
    ["Needs human review", data.human_escalations, "Nyst stopped rather than proceed unsafely", false],
  ];

  const rate = data.consequential_actions > 0 ? Math.round((data.human_escalations / data.consequential_actions) * 100) : 0;

  return shell("Overview", "/", `
  <section class="headline">
    <div>
      <p class="eyebrow">The safety control plane between autonomous software and the systems it changes</p>
      <h1>${escape(headline)}</h1>
      <p class="lede">${escape(sub)}</p>
    </div>
    <div class="mode-stack">
      <span class="mode ${escape(data.mode)}">${escape(data.mode)}</span>
      <small>${escape(data.range.label === "all" ? "All time" : `Last ${data.range.label}`)}</small>
    </div>
  </section>

  <div class="metrics">
    ${cards.map(([label, value, note, primary]) => `<article class="metric${primary ? " is-primary" : ""}">
      <span class="label">${escape(label)}</span>
      <strong class="value">${escape(String(value))}</strong>
      <small class="note">${escape(note)}</small>
    </article>`).join("")}
  </div>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Operating characteristics</p><h2>How Nyst behaved</h2></div></div>
    <div class="panel panel-pad"><dl class="facts">
      <div><dt>Median time to resolve ambiguity</dt><dd>${data.median_reconciliation_duration_ms === null ? "No terminal resolution yet" : `${escape(String(Math.round(data.median_reconciliation_duration_ms)))} ms`}</dd></div>
      <div><dt>Escalation rate</dt><dd>${escape(String(rate))}% of actions needed a human</dd></div>
      <div><dt>Autonomous resolution</dt><dd>${escape(String(data.auto_resolved))} resolved without a human</dd></div>
    </dl></div>
  </section>

  <section class="section">
    <div class="section-head">
      <div><p class="eyebrow">Durable records, never inferred from current state</p><h2>Recent protection</h2></div>
      <a href="/needs-attention">Open incidents →</a>
    </div>
    ${interventionTable(data.recent_interventions)}
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Where the risk is</p><h2>Risk by Agent and Effect</h2></div><a href="/protection">Protection report →</a></div>
    <div class="compare">
      <div>${breakdownList("Agent", data.agent_breakdown)}</div>
      <div>${breakdownList("EffectSpec", data.effect_breakdown)}</div>
    </div>
  </section>`, { ...context, mode: data.mode });
}

function breakdownList(title: string, breakdown: Readonly<Record<string, number>>): string {
  const entries = Object.entries(breakdown).sort((left, right) => right[1] - left[1]).slice(0, 8);
  if (!entries.length) return `<h3>${escape(title)}</h3><p class="empty">No activity yet.</p>`;
  return `<h3>${escape(title)}</h3><ol>${entries.map(([key, count]) =>
    `<li>${escape(key)} <span class="small">— ${escape(String(count))} action${count === 1 ? "" : "s"}</span></li>`).join("")}</ol>`;
}

function interventionTable(items: readonly InterventionSummary[]): string {
  if (!items.length) return `<div class="panel panel-pad"><p class="empty">No interventions have been recorded in this environment yet. That is a real zero, not a placeholder.</p></div>`;
  return `<div class="table-scroll"><table>
    <thead><tr><th scope="col">Intervention</th><th scope="col">Effect</th><th scope="col">Agent</th><th scope="col">Mode</th><th scope="col">When</th></tr></thead>
    <tbody>${items.map((item) => `<tr>
      <td><strong>${escape(INTERVENTION_LABELS[item.kind] ?? item.kind)}</strong><span class="sub">${escape(item.summary)}</span></td>
      <td>${escape(item.effect_name)}</td>
      <td>${escape(item.agent_name ?? "unattributed")}</td>
      <td><span class="mode ${escape(item.mode)}">${escape(item.mode)}</span></td>
      <td class="mono small">${escape(item.occurred_at)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

/* -------------------------------------------------------- needs attention */

export function needsAttentionPage(incidents: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  const body = incidents.length === 0
    ? `<div class="panel panel-pad"><p class="empty">Nothing needs attention. Nyst has not stopped on anything in this environment.</p></div>`
    : incidents.map((incident) => {
        const state = String(incident.effect_state);
        const blocked = state === "unprovable" || String(incident.control_decision) === "escalate";
        const actions = (incident.safe_actions as string[]) ?? [];
        // The deep-link target Slack and email use. Focus lands on the real
        // control inside; nothing here is driven by a query parameter.
        return `<article class="incident${blocked ? " is-blocked" : ""}" id="review-${escape(String(incident.incident_id))}" tabindex="-1">
        <header>
          <div>
            <h3>${escape(String(incident.title))}</h3>
            <div class="meta">
              <span>${escape(String(incident.agent))}</span>
              <span>${escape(String(incident.effect_name))}</span>
              <span>${escape(age(Number(incident.age_seconds)))}</span>
              <span class="mode ${escape(String(incident.mode))}">${escape(String(incident.mode))}</span>
            </div>
          </div>
          <div class="button-row">${badge(state)}<span class="badge neutral">${escape(String(incident.control_decision))}</span></div>
        </header>
        <p class="lede gap-s">${escape(String(incident.why_nyst_stopped))}</p>
        <div class="knowledge">
          <div><h4>What Nyst knows</h4><ul>${((incident.what_nyst_knows as string[]) ?? []).map((fact) => `<li>${escape(fact)}</li>`).join("")}</ul></div>
          <div><h4>What Nyst does not know</h4><ul>${((incident.what_nyst_does_not_know as string[]) ?? []).map((fact) => `<li>${escape(fact)}</li>`).join("")}</ul></div>
        </div>
        ${incident.automatic_reconciliation_suppressed ? `<p class="small gap-s">Automatic reconciliation is suppressed for this action because its policy deadline expired. A human may still request one read-only re-observation.</p>` : ""}
        <div class="actions">
          ${incident.action_id ? `<a class="button" href="/actions/${escape(String(incident.action_id))}">Open action detail</a>` : ""}
          ${actions.includes("request_reobservation")
            ? `<button class="primary" data-review="${escape(String(incident.incident_id))}" data-operation="request_reobservation">Request re-observation</button>`
            : `<button disabled title="A re-observation is already in flight, or this incident has already been handled.">Re-observation unavailable</button>`}
          ${actions.includes("authorize_supported_compensation")
            ? `<button data-review="${escape(String(incident.incident_id))}" data-operation="authorize_compensation">Authorize supported compensation</button>`
            : `<button disabled title="The EffectSpec and bound policy do not support automatic compensation for this action.">Compensation unsupported</button>`}
          <button data-review="${escape(String(incident.incident_id))}" data-operation="acknowledge">Acknowledge</button>
        </div>
      </article>`;
      }).join("");

  return shell("Needs Attention", "/needs-attention", `
  <div class="page-head">
    <p class="eyebrow">Incident inbox</p>
    <h1>Needs Attention</h1>
    <p class="lede">Everywhere Nyst stopped rather than proceed unsafely. Only operations that are already safe under the runtime and EffectSpec semantics are offered — there is no force-continue.</p>
  </div>
  ${body}`, { ...context, attention: incidents.length });
}

function age(seconds: number): string {
  if (!Number.isFinite(seconds)) return "just now";
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function badge(state: string): string {
  const tone = state === "verified" || state === "compensated" ? "resolved"
    : state === "unprovable" || state === "not_applied" ? "blocked" : "uncertain";
  return `<span class="badge ${tone}">${escape(state)}</span>`;
}

/* ----------------------------------------------------------------- agents */

export function agentsPage(agents: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  const body = agents.length === 0
    ? `<div class="panel panel-pad"><p class="empty">No Agents are registered in this environment. Every consequential action should be able to answer who or what caused it.</p></div>`
    : `<div class="table-scroll"><table>
        <thead><tr><th scope="col">Agent</th><th scope="col">Owner</th><th scope="col">Framework</th><th scope="col">Status</th><th scope="col">Canary scope</th><th scope="col" class="numeric">Actions</th><th scope="col" class="numeric">Interventions</th><th scope="col">Last action</th></tr></thead>
        <tbody>${agents.map((agent) => `<tr>
          <td><strong>${escape(String(agent.name))}</strong><span class="sub mono">${escape(String(agent.slug))}</span></td>
          <td>${escape(String(agent.owner))}</td>
          <td>${escape(String(agent.framework))}</td>
          <td>${agent.status === "active" ? `<span class="badge resolved">active</span>` : `<span class="badge neutral">${escape(String(agent.status))}</span>`}</td>
          <td>${((agent.canary_effects as string[]) ?? []).length
            ? (agent.canary_effects as string[]).map((effect) => `<span class="mode canary">${escape(effect)}</span>`).join(" ")
            : `<span class="small">Environment default</span>`}</td>
          <td class="numeric">${escape(String(agent.action_count ?? 0))}</td>
          <td class="numeric">${escape(String(agent.intervention_count ?? 0))}</td>
          <td class="small">${agent.last_action_at ? escape(String(agent.last_action_at)) : "—"}</td>
        </tr>`).join("")}</tbody></table></div>`;

  return shell("Agents", "/agents", `
  <div class="page-head">
    <p class="eyebrow">Operational identities</p>
    <h1>Agents</h1>
    <p class="lede">The autonomous systems acting through Nyst. Every consequential action is bound immutably to the Agent that caused it, so "who did this?" always has an answer.</p>
  </div>
  ${body}`, context);
}

/* ---------------------------------------------------------------- actions */

export interface ActionFilterView { provider?: string; effect?: string; state?: string; decision?: string; since?: string }

/**
 * RUN A CONSEQUENTIAL ACTION FROM THE INTERFACE (v0.3.3).
 *
 * `POST /v1/actions` is how a customer's SOFTWARE talks to Nyst, and that is
 * the right primary interface — but it left no way for a person to try the
 * product at all. Evaluating Nyst meant writing a curl command with a session
 * cookie and a CSRF token, or creating an API key first, before seeing it do
 * anything even once.
 *
 * This is the thing that lets somebody watch Nyst work before they integrate
 * it. It is deliberately NOT a general console: it renders the fields THIS
 * EffectSpec needs and nothing else, because a free-form JSON box would just be
 * curl with extra steps.
 *
 * The environment mode is stated on the control itself. "Run" means something
 * completely different in Shadow than in Enforced, and a person about to press
 * it deserves to know which one they are in without going to look.
 */
function dispatchPanel(specs: readonly Record<string, unknown>[], mode: string): string {
  const github = specs.find((spec) =>
    String(spec.effect_name) === "github.repository_permission_change" && spec.enabled === true);
  if (!github) {
    return `<div class="panel panel-pad gap-below-l">
      <h3>Run an action</h3>
      <p class="small">No GitHub EffectSpec is enabled in this environment yet, so there is nothing to run.
        Enable one on the <a href="/integrations">Integrations</a> page.</p>
    </div>`;
  }
  const shadow = mode === "shadow";
  /**
   * SHADOW REFUSES DISPATCH ENTIRELY. It does not evaluate it.
   *
   * The first version of this panel said Nyst would "evaluate this action with
   * the real EffectSpec semantics and control nothing", and pressing the button
   * produced a 409: "The environment is in Shadow; Nyst evaluates but does not
   * control this action." The copy promised something the route refuses.
   *
   * The distinction is real and worth stating rather than papering over.
   * Shadow evaluates observations YOUR SOFTWARE reports about actions IT
   * performed — Nyst is not in the path, so there is nothing for it to run.
   * Asking Nyst to perform the action itself means asking it to CONTROL the
   * action, and that is what leaving Shadow means.
   *
   * So the button is not offered here. A control that exists only to be refused
   * teaches people to ignore refusals.
   */
  if (shadow) {
    return `<div class="panel panel-pad gap-below-l">
      <div class="split-top"><h3>Run an action</h3><span class="badge neutral">shadow</span></div>
      <p class="small">This environment is in <strong>Shadow</strong>, where Nyst is not in the path of your
        actions — it evaluates observations your software reports about actions it performed itself. There is
        no action here for Nyst to run.</p>
      <p class="small gap-m">Asking Nyst to perform the change <em>is</em> asking it to control the change,
        which is what leaving Shadow means. See <a href="/settings">control posture</a> for what stands
        between this environment and Canary or Enforced.</p>
      <p class="small gap-m">To watch the engine reason about a failure right now without touching anything,
        use the <a href="/failure-lab">Failure Lab</a> — same evaluator, synthetic observations.</p>
    </div>`;
  }
  return `<div class="panel panel-pad gap-below-l">
    <div class="split-top">
      <h3>Run an action</h3>
      <span class="badge blocked">${escape(mode)}</span>
    </div>
    <p class="small">This environment is <strong>${escape(mode.toUpperCase())}</strong>. Nyst will attempt this
      change against GitHub for real, refuse it if it is not safe, and then verify whether the outcome you
      asked for actually became true. <strong>Real access will be removed.</strong></p>
    <form class="connect-form" data-dispatch="github.repository_permission_change"
      method="post" action="/v1/actions">
      <label>Organization<input name="owner" placeholder="acme-test-org" autocomplete="off" spellcheck="false"></label>
      <label>Repository<input name="repository" placeholder="payments" autocomplete="off" spellcheck="false"></label>
      <label>GitHub username<input name="principal" placeholder="dana" autocomplete="off" spellcheck="false"></label>
      <label>Desired permission
        <select name="desired_permission">
          <option value="none">none — remove their access</option>
          <option value="pull">pull</option>
          <option value="push">push</option>
          <option value="maintain">maintain</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <button type="submit">Run against GitHub</button>
    </form>
    <p class="small">The repository must be PRIVATE and owned by an organization, and the person must be an
      org member — the semantics Nyst has verified apply to that topology only.</p>
  </div>`;
}

export function actionsPage(rows: readonly Record<string, unknown>[], title = "Actions", selected: ActionFilterView = {}, context: ShellContext = {}, specs: readonly Record<string, unknown>[] = []): string {
  const options = (name: string, label: string, values: readonly string[]): string =>
    `<label>${escape(label)}<select name="${name}"><option value="">Any</option>${values.map((value) =>
      `<option value="${escape(value)}"${(selected as Record<string, unknown>)[name] === value ? " selected" : ""}>${escape(value)}</option>`).join("")}</select></label>`;

  return shell(title, "/actions", `
  <div class="page-head">
    <p class="eyebrow">Consequential action ledger</p>
    <h1>${escape(title)}</h1>
    <p class="lede">Every logical action Nyst took responsibility for, with the truth it established and the decision it made.</p>
  </div>
  ${specs.length ? dispatchPanel(specs, String(context.mode ?? "unknown")) : ""}
  <form class="panel panel-pad gap-below-l" method="get" action="/actions" aria-label="Filter actions">
    <fieldset class="field-grid">
    <legend>Filter actions</legend>
    ${options("state", "Effect state", ["verified", "not_applied", "pending", "compensated", "satisfied_unattributed", "unprovable"])}
    ${options("decision", "Control decision", ["continue", "retry", "do_not_retry", "hold", "compensate", "escalate"])}
    ${options("provider", "Provider", ["github", "okta", "stripe", "fake"])}
    <label>Since<input type="date" name="since" value="${escape(String(selected.since ?? "").slice(0, 10))}"></label>
    <div class="field-end-row"><button class="primary">Filter</button><a class="button subtle" href="/actions">Reset</a></div>
    </fieldset>
  </form>
  ${actionTable(rows)}`, context);
}

function actionTable(rows: readonly Record<string, unknown>[]): string {
  if (!rows.length) return `<div class="panel panel-pad"><p class="empty">No actions match. Nyst shows only what it actually recorded.</p></div>`;
  return `<div class="table-scroll"><table>
    <thead><tr><th scope="col">Action</th><th scope="col">Agent</th><th scope="col">Effect</th><th scope="col">Effect state</th><th scope="col">Decision</th><th scope="col">Mode</th><th scope="col">Created</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td><a href="/actions/${escape(String(row.action_id))}">${escape(String(row.display_business_key ?? row.action_id))}</a><span class="sub mono">${escape(String(row.action_id).slice(0, 8))}</span></td>
      <td>${escape(String(row.agent_name ?? "unattributed"))}</td>
      <td>${escape(String(row.effect_name ?? ""))}</td>
      <td>${row.effect_state ? badge(String(row.effect_state)) : `<span class="badge neutral">unresolved</span>`}</td>
      <td>${escape(String(row.primary_directive ?? "—"))}</td>
      <td>${row.environment_mode ? `<span class="mode ${escape(String(row.environment_mode))}">${escape(String(row.environment_mode))}</span>` : "—"}</td>
      <td class="small">${escape(String(row.created_at ?? ""))}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

/* ---------------------------------------------------- action detail (hero) */

export function actionPage(action: Record<string, unknown>, evidence: readonly Record<string, unknown>[], resolutions: readonly unknown[], context: ShellContext = {}): string {
  const current = latestResolution(resolutions);
  const history = resolutionHistory(resolutions);
  const explanation = current ? currentExplanation(action, evidence, current) : null;
  const tone = !current ? "" : current.effect_state === "unprovable" || current.primary_directive === "escalate" ? " is-blocked"
    : current.effect_state === "pending" || current.primary_directive === "hold" ? " is-uncertain" : "";

  return shell("Action", "/actions", `
  <div class="page-head">
    <p class="eyebrow">${escape(String(action.effect_name ?? ""))}</p>
    <h1>${escape(String(action.display_business_key ?? action.action_id ?? ""))}</h1>
  </div>

  <div class="panel panel-pad">
    <dl class="facts">
      <div><dt>Agent</dt><dd>${escape(String(action.agent_name ?? "unattributed"))}</dd></div>
      <div><dt>Provider</dt><dd>${escape(String(action.provider ?? String(action.effect_name ?? "").split(".")[0] ?? ""))}</dd></div>
      <div><dt>EffectSpec</dt><dd class="mono">${escape(String(action.spec_version ?? ""))}</dd></div>
      <div><dt>Mode at creation</dt><dd>${action.environment_mode ? `<span class="mode ${escape(String(action.environment_mode))}">${escape(String(action.environment_mode))}</span>` : "—"}</dd></div>
      <div><dt>Effect state</dt><dd>${current ? badge(current.effect_state) : `<span class="badge neutral">unresolved</span>`}</dd></div>
      <div><dt>Control decision</dt><dd>${escape(current?.primary_directive ?? "—")}</dd></div>
      <div><dt>Created</dt><dd class="small">${escape(String(action.created_at ?? ""))}</dd></div>
    </dl>
  </div>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Derived from the current resolution and its cited active evidence</p><h2>Why did Nyst decide this?</h2></div></div>
    ${explanation && current ? `<div class="decision${tone}">
      <p class="verdict"><strong>${escape(current.primary_directive.replace(/_/g, " ").toUpperCase())}</strong> — ${escape(current.explanation)}</p>
      <ul class="because">
        ${explanation.facts.map((fact) => `<li>${escape(factSentence(fact))}</li>`).join("")}
        ${explanation.attribution_note ? `<li>${escape(explanation.attribution_note)}</li>` : ""}
      </ul>
      <dl class="therefore">
        <div><dt>Effect</dt><dd>${escape(current.effect_state)}</dd></div>
        <div><dt>Retry</dt><dd>${escape(explanation.therefore.retry)}</dd></div>
        <div><dt>Continuation</dt><dd>${escape(explanation.therefore.continuation)}</dd></div>
        <div><dt>Recovery</dt><dd>${escape(explanation.therefore.recovery)}</dd></div>
      </dl>
    </div>` : `<div class="panel panel-pad"><p class="empty">No resolution has been recorded for this action yet.</p></div>`}
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">What the caller asked for</p><h2>Intent</h2></div></div>
    <pre class="panel panel-pad mono pre-scroll">${escape(JSON.stringify(sanitizeForProduct(action.input ?? {}), null, 2))}</pre>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Append-only ledger</p><h2>Evidence timeline</h2></div></div>
    ${evidence.length ? `<ol class="timeline">${evidence.map((item) => `<li class="${item.strength === "authoritative" ? "is-key" : item.strength === "transport_only" ? "is-blocked" : ""}">
      <p class="when">${escape(String(item.observed_at ?? ""))} · seq ${escape(String(item.seq ?? ""))}</p>
      <p class="what">${escape(String(item.source ?? "unknown"))} · ${escape(String(item.kind ?? ""))} · ${escape(String(item.strength ?? ""))}</p>
      <p class="detail">${escape(evidenceSentence(item))}</p>
    </li>`).join("")}</ol>` : `<div class="panel panel-pad"><p class="empty">No evidence recorded.</p></div>`}
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Every derivation Nyst made</p><h2>Reconciliation history</h2></div></div>
    ${history.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">#</th><th scope="col">Effect state</th><th scope="col">Decision</th><th scope="col">Retry</th><th scope="col">Continuation</th><th scope="col">Reason</th><th scope="col">Resolved</th></tr></thead>
      <tbody>${history.map((item) => `<tr>
        <td class="numeric">${escape(String(item.resolution_sequence))}</td>
        <td>${badge(item.effect_state)}</td><td>${escape(item.primary_directive)}</td>
        <td>${escape(item.retry_disposition)}</td><td>${escape(item.continuation_disposition)}</td>
        <td class="mono small">${escape(item.reason_code)}</td>
        <td class="small">${escape(item.resolved_at)}</td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No resolutions recorded.</p></div>`}
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Proof</p><h2>Receipt and evidence bundle</h2></div></div>
    <div class="panel panel-pad">
      <p class="lede">A Proof Pack assembles the records that already exist — identity, policy, dispatch boundary, evidence, resolutions, interventions, recovery and the signed receipt. It creates no new truth.</p>
      <div class="button-row gap-l">
        <a class="button primary" href="/v1/actions/${escape(String(action.action_id))}/proof-pack?format=html">Open Proof Pack</a>
        <a class="button" href="/v1/actions/${escape(String(action.action_id))}/proof-pack">Download JSON</a>
        <a class="button" href="/receipts/${escape(String(action.action_id))}">Verify receipt</a>
      </div>
    </div>
  </section>

  <details class="section"><summary class="eyebrow clickable">Advanced · raw records</summary>
    <pre class="panel panel-pad mono pre-scroll gap-m">${escape(JSON.stringify(sanitizeForProduct({ action, evidence, resolutions }), null, 2))}</pre>
  </details>`, context);
}

function factSentence(fact: { source: string; fact: string; strength: string; attribution: string }): string {
  return `${fact.source} reported ${fact.fact} (${fact.strength} evidence, attribution ${fact.attribution}).`;
}
function evidenceSentence(item: Record<string, unknown>): string {
  return `${String(item.source ?? "unknown")} observed ${String(item.observed_disposition ?? "an outcome")}; attribution ${String(item.attribution ?? "unknown")}.`;
}

/* ------------------------------------------------------------- protection */

export function protectionPage(report: ProtectionReport, readiness: readonly GoLiveReadiness[], context: ShellContext = {}): string {
  const stage = (name: EnvironmentMode, description: string): string =>
    `<div class="stage ${report.mode === name ? "is-current" : stageDone(report.mode, name) ? "is-done" : ""}">
      <p class="name">${escape(name)}</p><p class="desc">${escape(description)}</p></div>`;

  return shell("Protection", "/protection", `
  <div class="page-head">
    <p class="eyebrow">Protection report · ${escape(report.range.label === "all" ? "all time" : `last ${report.range.label}`)}</p>
    <h1>What Nyst protected</h1>
    <p class="lede">${escape(report.environment.organization)} · ${escape(report.environment.project)} · ${escape(report.environment.environment)}</p>
  </div>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Rollout</p><h2>Shadow → Canary → Enforced</h2></div></div>
    <div class="rollout">
      ${stage("shadow", "Nyst evaluates. It does not control the action.")}
      ${stage("canary", "Nyst controls one deterministic Agent + EffectSpec scope.")}
      ${stage("enforced", "Every consequential action routes through Nyst.")}
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Real enforcement, and counterfactual detection, kept apart</p><h2>Impact</h2></div>
      <a href="/v1/protection-report.csv?range=${escape(report.range.label)}">Download CSV →</a></div>
    <div class="compare">
      <div>
        <h3>Prevented — Nyst controlled the action</h3>
        <ol>
          <li><strong>${escape(String(report.enforced.unsafe_retries_prevented))}</strong> unsafe retries prevented</li>
          <li><strong>${escape(String(report.enforced.unsafe_continuations_prevented))}</strong> unsafe continuations prevented</li>
          <li><strong>${escape(String(report.enforced.auto_resolved))}</strong> incidents resolved automatically</li>
        </ol>
      </div>
      <div>
        <h3>Detected — Shadow only, nothing was prevented</h3>
        <ol>
          <li><strong>${escape(String(report.shadow.unsafe_retries_detected))}</strong> retries would have been blocked</li>
          <li><strong>${escape(String(report.shadow.unsafe_continuations_detected))}</strong> continuations would have been held</li>
        </ol>
      </div>
    </div>
  </section>

  ${report.highest_risk_incident ? `<section class="section">
    <div class="section-head"><div><p class="eyebrow">Your highest-risk incident</p><h2>${escape(report.highest_risk_incident.effect_name)}</h2></div></div>
    <div class="decision is-uncertain">
      <p class="verdict">${escape(report.highest_risk_incident.effect_state)} · ${escape(report.highest_risk_incident.control_decision)}</p>
      <ul class="because"><li>${escape(report.highest_risk_incident.explanation)}</li></ul>
      <dl class="therefore">
        <div><dt>Agent</dt><dd>${escape(report.highest_risk_incident.agent_name ?? "unattributed")}</dd></div>
        <div><dt>When</dt><dd>${escape(report.highest_risk_incident.occurred_at)}</dd></div>
        ${report.highest_risk_incident.exposure ? `<div><dt>Authoritative amount</dt><dd>${escape(String(report.highest_risk_incident.exposure.amount_minor))} ${escape(report.highest_risk_incident.exposure.currency)} (minor units)</dd></div>` : ""}
      </dl>
    </div>
  </section>` : ""}

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Deterministic, from the facts listed below</p><h2>Recommended rollout: ${escape(report.recommendation.result)}</h2></div></div>
    <div class="panel panel-pad">
      <ul class="bullets-plain">${report.recommendation.rationale.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
      <p class="lede gap-m"><strong>Next step.</strong> ${escape(report.recommendation.next_step)}</p>
      <dl class="facts divided">
        <div><dt>Observations</dt><dd>${escape(String(report.recommendation.considered.observation_volume))}</dd></div>
        <div><dt>Ambiguous executions</dt><dd>${escape(String(report.recommendation.considered.ambiguous_executions))}</dd></div>
        <div><dt>Readiness</dt><dd>${report.recommendation.considered.readiness_ready ? "all required conditions met" : escape(report.recommendation.considered.readiness_blockers.join("; ") || "not ready")}</dd></div>
        <div><dt>Open incidents</dt><dd>${escape(String(report.recommendation.considered.unresolved_incidents))}</dd></div>
      </dl>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Per Agent + Environment + EffectSpec</p><h2>Go-live readiness</h2></div></div>
    ${readiness.length ? readiness.map((item) => `<div class="panel panel-pad gap-below-m">
      <header class="split-top">
        <div><h3>${escape(item.agent_name ?? "No Agent")} · ${escape(item.effect_name)}</h3>
        <p class="small">${escape(item.label_definition)}</p></div>
        <span class="mode ${escape(item.label === "Protected" ? "protected" : item.label === "Frozen" || item.label === "Blocked" ? "frozen" : item.execution_mode)}">${escape(item.label)}</span>
      </header>
      <ul class="checks gap-m">${item.checks.map((check) => `<li>
        <span class="state ${check.satisfied ? "pass" : check.blocking ? "fail" : "info"}">${check.satisfied ? "Ready" : check.blocking ? "Blocked" : "Advisory"}</span>
        <span class="body"><strong>${escape(check.label)}</strong><span>${escape(check.detail)}</span></span></li>`).join("")}</ul>
      <p class="lede gap-m"><strong>Next step.</strong> ${escape(item.next_step)}</p>
    </div>`).join("") : `<div class="panel panel-pad"><p class="empty">No Agent and EffectSpec pair is configured in this environment yet.</p></div>`}
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">How to read this report</p><h2>Honesty notes</h2></div></div>
    <div class="panel panel-pad"><ul class="bullets">
      ${report.honesty_notes.map((note) => `<li>${escape(note)}</li>`).join("")}
    </ul></div>
  </section>`, { ...context, mode: report.mode });
}

function stageDone(current: EnvironmentMode, stage: EnvironmentMode): boolean {
  const order: EnvironmentMode[] = ["shadow", "canary", "enforced"];
  return order.indexOf(stage) < order.indexOf(current);
}

/* -------------------------------------------------------------- policies */

export function policiesPage(history: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  return shell("Policies", "/policies", `
  <div class="page-head">
    <p class="eyebrow">Effective authority</p>
    <h1>Policies</h1>
    <p class="lede">Start from a template rather than an empty editor. A policy can make Nyst stricter; it can never make Nyst less safe than the core safety model.</p>
  </div>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Built on the existing policy engine</p><h2>Templates</h2></div></div>
    <div class="compare">${POLICY_TEMPLATES.map((template) => `<div>
      <h3>${escape(template.name)}</h3>
      <p class="lede aside-note">${escape(template.summary)}</p>
      <p class="eyebrow gap-m">Guarantees</p>
      <ol>${template.guarantees.map((line) => `<li>${escape(line)}</li>`).join("")}</ol>
      <p class="eyebrow gap-s">Boundaries</p>
      <ol>${template.boundaries.map((line) => `<li>${escape(line)}</li>`).join("")}</ol>
      <div class="button-row gap-l"><button class="primary" data-template="${escape(template.template_id)}">Apply ${escape(template.name)}</button></div>
    </div>`).join("")}</div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Non-bypassable floor</p><h2>The Nyst safety floor</h2></div></div>
    <div class="panel panel-pad">
      <p class="lede"><strong>Customer policy can make Nyst stricter. It cannot make Nyst less safe than the core safety model.</strong></p>
      <ul class="bullets gap-m">
        ${NYST_SAFETY_FLOOR.map((rule) => `<li>${escape(rule)}</li>`).join("")}
      </ul>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Immutable versions</p><h2>Policy history</h2></div></div>
    ${history.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">Version</th><th scope="col">Effect</th><th scope="col">Template</th><th scope="col">Execution</th><th scope="col">Retry</th><th scope="col">Auto continuation</th><th scope="col">Auto compensation</th><th scope="col">Deadline</th><th scope="col">Created</th></tr></thead>
      <tbody>${history.map((row) => `<tr>
        <td class="numeric">${escape(String(row.version))}</td>
        <td>${escape(String(row.effect_name ?? "all effects"))}</td>
        <td>${escape(String(row.template_id ?? "custom"))}</td>
        <td>${escape(String(row.execution_mode))}</td>
        <td>${escape(String(row.retry_mode))}</td>
        <td>${row.auto_continuation ? "yes" : "no"}</td>
        <td>${row.auto_compensation ? "yes" : "no"}</td>
        <td>${escape(String(row.reconcile_timeout_seconds))}s</td>
        <td class="small">${escape(String(row.created_at ?? ""))}</td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No policy versions yet.</p></div>`}
  </section>`, context);
}

/* -------------------------------------------------------- effect registry */

export function effectRegistryPage(specs: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  return shell("Effect Registry", "/effect-registry", `
  <div class="page-head">
    <p class="eyebrow">Provider semantics</p>
    <h1>Effect Registry</h1>
    <p class="lede">Nyst understands what each external effect MEANS — identity, observation, attribution, retry and compensation semantics — not merely what HTTP status code came back.</p>
  </div>
  ${specs.length ? specs.map((spec) => `<div class="panel panel-pad gap-below-m">
    <header class="split-top">
      <div><h3>${escape(String(spec.effect_name))}</h3><p class="small mono">${escape(String(spec.spec_version))}</p></div>
      <span class="badge ${spec.ready ? "resolved" : spec.enabled ? "uncertain" : "neutral"}">${escape(String(spec.status ?? (spec.ready ? "ready" : "available")))}</span>
    </header>
    <dl class="facts gap-l">
      <div><dt>Provider</dt><dd>${escape(String(spec.provider))}</dd></div>
      <div><dt>Enabled here</dt><dd>${spec.enabled ? "yes" : "no"}</dd></div>
      <div><dt>Supported topology</dt><dd>${escape(String(spec.supported_topology ?? ""))}</dd></div>
      <div><dt>Credential reference</dt><dd>${spec.credential_ref ? `<span class="mono">${escape(String(spec.credential_ref))}</span>` : "not required"}</dd></div>
      <div><dt>Readiness</dt><dd>${escape(String(spec.reason ?? ""))}</dd></div>
    </dl>
  </div>`).join("") : `<div class="panel panel-pad"><p class="empty">No EffectSpecs are registered.</p></div>`}

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">One canonical order, everywhere</p><h2>Offboarding: ${escape(CANONICAL_OFFBOARDING_SUMMARY)}</h2></div></div>
    <div class="flow">${CANONICAL_OFFBOARDING_STAGES.map((stage) => `<div class="node">
      <p class="step">Stage ${escape(String(stage.index))}</p><strong>${escape(stage.title)}</strong>
      <small>${escape(stage.rationale)}</small></div>`).join("")}</div>
  </section>`, context);
}

/* ------------------------------------------------------------ failure lab */

export function failureLabPage(runs: readonly Record<string, unknown>[], control: { mode: string; is_demo: boolean }, context: ShellContext = {}): string {
  const allowed = control.is_demo || control.mode === "shadow";
  return shell("Failure Lab", "/failure-lab", `
  <div class="page-head">
    <p class="eyebrow">SIMULATED — never production</p>
    <h1>Failure Lab</h1>
    <p class="lede">Break execution on purpose and watch the real Nyst runtime respond. Every run uses the actual engine — real evidence, real EffectState derivation, real ControlDecision, a real signed receipt — against a deterministic fake provider. No production credential is reachable from here.</p>
  </div>

  <div class="flow gap-below-xl">
    <div class="node"><p class="step">01</p><strong>Agent</strong><small>declares durable intent</small></div>
    <div class="node is-nyst"><p class="step">02</p><strong>Nyst</strong><small>controls the ambiguity</small></div>
    <div class="node is-fault"><p class="step">03</p><strong>Provider</strong><small>where the fault is injected</small></div>
  </div>

  <div class="panel panel-pad">
    ${allowed ? `<form class="field-grid-wide" id="lab-form">
      <label>Scenario<select name="scenario">
        <option value="response_lost">Response lost after the effect</option>
        <option value="timeout_before_send">Timeout before the request was sent</option>
        <option value="delayed_observation">Delayed provider consistency</option>
        <option value="reconcile_rate_limit">Observation rate-limited</option>
        <option value="duplicate_caller">Duplicate logical request</option>
        <option value="process_crash">Worker crash and restart</option>
      </select></label>
      <label>Seed<input name="seed" type="number" value="42" min="0" max="999999"></label>
      <div class="field-end"><button class="primary">Run simulation</button></div>
    </form>` : `<p class="empty">The Failure Lab is isolated to Demo and Shadow environments so a simulation can never be mistaken for production protection. This environment is <strong>${escape(control.mode)}</strong>.</p>`}
  </div>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Engine-derived, never preprogrammed</p><h2>Recent simulations</h2></div></div>
    ${runs.length ? runs.map((run) => {
      const result = (run.result ?? {}) as Record<string, unknown>;
      return `<div class="panel panel-pad gap-below-m">
      <header class="split">
        <div><h3>${escape(String(run.scenario))}</h3><p class="small">seed ${escape(String(run.seed))} · ${escape(String(run.created_at ?? ""))}</p></div>
        <div class="button-row"><span class="badge neutral">SIMULATED</span>${badge(String(result.final_effect_state ?? "unknown"))}</div>
      </header>
      <div class="compare gap-l">
        <div class="naive"><h3>What naive software might do</h3><ol><li>${escape(String(result.naive_behavior ?? ""))}</li></ol></div>
        <div><h3>What Nyst did</h3><ol><li>${escape(String(result.nyst_behavior ?? ""))}</li></ol></div>
      </div>
      ${Array.isArray(result.timeline) ? `<ol class="timeline gap-xl">${(result.timeline as Array<{ stage: string; detail: string }>).map((entry) => `<li>
        <p class="what">${escape(entry.stage)}</p><p class="detail">${escape(entry.detail)}</p></li>`).join("")}</ol>` : ""}
      <dl class="facts gap-l">
        <div><dt>Provider mutations</dt><dd>${escape(String(result.provider_mutations ?? 0))}</dd></div>
        <div><dt>Signed receipt</dt><dd>${result.signature_valid ? "verified" : "not verified"}</dd></div>
        <div><dt>Credentials used</dt><dd>none</dd></div>
      </dl>
    </div>`;
    }).join("") : `<div class="panel panel-pad"><p class="empty">No simulations have been run in this environment.</p></div>`}
  </section>`, context);
}

/* ----------------------------------------------------------- integrations */

export function integrationsPage(readiness: readonly Record<string, unknown>[], specs: readonly Record<string, unknown>[], context: ShellContext = {}, canStoreCredentials = true): string {
  return shell("Integrations", "/integrations", `
  <div class="page-head">
    <p class="eyebrow">Connection readiness</p>
    <h1>Integrations</h1>
    <p class="lede">Readiness is seven separate conditions, not one flag. Every screen in Nyst reads this same evaluation, so no page can call a workload Ready while this one says Not ready. "Test" runs a bounded read-only preflight; it never mutates provider state, and Nyst never displays a credential.</p>
  </div>
  ${readiness.map((item) => `<div class="panel panel-pad gap-below-m">
    <header class="split-top">
      <div><h3>${escape(String(item.provider))}</h3><p class="small">${escape(String(item.reason ?? ""))}</p></div>
      <span class="badge ${item.ready ? "resolved" : "uncertain"}">${item.ready ? "Ready" : "Not ready"}</span>
    </header>
    <ul class="checks gap-m">
      ${dimension("Available", item.available === true, "The EffectSpec is registered in Nyst.")}
      ${dimension("Enabled", item.enabled === true, `Enabled EffectSpecs: ${((item.enabled_effect_specs as string[]) ?? []).join(", ") || "none"}`)}
      ${dimension("Configured", item.configured === true, "A credential reference is stored. The value itself is never stored.")}
      ${dimension("Credential available", item.credential_available === true, "The SecretProvider resolved the reference without exposing it.")}
      ${dimension("Preflight verified", item.preflight_verified === true, item.last_preflight_at ? `Last read-only preflight ${String(item.last_preflight_at)}${item.preflight_stale ? " (outside the 12-hour trust window)" : ""}` : "No successful read-only preflight recorded.")}
      ${dimension("Capabilities sufficient", item.capabilities_sufficient === true, ((item.missing_capabilities as string[]) ?? []).length ? `Not granted: ${((item.missing_capabilities as string[]) ?? []).join(", ")}` : "Every capability the enabled EffectSpecs require was observed as granted.")}
    </ul>
    ${capabilityBlock(item)}
    ${connectForm(item, canStoreCredentials)}
    <div class="button-row gap-l">
      <button data-preflight="${escape(String(item.provider))}">Run read-only preflight</button>
    </div>
  </div>`).join("")}

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Per environment</p><h2>EffectSpec enablement</h2></div></div>
    <p class="lede">An EffectSpec is one kind of consequential action Nyst understands. Nothing is enabled by
      default — an environment controls exactly what you turn on here, and readiness stays Not ready until at
      least one is enabled for the provider.</p>
    ${specs.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">EffectSpec</th><th scope="col">Version</th><th scope="col">Provider</th><th scope="col">Enabled</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
      <tbody>${specs.map((spec) => `<tr>
        <td>${escape(String(spec.effect_name))}</td><td class="mono small">${escape(String(spec.spec_version))}</td>
        <td>${escape(String(spec.provider))}</td><td>${spec.enabled ? "yes" : "no"}</td>
        <td><span class="badge ${spec.ready ? "resolved" : "neutral"}">${escape(String(spec.status ?? ""))}</span></td>
        <!-- THE CONTROL THAT WAS MISSING (v0.3.3). PUT /v1/effect-specs/:effect
             existed from the start with nothing in the UI calling it, so the
             only way to enable an EffectSpec was curl. Readiness said "Enabled:
             NO / Enabled EffectSpecs: none" and offered no way to change it. -->
        <td><button data-effect-spec="${escape(String(spec.effect_name))}" data-enabled="${spec.enabled ? "true" : "false"}">${spec.enabled ? "Disable" : "Enable"}</button></td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No EffectSpecs registered.</p></div>`}
  </section>`, context);
}

/**
 * LEAVING SHADOW (v0.3.3).
 *
 * Shadow is where every workspace starts and it was where every workspace
 * stayed, because the only thing the product ever said about Enforced was a
 * 402 from an endpoint with no visible control. An operator had to discover the
 * preconditions one refusal at a time.
 *
 * This shows all three modes and everything standing in the way of each, with
 * the three refusal FAMILIES kept visually distinct:
 *
 *   commercial   — you may not ASK for this yet. Remedy: talk to us.
 *   readiness    — this would not be SAFE yet. Remedy: fix the condition.
 *   operational  — something is deliberately stopped right now.
 *
 * Collapsing those into one list of red text teaches an operator to read a
 * safety refusal as a billing inconvenience, which is the single worst habit
 * this product could instil.
 *
 * The button is offered ONLY when the transition is currently allowed. That is
 * not the enforcement — the route re-decides independently, because a view that
 * pre-authorises anything is a second evaluator and this codebase does not have
 * those. It is so the control does not lie about what it will do.
 */
function promotionPanel(promotion: Record<string, unknown> | null): string {
  if (!promotion) return "";
  const targets = (promotion.targets ?? []) as Array<{
    mode: string; current: boolean; allowed: boolean; description: string;
    blockers: Array<{ kind: string; reason: string; remedy: string | null }>;
  }>;
  if (!targets.length) return "";
  const providers = (promotion.providers ?? []) as Array<{
    provider: string; connected: boolean; verified: boolean; reason: string;
  }>;

  return `<section class="section">
    <div class="section-head"><div><p class="eyebrow">Rollout</p><h2>Control posture</h2></div>
      <a href="/integrations">Integrations →</a></div>
    <p class="lede">Nyst starts in Shadow, where it evaluates everything and prevents nothing. Moving past
      Shadow means Nyst begins refusing your software's actions, so every condition below has to hold first.</p>

    <div class="promotion gap-m">
      ${targets.map((target) => `<div class="target${target.current ? " is-current" : ""}">
        <div class="split-top">
          <h3>${escape(target.mode)}</h3>
          <span class="badge ${target.current ? "resolved" : target.allowed ? "neutral" : "uncertain"}">${
            target.current ? "Current" : target.allowed ? "Available" : "Blocked"}</span>
        </div>
        <p class="small">${escape(target.description)}</p>
        ${target.blockers.map((blocker) => `<div class="blocker ${escape(blocker.kind)}">
          ${escape(blocker.reason)}
          ${blocker.remedy ? `<span class="remedy">${escape(blocker.remedy)}</span>` : ""}
        </div>`).join("")}
        ${target.current || !target.allowed ? "" : `<div class="button-row">
          <button data-set-mode="${escape(target.mode)}">Move to ${escape(target.mode)}</button>
        </div>`}
      </div>`).join("")}
    </div>

    ${providers.length ? `<div class="panel panel-pad gap-m">
      <p class="small"><strong>Provider verification.</strong> Connected means a credential is stored.
        Verified means a read-only preflight succeeded inside the trust window — only that second one says
        anything about whether the connection works.</p>
      <ul class="checks gap-m">
        ${providers.map((provider) => `<li>
          <span class="state ${provider.verified ? "pass" : provider.connected ? "unknown" : "fail"}">${
            provider.verified ? "Verified" : provider.connected ? "Stored" : "None"}</span>
          <span class="body"><strong>${escape(provider.provider)}</strong><span>${escape(provider.reason)}</span></span>
        </li>`).join("")}
      </ul>
    </div>` : ""}
  </section>`;
}

/**
 * CONNECT A PROVIDER (v0.3.3).
 *
 * Until this existed the only way to connect anything was to set an environment
 * variable on the host, so the only person who could connect a provider was the
 * operator. Nyst was multi-tenant in its data model and single-tenant in its
 * onboarding.
 *
 * WHAT THE COPY HAS TO GET RIGHT, because this is the one form in the product
 * that carries a real secret:
 *
 *  - It asks for READ-ONLY scopes. Nyst can run its whole Shadow proposition on
 *    read access, and asking for write access before a customer has any reason
 *    to trust the product is both bad security and bad selling.
 *  - It says storing is not verifying. A green tick after a paste, with no
 *    read-only preflight behind it, would be the same over-claim the readiness
 *    conjunction exists to prevent.
 *  - It never renders the credential, and it names the reference — a reference
 *    is a NAME, and the operator needs to see which one is configured.
 */
function connectForm(item: Record<string, unknown>, canStoreCredentials = true): string {
  const provider = String(item.provider);
  const guidance: Readonly<Record<string, { label: string; hint: string; scopes: string }>> = {
    github: {
      label: "GitHub token",
      hint: "A fine-grained personal access token, or a classic token.",
      scopes: "Read-only is enough for Shadow: repo metadata, members and collaborators.",
    },
    okta: {
      label: "Okta API token",
      hint: "Created under Security → API → Tokens in your Okta admin console.",
      scopes: "Read-only is enough for Shadow: users and groups.",
    },
    stripe: {
      label: "Stripe key",
      hint: "Use a RESTRICTED key, not your secret key.",
      scopes: "Read-only is enough for Shadow: charges, refunds and customers.",
    },
  };
  const help = guidance[provider];
  if (!help) return "";

  /**
   * NO KEY, NO BOX.
   *
   * Rendering the form anyway is worse than rendering nothing: the customer
   * types a REAL credential into a field whose only possible outcome is a
   * failure, and the secret has already been in a DOM node by the time they
   * find out. Say what is missing instead.
   */
  if (!canStoreCredentials) {
    return `<div class="panel panel-pad gap-l note-strong">
      <p><strong>This deployment cannot accept customer-supplied credentials.</strong>
      No credential encryption key is configured, and Nyst will not store a credential it cannot encrypt.</p>
      <p class="small gap-m">The operator sets <span class="mono">NYST_CREDENTIAL_KEY</span> to 32 random bytes,
      base64-encoded (<span class="mono">openssl rand -base64 32</span>) and restarts. Until then this provider
      can only be configured with an operator-managed reference such as
      <span class="mono">env:NYST_${escape(provider.toUpperCase())}_TOKEN</span>.</p>
    </div>`;
  }
  const fingerprint = typeof item.credential_fingerprint === "string" ? item.credential_fingerprint : null;
  const reference = typeof item.credential_ref === "string" ? item.credential_ref : null;

  return `<div class="gap-l">
    ${fingerprint ? `<p class="small">A credential supplied through this page is loaded (<span class="mono">${escape(fingerprint)}</span>). Storing a new one replaces it and revokes the old one immediately.</p>` : ""}
    ${reference && !fingerprint ? `<p class="small">Configured from <span class="mono">${escape(reference)}</span>, a reference this deployment resolves. Pasting a credential below would replace it.</p>` : ""}
    <form class="connect-form" data-connect-provider="${escape(provider)}" method="post" action="/v1/integrations/${escape(provider)}/credential">
      <label>${escape(help.label)}
        <input name="credential" type="password" autocomplete="off" spellcheck="false"
          placeholder="Paste the credential" aria-describedby="connect-hint-${escape(provider)}">
        <span class="hint" id="connect-hint-${escape(provider)}">${escape(help.hint)} ${escape(help.scopes)}</span>
      </label>
      <button type="submit">${fingerprint ? "Replace credential" : "Connect"}</button>
    </form>
    <p class="small">Nyst encrypts this before storing it and never displays it again — not on this page, not in a log, not in an export. Storing a credential proves nothing about whether it works; the read-only preflight decides that.</p>
  </div>`;
}

/**
 * The CapabilityManifest, rendered as six states rather than a green dot.
 *
 * An attested capability is always shown as a CLAIM. Nyst cannot verify a
 * write capability read-only — proving it would require a mutation — so the
 * page says which capabilities were observed, which were authorized by the
 * provider's own metadata, and which a person vouched for.
 */
function capabilityBlock(item: Record<string, unknown>): string {
  const manifest = item.capability_manifest as {
    capabilities?: Array<{ capability: string; kind: string; state: string; why: string; detail: string; attested_not_observed: boolean }>;
    granted_scopes?: string[]; limitation?: string | null; account_identity?: string | null;
  } | null | undefined;
  const capabilities = manifest?.capabilities ?? [];
  if (!capabilities.length) return "";
  const provider = String(item.provider ?? "");
  const rows = capabilities.map((capability) => `<tr>
    <td class="mono small">${escape(capability.capability)}</td>
    <td>${escape(capability.kind)}</td>
    <td><span class="badge ${capability.state === "verified" || capability.state === "authorized" ? "resolved" : capability.state === "insufficient_permission" || capability.state === "unavailable" ? "blocked" : "uncertain"}">${escape(capability.state.replace(/_/g, " "))}</span></td>
    <td class="small">${escape(capability.detail)}${capability.attested_not_observed ? ` <strong>Claimed, not observed.</strong>` : ""}</td>
    <!--
      THE ATTESTATION CONTROL (v0.3.3).

      POST /v1/integrations/:provider/capabilities/attest existed with NOTHING
      in the interface calling it. That mattered most for a WRITE capability,
      which can never reach "verified" — proving it requires performing the
      mutation invariant I20 forbids — and which reaches "authorized" only when
      the provider publishes scope metadata. A fine-grained GitHub token
      publishes none, so "github:collaborator:write" was permanently stuck at
      "available" with no route forward and readiness permanently unsatisfiable.

      A person vouching is the remaining honest route, and the result is
      labelled a CLAIM everywhere it appears. Offered only where an observation
      could not settle it.
    -->
    <td>${capability.state === "verified" || capability.state === "authorized" ? ""
      : `<button data-attest="${escape(provider)}" data-capability="${escape(capability.capability)}">Attest</button>`}</td>
  </tr>`).join("");
  return `<details class="gap-l"><summary>Capabilities (${capabilities.length})</summary>
    <p class="small">Nyst compares what each enabled EffectSpec requires against what a read-only preflight could observe. A write capability cannot be proved without performing a write, so it is only ever authorized by the provider's own metadata or claimed by a person.</p>
    <div class="table-scroll"><table>
      <thead><tr><th scope="col">Capability</th><th scope="col">Kind</th><th scope="col">State</th><th scope="col">Why it is in that state</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${manifest?.limitation ? `<p class="note">${escape(String(manifest.limitation))}</p>` : ""}
  </details>`;
}

function dimension(label: string, satisfied: boolean, detail: string): string {
  return `<li><span class="state ${satisfied ? "pass" : "fail"}">${satisfied ? "Yes" : "No"}</span>
    <span class="body"><strong>${escape(label)}</strong><span>${escape(detail)}</span></span></li>`;
}

/* ---------------------------------------------------------------- others */

export function reviewsPage(reviews: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  return shell("Human Review", "/needs-attention", `
  <div class="page-head"><p class="eyebrow">Bounded review</p><h1>Human Review</h1>
  <p class="lede">A reviewer may only choose operations that are already safe under the runtime and EffectSpec semantics. There is no force-continue override anywhere in Nyst.</p></div>
  ${reviews.length ? `<div class="table-scroll"><table>
    <thead><tr><th scope="col">Action</th><th scope="col">Effect</th><th scope="col">Status</th><th scope="col">Reason</th><th scope="col">Opened</th></tr></thead>
    <tbody>${reviews.map((review) => `<tr>
      <td><a href="/actions/${escape(String(review.action_id))}">${escape(String(review.display_business_key ?? review.action_id))}</a></td>
      <td>${escape(String(review.effect_name ?? ""))}</td>
      <td><span class="badge ${review.status === "open" ? "uncertain" : "neutral"}">${escape(String(review.status))}</span></td>
      <td>${escape(String(review.reason ?? ""))}</td>
      <td class="small">${escape(String(review.opened_at ?? ""))}</td>
    </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No human reviews are open.</p></div>`}`, context);
}

export function settingsPage(info: Record<string, unknown> | null, control: Record<string, unknown>, webhooks: readonly Record<string, unknown>[], keys: readonly Record<string, unknown>[], freezes: { active: Record<string, unknown>[] } = { active: [] }, context: ShellContext = {}, promotion: Record<string, unknown> | null = null): string {
  return shell("Settings", "/settings", `
  <div class="page-head"><p class="eyebrow">Configuration</p><h1>Settings</h1></div>
  ${promotionPanel(promotion)}

  <section class="section">
    <div class="section-head"><div><h2>Workspace</h2></div></div>
    <div class="panel panel-pad"><dl class="facts">
      <div><dt>Organization</dt><dd>${escape(String(info?.organization ?? ""))}</dd></div>
      <!--
        THE SLUG, shown (v0.3.3).

        projectInfo has returned organization_slug all along and nothing
        rendered it. It is the identifier somebody types to sign in, and the one
        an operator needs to name this organization in configuration — and a
        customer who signed up with Google never typed it, so there was no way
        to find out what it was from inside the product.
      -->
      <div><dt>Organization slug</dt><dd class="mono">${escape(String(info?.organization_slug ?? ""))}</dd></div>
      <div><dt>Project</dt><dd>${escape(String(info?.project ?? ""))}</dd></div>
      <div><dt>Environment</dt><dd>${escape(String(info?.environment ?? ""))}</dd></div>
      <div><dt>Rollout mode</dt><dd>${control.mode ? `<span class="mode ${escape(String(control.mode))}">${escape(String(control.mode))}</span>` : "—"}</dd></div>
    </dl></div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Stops new consequence; keeps read-only work running</p><h2>Emergency Freeze</h2></div></div>
    <div class="panel panel-pad">
      ${freezes.active.length
        ? `<p class="lede">This environment is frozen. Releasing requires explicit confirmation.</p>
           <div class="button-row gap-m">${freezes.active.map((freeze) => `<button class="danger" data-unfreeze="${escape(String(freeze.freeze_id))}">Release freeze</button>`).join("")}</div>`
        : `<p class="lede">Activating a freeze stops every new consequential provider mutation in this environment immediately. Observation, reconciliation and receipt verification continue.</p>
           <div class="button-row gap-m"><button class="danger" data-freeze="environment">Activate Emergency Freeze</button></div>`}
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><h2>API keys</h2></div></div>
    <p class="lede">How your software calls Nyst. A key carries only the scopes you grant it, and may be bound
      to one Agent so that a leaked key cannot act as a different one.</p>
    ${keys.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">Name</th><th scope="col">Prefix</th><th scope="col">Bound Agent</th><th scope="col">Scopes</th><th scope="col">Last used</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Action</span></th></tr></thead>
      <tbody>${keys.map((key) => `<tr>
        <td>${escape(String(key.name))}</td><td class="mono small">${escape(String(key.prefix))}</td>
        <td>${escape(String(key.agent_name ?? "any Agent"))}</td>
        <td class="small">${escape(((key.scopes as string[]) ?? []).join(", "))}</td>
        <td class="small">${escape(String(key.last_used_at ?? "never"))}</td>
        <td>${key.revoked_at ? `<span class="badge blocked">revoked</span>` : `<span class="badge resolved">active</span>`}</td>
        <td>${key.revoked_at ? "" : `<button data-revoke-key="${escape(String(key.api_key_id ?? ""))}">Revoke</button>`}</td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No API keys.</p></div>`}

    <!--
      THE CONTROL THAT DID NOT EXIST (v0.3.3).

      GET, POST and DELETE /v1/api-keys all existed from the beginning with
      NOTHING in the interface calling them, so this page could list keys and
      offered no way to make one. The only route to a key was curl with a
      session cookie and a CSRF token — which is precisely the thing an API key
      exists to avoid, so the feature was unreachable by the people who needed
      it most.

      Eighth instance of this shape in one release.
    -->
    <div class="panel panel-pad gap-m">
      <h3>Create a key</h3>
      <p class="small">The secret is shown ONCE, on creation, and never again — Nyst stores only a hash.
        Copy it before you close the message.</p>
      <div class="button-row gap-m">
        <button data-create-key="actions:read,actions:write,receipts:read,integrations:read">Create a key for this environment</button>
      </div>
      <p class="small">Scoped to <span class="mono">actions:read actions:write receipts:read integrations:read</span>,
        and to THIS project and environment. It cannot reach another.</p>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Signed, at-least-once</p><h2>Decision webhooks</h2></div></div>
    ${webhooks.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">Target</th><th scope="col">Enabled</th><th scope="col">Last event</th><th scope="col">Last status</th><th scope="col" class="numeric">Attempts</th></tr></thead>
      <tbody>${webhooks.map((hook) => `<tr>
        <td class="mono small">${escape(String(hook.target_url))}</td>
        <td>${hook.enabled ? "yes" : "no"}</td>
        <td class="small">${escape(String(hook.last_event_at ?? "—"))}</td>
        <td>${escape(String(hook.last_response_status ?? hook.last_error_code ?? "—"))}</td>
        <td class="numeric">${escape(String(hook.delivery_attempt_count ?? 0))}</td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No webhook endpoint configured.</p></div>`}
  </section>`, context);
}

export function onboardingPage(progress: Record<string, unknown>, specs: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  const steps = [
    ["Welcome", "Make your first consequential action safer."],
    ["Project and environment", "Choose where this workload runs."],
    ["Create an Agent", "Give the autonomous system an identity Nyst can bind actions to."],
    ["Start in Shadow", "See your risk before Nyst controls anything."],
    ["Connect a provider or use the Failure Lab", "A real provider, or a deterministic simulation."],
    ["Enable the EffectSpec", "The exact version, in this environment."],
    ["Select a policy template", "Access Revocation, Financial Action, or High-Risk Production."],
    ["Create an API key", "Optionally bound to one Agent."],
    ["Send your first envelope", "Install @nyst-ai/sdk, or call the REST API directly."],
    ["Watch the real lifecycle", "Intent, execution, observation, reconciliation, decision, receipt."],
    ["Read the Action Detail", "See exactly why Nyst decided what it decided."],
    ["Read your first risk finding", "The Protection Report proves it."],
    ["Run go-live readiness", "Honest conditions, per workload."],
    ["Move one workload to Canary", "Deterministic scope: one Agent, one EffectSpec."],
  ] as const;
  const completed = (progress.completed as boolean[]) ?? [];
  const mode = String(progress.mode ?? "shadow");

  return shell("Get started", "/", `
  <div class="page-head"><p class="eyebrow">First run</p><h1>See your first Nyst risk finding before lunch</h1>
  <p class="lede">${escape(mode === "enforced" ? "This workload is protected by Nyst." : "Nyst is evaluating this workload. It is not controlling it yet.")}</p></div>
  <ol class="timeline">${steps.map((step, index) => `<li class="${completed[index] ? "is-key" : ""}">
    <p class="what">${escape(step[0])}</p><p class="detail">${escape(step[1])}</p>
    ${completed[index] ? `<p class="small ok-text">Done</p>` : ""}
  </li>`).join("")}</ol>
  <section class="section"><div class="section-head"><div><h2>EffectSpecs available here</h2></div></div>
    ${specs.length ? `<div class="table-scroll"><table><thead><tr><th scope="col">EffectSpec</th><th scope="col">Version</th><th scope="col">Enabled</th></tr></thead>
    <tbody>${specs.map((spec) => `<tr><td>${escape(String(spec.effect_name))}</td><td class="mono small">${escape(String(spec.spec_version))}</td><td>${spec.enabled ? "yes" : "no"}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="panel panel-pad"><p class="empty">No EffectSpecs registered.</p></div>`}</section>`, context);
}

export function receiptsPage(rows: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  return actionsPage(rows, "Receipts", {}, context);
}

export function receiptPage(action: Record<string, unknown>, receipt: Record<string, unknown>, valid: boolean | null, context: ShellContext = {}): string {
  return shell("Receipt", "/actions", `
  <div class="page-head"><p class="eyebrow">Signed receipt</p><h1>${escape(String(action.display_business_key ?? action.action_id ?? ""))}</h1></div>
  <div class="decision${valid === false ? " is-blocked" : ""}">
    <p class="eyebrow">Signature verification</p>
    <p class="verdict">${valid === null ? "NOT VERIFIED" : valid ? "VALID" : "INVALID"}</p>
    <ul class="because">
      <li>An Ed25519 software signature over the canonical receipt. It provides tamper evidence.</li>
      <li>It is not hardware-backed, not HSM-attested, and not a trusted timestamp. Nyst does not claim otherwise.</li>
    </ul>
  </div>
  <div class="button-row gap-xl">
    <a class="button" href="/exports/${escape(String(action.action_id))}">Export JSON</a>
    <a class="button" href="/v1/actions/${escape(String(action.action_id))}/proof-pack?format=html">Open Proof Pack</a>
  </div>
  <pre class="panel panel-pad mono pre-scroll gap-below-xl-top">${escape(JSON.stringify(sanitizeForProduct(receipt), null, 2))}</pre>`, context);
}

export function offboardingPage(runs: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  return shell("Offboarding", "/actions", `
  <div class="page-head"><p class="eyebrow">${escape(CANONICAL_OFFBOARDING_SUMMARY)}</p><h1>Offboarding runs</h1></div>
  <div class="flow gap-below-xl">${CANONICAL_OFFBOARDING_STAGES.map((stage) => `<div class="node">
    <p class="step">Stage ${escape(String(stage.index))}</p><strong>${escape(stage.title)}</strong><small>${escape(stage.continuation_requirement)}</small></div>`).join("")}</div>
  ${runs.length ? `<div class="table-scroll"><table>
    <thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Blocking reason</th><th scope="col">Created</th></tr></thead>
    <tbody>${runs.map((run) => `<tr>
      <td class="mono small">${escape(String(run.business_key ?? run.run_id))}</td>
      <td><span class="badge ${String(run.status).startsWith("blocked") ? "blocked" : run.status === "complete" ? "resolved" : "uncertain"}">${escape(String(run.status))}</span></td>
      <td>${escape(String(run.blocking_reason ?? "—"))}</td>
      <td class="small">${escape(String(run.created_at ?? ""))}</td>
    </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No offboarding runs. Nothing is fabricated for this environment — Nyst shows only runs it actually recorded.</p></div>`}`, context);
}

/**
 * Render an arbitrary body inside the product shell.
 *
 * Exported so surfaces that live in their own modules (the Outcome and
 * Authority views) get the same navigation, freeze banner and context switcher
 * as everything else, without dashboard.ts having to know about them.
 */
export function shellPage(title: string, current: string, body: string, context: ShellContext = {}): string {
  return shell(title, current, body, context);
}

export function genericPage(title: string, message: string): string {
  return shell(title, "/", `<div class="page-head"><h1>${escape(title)}</h1><p class="lede">${escape(message)}</p></div>`);
}
