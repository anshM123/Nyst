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
  ["/agents", "Agents"],
  ["/actions", "Actions"],
  ["/protection", "Protection"],
] as const;

const NAV_CONFIGURE = [
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
    <a class="brand" href="/" aria-label="Nyst — back to Overview"><img src="/brand/nyst-mark.png" alt=""><span>nyst</span></a>
    <div class="nav">${NAV.map(link).join("")}</div>
    <p class="nav-group">Configure</p>
    <div class="nav">${NAV_CONFIGURE.map(link).join("")}</div>
    <div class="sidebar-foot"><p>Nyst v0.2.2</p></div>
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

export function loginPage(): string {
  return page("Sign in", `<main class="login">
  <section class="login-brand">
    <img src="/brand/nyst-domain-wordmark.png" alt="nyst.ai">
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
    </form>
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
        return `<article class="incident${blocked ? " is-blocked" : ""}">
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

export function actionsPage(rows: readonly Record<string, unknown>[], title = "Actions", selected: ActionFilterView = {}, context: ShellContext = {}): string {
  const options = (name: string, label: string, values: readonly string[]): string =>
    `<label>${escape(label)}<select name="${name}"><option value="">Any</option>${values.map((value) =>
      `<option value="${escape(value)}"${(selected as Record<string, unknown>)[name] === value ? " selected" : ""}>${escape(value)}</option>`).join("")}</select></label>`;

  return shell(title, "/actions", `
  <div class="page-head">
    <p class="eyebrow">Consequential action ledger</p>
    <h1>${escape(title)}</h1>
    <p class="lede">Every logical action Nyst took responsibility for, with the truth it established and the decision it made.</p>
  </div>
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

export function integrationsPage(readiness: readonly Record<string, unknown>[], specs: readonly Record<string, unknown>[], context: ShellContext = {}): string {
  return shell("Integrations", "/integrations", `
  <div class="page-head">
    <p class="eyebrow">Connection readiness</p>
    <h1>Integrations</h1>
    <p class="lede">Readiness is six separate conditions, not one flag. "Test" runs a bounded read-only preflight; it never mutates provider state, and Nyst never displays a credential.</p>
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
    </ul>
    <div class="button-row gap-l">
      <button data-preflight="${escape(String(item.provider))}">Run read-only preflight</button>
    </div>
  </div>`).join("")}

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Per environment</p><h2>EffectSpec enablement</h2></div></div>
    ${specs.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">EffectSpec</th><th scope="col">Version</th><th scope="col">Provider</th><th scope="col">Enabled</th><th scope="col">Status</th></tr></thead>
      <tbody>${specs.map((spec) => `<tr>
        <td>${escape(String(spec.effect_name))}</td><td class="mono small">${escape(String(spec.spec_version))}</td>
        <td>${escape(String(spec.provider))}</td><td>${spec.enabled ? "yes" : "no"}</td>
        <td><span class="badge ${spec.ready ? "resolved" : "neutral"}">${escape(String(spec.status ?? ""))}</span></td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No EffectSpecs registered.</p></div>`}
  </section>`, context);
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

export function settingsPage(info: Record<string, unknown> | null, control: Record<string, unknown>, webhooks: readonly Record<string, unknown>[], keys: readonly Record<string, unknown>[], freezes: { active: Record<string, unknown>[] } = { active: [] }, context: ShellContext = {}): string {
  return shell("Settings", "/settings", `
  <div class="page-head"><p class="eyebrow">Configuration</p><h1>Settings</h1></div>

  <section class="section">
    <div class="section-head"><div><h2>Workspace</h2></div></div>
    <div class="panel panel-pad"><dl class="facts">
      <div><dt>Organization</dt><dd>${escape(String(info?.organization ?? ""))}</dd></div>
      <div><dt>Project</dt><dd>${escape(String(info?.project ?? ""))}</dd></div>
      <div><dt>Environment</dt><dd>${escape(String(info?.environment ?? ""))}</dd></div>
      <div><dt>Rollout mode</dt><dd><span class="mode ${escape(String(control.mode))}">${escape(String(control.mode))}</span></dd></div>
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
    ${keys.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">Name</th><th scope="col">Prefix</th><th scope="col">Bound Agent</th><th scope="col">Scopes</th><th scope="col">Last used</th><th scope="col">Status</th></tr></thead>
      <tbody>${keys.map((key) => `<tr>
        <td>${escape(String(key.name))}</td><td class="mono small">${escape(String(key.prefix))}</td>
        <td>${escape(String(key.agent_name ?? "any Agent"))}</td>
        <td class="small">${escape(((key.scopes as string[]) ?? []).join(", "))}</td>
        <td class="small">${escape(String(key.last_used_at ?? "never"))}</td>
        <td>${key.revoked_at ? `<span class="badge blocked">revoked</span>` : `<span class="badge resolved">active</span>`}</td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="panel panel-pad"><p class="empty">No API keys.</p></div>`}
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

export function genericPage(title: string, message: string): string {
  return shell(title, "/", `<div class="page-head"><h1>${escape(title)}</h1><p class="lede">${escape(message)}</p></div>`);
}
