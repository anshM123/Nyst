/**
 * THE NYST PROTECTION REPORT (Phase 9).
 *
 * Purpose: SHOW THE CUSTOMER THEIR OWN RISK.
 *
 * Every number comes from the canonical metric service. Nothing here invents a
 * finding, a saving, or an incident:
 *
 *   - no fabricated dollar savings; financial exposure appears only when an
 *     EffectSpec carried an authoritative amount AND a duplicate risk was
 *     actually demonstrated;
 *   - Shadow numbers stay counterfactual ("would have"), Enforced numbers say
 *     "prevented", and the two are never added together;
 *   - the rollout recommendation is deterministic branching over persisted
 *     facts. No LLM is involved anywhere in this file.
 */
import type { CanonicalMetrics, InterventionSummary, MetricRange } from "./canonicalMetrics.js";
import type { EnvironmentMode } from "./controlPlane.js";
import type { IntegrationReadiness } from "./readiness.js";

export type RolloutRecommendation = "ENFORCE" | "CANARY" | "KEEP IN SHADOW" | "BLOCKED BY READINESS";

export interface HighestRiskIncident {
  action_id: string | null;
  effect_name: string;
  agent_name: string | null;
  effect_state: string;
  control_decision: string;
  occurred_at: string;
  /** Concise causal explanation derived from persisted records only. */
  explanation: string;
  /** Present only when the EffectSpec carried an authoritative amount. */
  exposure: { amount_minor: number; currency: string } | null;
}

export interface ProtectionReport {
  generated_at: string;
  range: MetricRange;
  mode: EnvironmentMode;
  environment: { organization: string; project: string; environment: string };

  metrics: CanonicalMetrics;

  /** Enforced/Canary reality and Shadow counterfactual, deliberately separated. */
  enforced: { unsafe_retries_prevented: number; unsafe_continuations_prevented: number; auto_resolved: number };
  shadow: { unsafe_retries_detected: number; unsafe_continuations_detected: number };

  highest_risk_incident: HighestRiskIncident | null;
  risk_by_agent: ReadonlyArray<{ agent: string; actions: number; interventions: number }>;
  risk_by_effect: ReadonlyArray<{ effect_name: string; actions: number; interventions: number }>;
  representative_interventions: readonly InterventionSummary[];

  recommendation: {
    result: RolloutRecommendation;
    /** Every input the deterministic rule consulted, so the answer is auditable. */
    considered: {
      observation_volume: number;
      ambiguous_executions: number;
      semantics_supported: boolean;
      readiness_ready: boolean;
      readiness_blockers: readonly string[];
      unresolved_incidents: number;
      current_mode: EnvironmentMode;
    };
    rationale: readonly string[];
    next_step: string;
  };

  /**
   * Financial exposure is reported ONLY where an authoritative amount exists
   * and a duplicate risk was genuinely demonstrated. It is never a "savings"
   * figure and never extrapolated.
   */
  demonstrated_financial_exposure: { currency: string; amount_minor: number; action_count: number } | null;

  honesty_notes: readonly string[];
}

export interface ProtectionReportInput {
  metrics: CanonicalMetrics;
  environment: { organization: string; project: string; environment: string };
  readiness: readonly IntegrationReadiness[];
  unresolved_incidents: number;
  highest_risk_incident: HighestRiskIncident | null;
  risk_by_agent: ReadonlyArray<{ agent: string; actions: number; interventions: number }>;
  risk_by_effect: ReadonlyArray<{ effect_name: string; actions: number; interventions: number }>;
  demonstrated_financial_exposure: { currency: string; amount_minor: number; action_count: number } | null;
  generated_at: string;
}

/** Minimum observations before recommending real enforcement. */
export const CANARY_OBSERVATION_THRESHOLD = 10;
export const ENFORCE_OBSERVATION_THRESHOLD = 50;

