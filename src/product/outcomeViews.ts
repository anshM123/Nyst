/**
 * OUTCOME AND AUTHORITY SURFACES.
 *
 * The one thing these pages must communicate, above everything else:
 *
 *     ACTION VERIFIED.  OUTCOME UNSATISFIED.
 *
 * A customer looking at an outcome that is not satisfied must be able to see,
 * without clicking anything, that the individual operations Nyst performed all
 * succeeded AND that the real-world condition they cared about is still false.
 * If those two facts are on different screens, or one of them is a subtle
 * colour, the product has failed at the only job this layer has.
 *
 * Kept in its own module rather than growing dashboard.ts further, because the
 * outcome layer is a distinct surface with distinct vocabulary.
 */
import { escape } from "./dashboard.js";
import { OUTCOME_VERDICT_DEFINITIONS, type OutcomeVerdict } from "./outcome/invariantEngine.js";
import { AUTHORITY_DISPOSITION_DEFINITIONS } from "./authority/canonicalAuthority.js";
import { AUTONOMY_DISPOSITION_DEFINITIONS } from "./authority/autonomyLine.js";

interface InvariantView {
  invariant_id: string;
  statement: string;
  operator: string;
  result: "true" | "false" | "indeterminate";
  reason: string;
  facts_used?: readonly string[];
  evidence_ids?: readonly string[];
  missing_facts?: readonly string[];
  contradictions?: readonly string[];
  oldest_observed_at?: string | null;
}

const VERDICT_BADGE: Readonly<Record<OutcomeVerdict, string>> = Object.freeze({
  satisfied: "resolved", unsatisfied: "blocked", indeterminate: "uncertain",
});

const VERDICT_HEADLINE: Readonly<Record<OutcomeVerdict, string>> = Object.freeze({
  satisfied: "Outcome established",
  unsatisfied: "Outcome NOT established",
  indeterminate: "Outcome could not be established",
});

/** The list of outcomes in this environment. */
export function outcomesPage(
  instances: readonly Record<string, unknown>[],
  contracts: readonly Record<string, unknown>[],
): string {
  const rows = instances.map((instance) => {
    const verdict = String(instance.verdict) as OutcomeVerdict;
    const coverage = `${Number(instance.coverage_numerator)}/${Number(instance.coverage_denominator)}`;
    return `<tr>
      <td><a href="/outcomes/${escape(String(instance.outcome_instance_id))}">${escape(subjectLabel(instance.subject))}</a></td>
      <td class="small">${escape(String(instance.outcome_spec ?? ""))}</td>
      <td><span class="badge ${VERDICT_BADGE[verdict]}">${escape(verdict)}</span></td>
      <td class="small">${escape(String(instance.continuation_disposition))}</td>
      <td class="small mono">${escape(coverage)}</td>
      <td class="small">${escape(String(instance.lifecycle))}</td>
    </tr>`;
  }).join("");

  return `<div class="page-head">
    <p class="eyebrow">What became true</p>
    <h1>Outcomes</h1>
    <p class="lede">An action succeeding is not the same as the thing you wanted being true. An Outcome is the real-world condition itself, established from evidence Nyst can name.</p>
  </div>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">In flight and settled</p><h2>Outcome instances</h2></div></div>
    ${instances.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">Subject</th><th scope="col">Outcome</th><th scope="col">Verdict</th>
        <th scope="col">Continuation</th><th scope="col">Coverage</th><th scope="col">Lifecycle</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
      : `<div class="panel panel-pad"><p class="empty">No outcomes have been requested in this environment yet.</p></div>`}
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">What Nyst is required to establish</p><h2>Outcome contracts</h2></div></div>
    ${contracts.length ? contracts.map((contract) => `<div class="panel panel-pad gap-below-m">
      <header class="split-top">
        <div>
          <h3>${escape(String(contract.outcome_spec))}</h3>
          <p class="small mono">${escape(String(contract.outcome_spec_version))} · contract v${escape(String(contract.contract_version))}</p>
        </div>
        <span class="badge ${contract.activated_at ? "resolved" : "neutral"}">${contract.activated_at ? "active" : "draft"}</span>
      </header>
      <p class="lede gap-s">${escape(String(contract.desired_outcome_statement))}</p>
      <ul class="checks gap-m">
        ${((contract.required_invariants as InvariantView[]) ?? []).map((invariant) =>
          `<li><span class="state pass">Required</span><span class="body">
             <strong>${escape(invariant.statement)}</strong>
             <span class="mono small">${escape(invariant.invariant_id)}</span></span></li>`).join("")}
      </ul>
    </div>`).join("")
      : `<div class="panel panel-pad"><p class="empty">No Outcome contracts are configured.</p></div>`}
  </section>`;
}

