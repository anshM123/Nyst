/**
 * PROOF PACK (Phase 18).
 *
 * One-click evidence bundle for an action or incident.
 *
 * A Proof Pack CREATES NO NEW TRUTH. It packages records that already exist:
 * action identity, Agent, environment, mode, EffectSpec + exact version, bound
 * policy + version, intent, durable dispatch boundary, cited evidence,
 * resolution history, current EffectState and ControlDecision, intervention
 * history, recovery history, the signed receipt, and the receipt verification
 * result.
 *
 * If a section is empty, it says so. It never fills a gap with a plausible
 * narrative.
 */
export interface ProofPack {
  proof_pack_version: 1;
  generated_at: string;
  /** Everything below is a copy of persisted state. No derivation, no inference. */
  provenance: "assembled_from_persisted_records";

  action: {
    action_id: string;
    business_key: string;
    effect_name: string;
    spec_version: string;
    input_hash: string;
    internal_state: string;
    created_at: string;
  };
  agent: { agent_id: string; name: string; owner: string; framework: string } | null;
  environment: { organization: string; project: string; environment: string; mode: string };
  policy: {
    policy_version_id: string; version: number; execution_mode: string; retry_mode: string;
    auto_continuation: boolean; auto_compensation: boolean; reconcile_timeout_seconds: number;
    template_id: string | null; bound_at: string; reconcile_deadline_at: string;
  } | null;
  intent: unknown;
  dispatch_boundary: {
    correlation_method: string | null; correlation_value: string | null;
    idempotency_key: string | null; provider: string | null; operation: string | null;
    dispatch_status: string | null; dispatch_attempts: number | null;
  };
  evidence: ReadonlyArray<Record<string, unknown>>;
  resolution_history: ReadonlyArray<Record<string, unknown>>;
  current: { effect_state: string; control: { primary: string; retry: string; continuation: string; recovery: string }; reason_code: string; explanation: string } | null;
  interventions: ReadonlyArray<Record<string, unknown>>;
  recovery_history: ReadonlyArray<Record<string, unknown>>;
  human_review: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
  receipt_verification: { verified: boolean | null; note: string };
  webhook_events: ReadonlyArray<Record<string, unknown>>;

  /** Honest statements about what this bundle does and does not prove. */
  attestations: readonly string[];
}

export const PROOF_PACK_ATTESTATIONS: readonly string[] = Object.freeze([
  "This bundle contains only records that already existed in Nyst. Generating it created no new truth.",
  "The receipt signature is an Ed25519 software signature. It provides tamper evidence for the receipt contents.",
  "It is NOT hardware-backed, NOT HSM-attested, and NOT a trusted timestamp. Nyst does not claim any of those.",
  "Timestamps come from the local system clock and are recorded as untrusted (`clock.trusted = false`).",
  "Evidence is append-only. A correction appears as an additional record citing what it supersedes; nothing is edited away.",
  "An empty section means Nyst holds no such record, not that nothing happened.",
]);