/**
 * Deterministic rollout recommendation.
 *
 * Pure branching over persisted facts: the same inputs always produce the same
 * output, and every branch states why.
 */
export function recommendRollout(input: {
  metrics: CanonicalMetrics;
  readiness: readonly IntegrationReadiness[];
  unresolved_incidents: number;
}): ProtectionReport["recommendation"] {
  const { metrics } = input;
  const volume = metrics.consequential_actions + metrics.unsafe_retries_detected_shadow + metrics.unsafe_continuations_detected_shadow;
  const relevant = input.readiness.filter((item) => item.enabled);
  const blockers = relevant.filter((item) => !item.ready).map((item) => `${item.provider}: ${item.reason}`);
  const semanticsSupported = relevant.length > 0;
  const considered = {
    observation_volume: volume,
    ambiguous_executions: metrics.ambiguous_executions,
    semantics_supported: semanticsSupported,
    readiness_ready: blockers.length === 0 && semanticsSupported,
    readiness_blockers: blockers,
    unresolved_incidents: input.unresolved_incidents,
    current_mode: metrics.mode,
  };

  if (!semanticsSupported) {
    return { result: "BLOCKED BY READINESS", considered,
      rationale: ["No EffectSpec is enabled in this environment, so Nyst has no semantics to enforce with."],
      next_step: "Enable the exact EffectSpec version for the workload you want to protect." };
  }
  if (blockers.length > 0) {
    return { result: "BLOCKED BY READINESS", considered,
      rationale: ["A required integration is not currently ready.", ...blockers],
      next_step: "Resolve the readiness blockers above, then re-run a read-only preflight." };
  }
  if (volume < CANARY_OBSERVATION_THRESHOLD) {
    return { result: "KEEP IN SHADOW", considered,
      rationale: [`Only ${volume} observations so far; below the ${CANARY_OBSERVATION_THRESHOLD} needed to judge this workload.`,
        "Enforcing on this little evidence would be a guess."],
      next_step: "Keep sending Shadow envelopes until there is enough evidence to judge the workload." };
  }
  if (input.unresolved_incidents > 0) {
    return { result: "CANARY", considered,
      rationale: [`${input.unresolved_incidents} incident(s) still need attention.`,
        "Expanding enforcement while incidents are open would add consequence on top of unresolved ambiguity."],
      next_step: "Clear the open incidents, then widen the Canary scope." };
  }
  if (metrics.mode === "shadow") {
    return { result: "CANARY", considered,
      rationale: [`${volume} observations with ${metrics.ambiguous_executions} ambiguous execution(s) is enough to enforce one scope.`,
        "Canary is deterministic: exactly one Agent and one EffectSpec, nothing sampled."],
      next_step: "Promote one Agent + EffectSpec to Canary and watch it before widening." };
  }
  if (metrics.mode === "canary" && volume < ENFORCE_OBSERVATION_THRESHOLD) {
    return { result: "CANARY", considered,
      rationale: [`${volume} observations is enough for a Canary scope but below the ${ENFORCE_OBSERVATION_THRESHOLD} for full enforcement.`],
      next_step: "Keep the current Canary scope running, or add a second scope." };
  }
  return { result: "ENFORCE", considered,
    rationale: [`${volume} observations, every integration ready, no unresolved incidents.`,
      metrics.unsafe_retries_prevented_enforced > 0
        ? `Nyst has already prevented ${metrics.unsafe_retries_prevented_enforced} unsafe retry(s) in the controlled scope.`
        : "The controlled scope has run without an unsafe retry appearing."],
    next_step: "Move the environment to Enforced so every consequential action routes through Nyst." };
}