/**
 * One outcome, in detail.
 *
 * The layout is deliberate: the ACTION panel and the OUTCOME panel sit side by
 * side, so "every action succeeded and the outcome is still false" is a single
 * glance rather than a deduction.
 */
export function outcomePage(input: {
  instance: Record<string, unknown>;
  contract: Record<string, unknown>;
  evaluation: Record<string, unknown> | null;
  actions: ReadonlyArray<Record<string, unknown>>;
  facts: ReadonlyArray<Record<string, unknown>>;
  receipt: Record<string, unknown> | null;
  exceptions: ReadonlyArray<Record<string, unknown>>;
  grants: ReadonlyArray<Record<string, unknown>>;
}): string {
  const verdict = String(input.instance.verdict) as OutcomeVerdict;
  const detail = (input.evaluation?.detail ?? {}) as { required?: InvariantView[]; optional?: InvariantView[]; primary_reason?: string };
  const required = detail.required ?? [];
  const numerator = Number(input.instance.coverage_numerator);
  const denominator = Number(input.instance.coverage_denominator);

  // Every atomic action underneath, and what the effect layer says about it.
  const allActionsSucceeded = input.actions.length > 0
    && input.actions.every((action) => ["verified", "satisfied_unattributed", "compensated"].includes(String(action.effect_state ?? "")));

  return `<div class="page-head">
    <p class="eyebrow">${escape(String(input.contract.outcome_spec))}</p>
    <h1>${escape(subjectLabel(input.instance.subject))}</h1>
    <p class="lede">${escape(String(input.contract.desired_outcome_statement))}</p>
  </div>

  <!-- THE HEADLINE. Two claims, side by side, in words. -->
  <section class="split-claim gap-below-l">
    <div class="panel panel-pad claim ${allActionsSucceeded ? "claim-ok" : "claim-neutral"}">
      <p class="eyebrow">The operations Nyst performed</p>
      <h2>${input.actions.length === 0 ? "No actions yet" : allActionsSucceeded ? "Every action succeeded" : "Some actions are unresolved"}</h2>
      <p class="small">${input.actions.length} atomic ${input.actions.length === 1 ? "action" : "actions"} beneath this outcome.
        ${allActionsSucceeded ? "Each one was independently established from external truth." : ""}</p>
    </div>
    <div class="panel panel-pad claim ${verdict === "satisfied" ? "claim-ok" : "claim-alarm"}">
      <p class="eyebrow">What is actually true</p>
      <h2>${escape(VERDICT_HEADLINE[verdict])}</h2>
      <p class="small">${escape(OUTCOME_VERDICT_DEFINITIONS[verdict])}</p>
    </div>
  </section>

  ${allActionsSucceeded && verdict !== "satisfied" ? `<div class="panel panel-pad note-strong gap-below-l">
    <p><strong>Every action Nyst performed succeeded, and the outcome is still not established.</strong>
    That is not a contradiction. An operation completing tells you what happened to the operation; it does not tell you what became true in the world.
    ${detail.primary_reason ? escape(detail.primary_reason) : ""}</p>
  </div>` : ""}

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Required conditions</p><h2>Invariants</h2></div>
      <p class="small">Coverage ${numerator}/${denominator} — how many required conditions Nyst could actually evaluate.</p></div>
    <div class="panel panel-pad">
      <ul class="checks">
        ${required.map((invariant) => `<li>
          <span class="state ${invariant.result === "true" ? "pass" : invariant.result === "false" ? "fail" : "unknown"}">${invariant.result === "true" ? "Holds" : invariant.result === "false" ? "FALSE" : "Unknown"}</span>
          <span class="body">
            <strong>${escape(invariant.statement)}</strong>
            <span>${escape(invariant.reason)}</span>
            ${(invariant.missing_facts ?? []).length ? `<span class="small">Missing: ${escape((invariant.missing_facts ?? []).join(", "))}</span>` : ""}
            ${(invariant.contradictions ?? []).length ? `<span class="small">Sources disagree: ${escape((invariant.contradictions ?? []).join("; "))}</span>` : ""}
            ${(invariant.facts_used ?? []).length ? `<span class="small mono">facts: ${escape((invariant.facts_used ?? []).join(", "))}</span>` : ""}
          </span></li>`).join("")}
      </ul>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">What Nyst observed</p><h2>World facts</h2></div></div>
    ${input.facts.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">Subject</th><th scope="col">Property</th><th scope="col">Value</th>
        <th scope="col">Source</th><th scope="col">Authoritative</th><th scope="col">Observed</th></tr></thead>
      <tbody>${input.facts.map((fact) => `<tr>
        <td class="mono small">${escape(String(fact.subject_ref))}</td>
        <td class="small">${escape(String(fact.property))}</td>
        <td class="mono small">${escape(describeValue(fact.value))}</td>
        <td class="small">${escape(String(fact.source_type))}</td>
        <td>${fact.authoritative ? "yes" : "corroborative only"}</td>
        <td class="small">${escape(String(fact.observed_at))}</td>
      </tr>`).join("")}</tbody></table></div>`
      : `<div class="panel panel-pad"><p class="empty">Nyst has observed nothing about this subject yet.</p></div>`}
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Underneath</p><h2>Atomic actions</h2></div></div>
    ${input.actions.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">Dependency</th><th scope="col">Action</th><th scope="col">Effect state</th></tr></thead>
      <tbody>${input.actions.map((action) => `<tr>
        <td class="small">${escape(String(action.dependency_key))}</td>
        <td><a class="mono small" href="/actions/${escape(String(action.action_id))}">${escape(String(action.action_id))}</a></td>
        <td><span class="badge ${String(action.effect_state) === "verified" ? "resolved" : "uncertain"}">${escape(String(action.effect_state ?? "unknown"))}</span></td>
      </tr>`).join("")}</tbody></table></div>`
      : `<div class="panel panel-pad"><p class="empty">No atomic actions are linked to this outcome.</p></div>`}
  </section>

  ${input.exceptions.length ? `<section class="section">
    <div class="section-head"><div><p class="eyebrow">Human authorizations</p><h2>Exceptions</h2></div></div>
    <div class="panel panel-pad">
      <p class="small">An exception authorizes continuation. It does not change what Nyst observed, and the verdict above is unaffected by it.</p>
      <ul class="checks gap-m">
        ${input.exceptions.map((exception) => `<li><span class="state unknown">Authorized</span><span class="body">
          <strong>${escape(String(exception.actor ?? ""))} (${escape(String(exception.actor_role ?? ""))})</strong>
          <span>${escape(String(exception.reason ?? ""))}</span>
          <span class="small">Expires ${escape(String(exception.expires_at ?? ""))}${exception.reference ? ` · ${escape(String(exception.reference))}` : ""}</span>
        </span></li>`).join("")}
      </ul>
    </div>
  </section>` : ""}

  ${input.receipt ? `<section class="section">
    <div class="section-head"><div><p class="eyebrow">Signed statement</p><h2>Outcome Receipt</h2></div></div>
    <div class="panel panel-pad">
      <p class="small">This receipt packages truth Nyst already established. It creates none.</p>
      <div class="button-row gap-m">
        <a class="button" href="/outcomes/${escape(String(input.instance.outcome_instance_id))}/receipt">Open receipt</a>
        <a class="button subtle" href="/outcomes/${escape(String(input.instance.outcome_instance_id))}/receipt.json">Download JSON</a>
      </div>
    </div>
  </section>` : ""}`;
}

