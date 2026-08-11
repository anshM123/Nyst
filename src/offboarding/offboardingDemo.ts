import type { OffboardingRunView, OffboardingStepView } from "./offboardingCoordinator.js";

export function renderOffboardingRunHtml(view: OffboardingRunView): string {
  const title = escapeHtml(view.run.subject.display_name);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nyst offboarding — ${title}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui;color:#e8eefc;background:#07111f;color-scheme:dark}body{margin:0;padding:32px}.shell{max-width:980px;margin:auto}.eyebrow{color:#7dd3fc;text-transform:uppercase;letter-spacing:.14em;font-size:12px}.status{display:inline-block;padding:6px 10px;border:1px solid #334155;border-radius:999px}.steps{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:24px}.card{background:#0f1d31;border:1px solid #243955;border-radius:16px;padding:20px}.ok{border-color:#16a34a}.blocked{border-color:#dc2626}.stage{display:grid;grid-template-columns:120px 1fr;gap:8px;padding:7px 0;border-bottom:1px solid #1e3048}.muted{color:#94a3b8}.warning{color:#fbbf24}@media(max-width:720px){body{padding:16px}.steps{grid-template-columns:1fr}.stage{grid-template-columns:1fr}}
</style></head><body><main class="shell"><div class="eyebrow">Nyst Gate 6 · live runtime data</div><h1>Offboard ${title}</h1><p class="status">${escapeHtml(view.status)}</p>${view.blocking_reason ? `<p class="warning">${escapeHtml(view.blocking_reason)}</p>` : ""}<section class="steps">${stepHtml("Step 1", "Okta — suspend account", view.okta)}${stepHtml("Step 2", "GitHub — remove repository access", view.github)}</section><p class="muted">A provider response is not effect truth. Nyst persists intent, observes external state, reconciles evidence, and authorizes continuation only from a current signed resolution.</p></main></body></html>`;
}

function stepHtml(number: string, label: string, step: OffboardingStepView): string {
  const resolution = step.resolution;
  const stages = [
    ["Intent", step.action_id ? "persisted" : "not started"],
    ["Execution", step.action_id ? "durable operation identity" : "waiting"],
    ["Observation", `${step.evidence_count} evidence record(s)`],
    ["Reconciliation", resolution ? `sequence ${resolution.runtime?.resolution_sequence ?? "—"}` : "waiting"],
    ["EffectState", resolution?.effect.state ?? "—"],
    ["ControlDecision", resolution?.control.primary ?? "—"],
    ["Evidence", resolution?.effect.evidence_strength ?? "none"],
    ["Signed receipt", step.receipt_signed ? "signed" : "not available"],
  ];
  const good = step.current && step.receipt_signed && resolution?.control.continuation === "allowed";
  return `<article class="card ${good ? "ok" : "blocked"}"><div class="eyebrow">${escapeHtml(number)}</div><h2>${escapeHtml(label)}</h2>${stages.map(([k,v]) => `<div class="stage"><strong>${escapeHtml(k!)}</strong><span>${escapeHtml(v!)}</span></div>`).join("")}</article>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]!);
}