export function buildProtectionReport(input: ProtectionReportInput): ProtectionReport {
  const { metrics } = input;
  return {
    generated_at: input.generated_at,
    range: metrics.range,
    mode: metrics.mode,
    environment: input.environment,
    metrics,
    enforced: {
      unsafe_retries_prevented: metrics.unsafe_retries_prevented_enforced,
      unsafe_continuations_prevented: metrics.unsafe_continuations_prevented_enforced,
      auto_resolved: metrics.auto_resolved,
    },
    shadow: {
      unsafe_retries_detected: metrics.unsafe_retries_detected_shadow,
      unsafe_continuations_detected: metrics.unsafe_continuations_detected_shadow,
    },
    highest_risk_incident: input.highest_risk_incident,
    risk_by_agent: input.risk_by_agent,
    risk_by_effect: input.risk_by_effect,
    representative_interventions: metrics.recent_interventions,
    recommendation: recommendRollout({ metrics, readiness: input.readiness, unresolved_incidents: input.unresolved_incidents }),
    demonstrated_financial_exposure: input.demonstrated_financial_exposure,
    honesty_notes: Object.freeze([
      "Shadow figures are counterfactual: Nyst observed the workload but did not control it, so nothing was prevented.",
      "Enforced and Canary figures describe actions Nyst actually controlled.",
      "Shadow and Enforced figures are never combined into one total.",
      "No monetary saving is estimated. Financial exposure appears only where an EffectSpec carried an authoritative amount and a duplicate risk was demonstrated.",
      "Demo environments and Failure Lab runs are excluded from every number in this report.",
      "The rollout recommendation is deterministic branching over the facts listed under `considered`. No model generated it.",
    ]),
  };
}

/* ------------------------------------------------------------------ CSV */

/** CSV export of the metric summary. Values are escaped, never concatenated raw. */
export function protectionReportCsv(report: ProtectionReport): string {
  const rows: string[][] = [
    ["metric", "value", "definition"],
    ["range", `${report.range.label} (${report.range.from} to ${report.range.to})`, "Reporting window"],
    ["mode", report.mode, "Current rollout mode"],
    ["consequential_actions", String(report.metrics.consequential_actions), report.metrics.metric_definitions.consequential_actions ?? ""],
    ["ambiguous_executions", String(report.metrics.ambiguous_executions), report.metrics.metric_definitions.ambiguous_executions ?? ""],
    ["unsafe_retries_prevented_enforced", String(report.enforced.unsafe_retries_prevented), report.metrics.metric_definitions.unsafe_retries_prevented_enforced ?? ""],
    ["unsafe_continuations_prevented_enforced", String(report.enforced.unsafe_continuations_prevented), report.metrics.metric_definitions.unsafe_continuations_prevented_enforced ?? ""],
    ["unsafe_retries_detected_shadow", String(report.shadow.unsafe_retries_detected), report.metrics.metric_definitions.unsafe_retries_detected_shadow ?? ""],
    ["unsafe_continuations_detected_shadow", String(report.shadow.unsafe_continuations_detected), report.metrics.metric_definitions.unsafe_continuations_detected_shadow ?? ""],
    ["auto_resolved", String(report.metrics.auto_resolved), report.metrics.metric_definitions.auto_resolved ?? ""],
    ["human_escalations", String(report.metrics.human_escalations), report.metrics.metric_definitions.human_escalations ?? ""],
    ["median_reconciliation_duration_ms", report.metrics.median_reconciliation_duration_ms === null ? "" : String(Math.round(report.metrics.median_reconciliation_duration_ms)), report.metrics.metric_definitions.median_reconciliation_duration_ms ?? ""],
    ["recommended_rollout", report.recommendation.result, "Deterministic recommendation"],
  ];
  for (const item of report.risk_by_agent) rows.push([`risk_by_agent:${item.agent}`, String(item.actions), `${item.interventions} intervention(s)`]);
  for (const item of report.risk_by_effect) rows.push([`risk_by_effect:${item.effect_name}`, String(item.actions), `${item.interventions} intervention(s)`]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: string): string {
  // A leading =, +, - or @ is neutralised so a spreadsheet cannot execute it.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