/** Render a Proof Pack as a self-contained, print-quality HTML document. */
export function proofPackHtml(pack: ProofPack): string {
  const rows = (items: ReadonlyArray<Record<string, unknown>>, columns: readonly string[]): string =>
    items.length === 0
      ? `<p class="empty">No records.</p>`
      : `<div class="scroll"><table><thead><tr>${columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${
          items.map((item) => `<tr>${columns.map((column) => `<td>${escapeHtml(formatCell(item[column]))}</td>`).join("")}</tr>`).join("")
        }</tbody></table></div>`;

  return `<!-- Nyst Proof Pack ${escapeHtml(pack.action.action_id)} -->
<section class="proof-pack">
  <header>
    <p class="eyebrow">Nyst Proof Pack</p>
    <h1>${escapeHtml(pack.action.effect_name)}</h1>
    <p class="lede">${escapeHtml(pack.action.business_key)}</p>
    <dl class="facts">
      <div><dt>Action</dt><dd><code>${escapeHtml(pack.action.action_id)}</code></dd></div>
      <div><dt>Agent</dt><dd>${escapeHtml(pack.agent ? `${pack.agent.name} (${pack.agent.owner})` : "unattributed")}</dd></div>
      <div><dt>Environment</dt><dd>${escapeHtml(`${pack.environment.organization} / ${pack.environment.project} / ${pack.environment.environment}`)}</dd></div>
      <div><dt>Mode at creation</dt><dd>${escapeHtml(pack.environment.mode)}</dd></div>
      <div><dt>EffectSpec</dt><dd>${escapeHtml(pack.action.spec_version)}</dd></div>
      <div><dt>Generated</dt><dd>${escapeHtml(pack.generated_at)}</dd></div>
    </dl>
  </header>

  <section><h2>Current state</h2>${pack.current
    ? `<p class="state"><strong>${escapeHtml(pack.current.effect_state)}</strong> &middot; ${escapeHtml(pack.current.control.primary)}</p>
       <p>${escapeHtml(pack.current.explanation)}</p>
       <dl class="facts">
         <div><dt>Retry</dt><dd>${escapeHtml(pack.current.control.retry)}</dd></div>
         <div><dt>Continuation</dt><dd>${escapeHtml(pack.current.control.continuation)}</dd></div>
         <div><dt>Recovery</dt><dd>${escapeHtml(pack.current.control.recovery)}</dd></div>
         <div><dt>Reason</dt><dd><code>${escapeHtml(pack.current.reason_code)}</code></dd></div>
       </dl>`
    : `<p class="empty">No resolution has been recorded.</p>`}</section>

  <section><h2>Bound policy</h2>${pack.policy
    ? `<dl class="facts">
        <div><dt>Version</dt><dd>${escapeHtml(String(pack.policy.version))}${pack.policy.template_id ? ` (${escapeHtml(pack.policy.template_id)})` : ""}</dd></div>
        <div><dt>Execution</dt><dd>${escapeHtml(pack.policy.execution_mode)}</dd></div>
        <div><dt>Retry</dt><dd>${escapeHtml(pack.policy.retry_mode)}</dd></div>
        <div><dt>Auto continuation</dt><dd>${pack.policy.auto_continuation ? "yes" : "no"}</dd></div>
        <div><dt>Auto compensation</dt><dd>${pack.policy.auto_compensation ? "yes" : "no"}</dd></div>
        <div><dt>Deadline</dt><dd>${escapeHtml(pack.policy.reconcile_deadline_at)}</dd></div>
      </dl>`
    : `<p class="empty">No policy binding recorded.</p>`}</section>

  <section><h2>Dispatch boundary</h2><dl class="facts">
    <div><dt>Status</dt><dd>${escapeHtml(pack.dispatch_boundary.dispatch_status ?? "unknown")}</dd></div>
    <div><dt>Attempts</dt><dd>${escapeHtml(String(pack.dispatch_boundary.dispatch_attempts ?? 0))}</dd></div>
    <div><dt>Provider</dt><dd>${escapeHtml(pack.dispatch_boundary.provider ?? "n/a")}</dd></div>
    <div><dt>Operation</dt><dd>${escapeHtml(pack.dispatch_boundary.operation ?? "n/a")}</dd></div>
    <div><dt>Correlation</dt><dd>${escapeHtml(pack.dispatch_boundary.correlation_method ?? "none")}</dd></div>
    <div><dt>Idempotency key</dt><dd>${escapeHtml(pack.dispatch_boundary.idempotency_key ?? "none")}</dd></div>
  </dl></section>

  <section><h2>Evidence timeline</h2>${rows(pack.evidence, ["seq", "source", "kind", "strength", "observed_disposition", "attribution", "observed_at"])}</section>
  <section><h2>Resolution history</h2>${rows(pack.resolution_history, ["resolution_sequence", "effect_state", "primary_directive", "retry_disposition", "continuation_disposition", "resolved_at"])}</section>
  <section><h2>Interventions</h2>${rows(pack.interventions, ["kind", "mode", "summary", "occurred_at"])}</section>
  <section><h2>Recovery</h2>${rows(pack.recovery_history, ["operation", "status", "dispatch_state", "attempt", "created_at", "completed_at"])}</section>
  <section><h2>Decision events</h2>${rows(pack.webhook_events, ["event_type", "occurred_at", "delivered_at"])}</section>

  <section><h2>Signed receipt</h2>
    <p class="state">Signature verification: <strong>${pack.receipt_verification.verified === null ? "not performed" : pack.receipt_verification.verified ? "valid" : "INVALID"}</strong></p>
    <p>${escapeHtml(pack.receipt_verification.note)}</p>
  </section>

  <section><h2>What this bundle does and does not prove</h2>
    <ul>${pack.attestations.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
  </section>
</section>`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
}