/** The Autonomy Line, as an envelope rather than a score. */
export function autonomyPage(rules: readonly Record<string, unknown>[], decisions: readonly Record<string, unknown>[]): string {
  return `<div class="page-head">
    <p class="eyebrow">Where independence ends</p>
    <h1>Autonomy Line</h1>
    <p class="lede">Not a trust score. A deterministic envelope: this Agent may do this much of this, on its own, under these conditions. Removing access and granting it are different risks, and a single number cannot tell them apart.</p>
  </div>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Rules</p><h2>What each Agent may do alone</h2></div></div>
    ${rules.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">Agent</th><th scope="col">EffectSpec</th><th scope="col">Bounds</th>
        <th scope="col">Disposition</th><th scope="col">Rationale</th></tr></thead>
      <tbody>${rules.map((rule) => `<tr>
        <td class="small">${escape(String(rule.agent_name ?? rule.agent_id ?? "any Agent"))}</td>
        <td class="small mono">${escape(String(rule.effect_name ?? "any EffectSpec"))}</td>
        <td class="small">${escape(describeBounds(rule))}</td>
        <td><span class="badge ${rule.disposition === "autonomous" ? "resolved" : rule.disposition === "disabled" ? "blocked" : "uncertain"}">${escape(String(rule.disposition))}</span></td>
        <td class="small">${escape(String(rule.rationale ?? ""))}</td>
      </tr>`).join("")}</tbody></table></div>`
      : `<div class="panel panel-pad"><p class="empty">No Autonomy Line rules are configured. Every consequential action therefore requires a person — an undescribed Agent has no autonomy, not unlimited autonomy.</p></div>`}
    <div class="panel panel-pad gap-l">
      <h3>What the three dispositions mean</h3>
      <dl class="facts">
        ${Object.entries(AUTONOMY_DISPOSITION_DEFINITIONS).map(([key, definition]) =>
          `<div><dt>${escape(key)}</dt><dd>${escape(definition)}</dd></div>`).join("")}
      </dl>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">Why things were allowed, held or blocked</p><h2>Recent authority decisions</h2></div></div>
    ${decisions.length ? decisions.map((decision) => `<div class="panel panel-pad gap-below-m">
      <header class="split-top">
        <div><h3 class="mono small">${escape(String(decision.effect_name))}</h3>
          <p class="small">${escape(String(decision.decided_at))}</p></div>
        <span class="badge ${decision.disposition === "allowed" ? "resolved" : decision.disposition === "blocked" ? "blocked" : "uncertain"}">${escape(String(decision.disposition))}</span>
      </header>
      <p class="small">${escape(AUTHORITY_DISPOSITION_DEFINITIONS[String(decision.disposition) as keyof typeof AUTHORITY_DISPOSITION_DEFINITIONS] ?? "")}</p>
      <ul class="checks gap-m">
        ${((decision.reasons as Array<{ layer: string; disposition: string; reason: string }>) ?? []).map((reason) =>
          `<li><span class="state ${reason.disposition === "allowed" ? "pass" : reason.disposition === "blocked" ? "fail" : "unknown"}">${escape(reason.layer.replace(/_/g, " "))}</span>
             <span class="body"><span>${escape(reason.reason)}</span></span></li>`).join("")}
      </ul>
    </div>`).join("")
      : `<div class="panel panel-pad"><p class="empty">No authority decisions have been recorded yet.</p></div>`}
  </section>`;
}

function subjectLabel(subject: unknown): string {
  if (!subject || typeof subject !== "object") return "unknown subject";
  const record = subject as Record<string, unknown>;
  return String(record.person_email ?? record.subject ?? record.id ?? JSON.stringify(record).slice(0, 80));
}

function describeValue(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const typed = value as { type?: string; value?: unknown };
  if (typed.type === "absent") return "absent";
  if (Array.isArray(typed.value)) return `[${typed.value.join(", ")}]`;
  return String(typed.value);
}

function describeBounds(rule: Record<string, unknown>): string {
  const parts: string[] = [];
  if (rule.max_amount_minor !== null && rule.max_amount_minor !== undefined) {
    parts.push(`≤ ${(Number(rule.max_amount_minor) / 100).toFixed(2)} ${String(rule.currency ?? "").toUpperCase()} per action`);
  }
  if (rule.max_amount_minor_per_window !== null && rule.max_amount_minor_per_window !== undefined) {
    parts.push(`≤ ${(Number(rule.max_amount_minor_per_window) / 100).toFixed(2)} ${String(rule.currency ?? "").toUpperCase()} per ${String(rule.window_seconds)}s`);
  }
  if (rule.max_actions_per_window !== null && rule.max_actions_per_window !== undefined) {
    parts.push(`≤ ${String(rule.max_actions_per_window)} actions per ${String(rule.window_seconds)}s`);
  }
  if (rule.requires_reversible) parts.push("reversible effects only");
  if (rule.requires_no_open_incident) parts.push("suspended while an incident is open");
  if (rule.requires_outcome_satisfied) parts.push(`requires ${String(rule.requires_outcome_satisfied)} satisfied`);
  return parts.length ? parts.join(" · ") : "no additional bounds";
}
