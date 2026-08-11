/**
 * THE canonical Nyst metric contract.
 *
 * Overview, the Protection Report, and the impact API all read this one
 * service. v0.2.1 had two competing definitions of "unsafe retries prevented"
 * under two different field names, and the Overview card silently rendered 0
 * because it consumed a field the backend never produced.
 *
 * Rules enforced here:
 *   - no `any`
 *   - no quiet `undefined ?? 0` masking a schema mismatch
 *   - an explicit zero is valid
 *   - a MISSING required metric is an implementation defect and throws
 *   - Demo and Failure Lab activity are excluded
 *   - Shadow terminology stays counterfactual ("detected", never "prevented")
 */
import type { EnvironmentMode } from "./controlPlane.js";

export type InterventionKind =
  | "retry_blocked"
  | "continuation_blocked"
  | "auto_resolved"
  | "human_review_opened"
  | "shadow_retry_would_have_been_blocked"
  | "shadow_continuation_would_have_been_blocked"
  | "blast_radius_hold"
  | "freeze_blocked"
  | "recovery_needs_review";

export interface InterventionSummary {
  intervention_id: string;
  kind: InterventionKind;
  /** Null only for Shadow records, which have no Nyst-controlled action. */
  action_id: string | null;
  shadow_evaluation_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  effect_name: string;
  mode: EnvironmentMode;
  summary: string;
  occurred_at: string;
}

export interface MetricRange {
  from: string;
  to: string;
  label: "24h" | "7d" | "30d" | "custom" | "all";
  /**
   * SQL upper bound, or null for an open-ended "…until now" window.
   *
   * The application clock truncates to milliseconds while PostgreSQL stores
   * microseconds, so binding `to` from a JS `new Date()` silently excluded any
   * row written in the same millisecond the query was built. Every range
   * except an explicit custom one is therefore open-ended and lets the
   * database decide what "now" means.
   */
  sql_upper_bound: string | null;
}

export interface CanonicalMetrics {
  mode: EnvironmentMode;
  range: MetricRange;

  consequential_actions: number;
  ambiguous_executions: number;

  /** Real enforcement. Only Canary/Enforced actions can contribute. */
  unsafe_retries_prevented_enforced: number;
  /** Counterfactual. Shadow observed it; Nyst did not control it. */
  unsafe_retries_detected_shadow: number;
  unsafe_continuations_prevented_enforced: number;
  unsafe_continuations_detected_shadow: number;

  auto_resolved: number;
  human_escalations: number;
  median_reconciliation_duration_ms: number | null;

  recent_interventions: readonly InterventionSummary[];
  provider_breakdown: Readonly<Record<string, number>>;
  effect_breakdown: Readonly<Record<string, number>>;
  agent_breakdown: Readonly<Record<string, number>>;

  metric_definitions: Readonly<Record<string, string>>;
}

/** Required integer metrics. Every one must be present in the query result. */
export const REQUIRED_INTEGER_METRICS = [
  "consequential_actions",
  "ambiguous_executions",
  "unsafe_retries_prevented_enforced",
  "unsafe_retries_detected_shadow",
  "unsafe_continuations_prevented_enforced",
  "unsafe_continuations_detected_shadow",
  "auto_resolved",
  "human_escalations",
] as const;

export type RequiredIntegerMetric = (typeof REQUIRED_INTEGER_METRICS)[number];

export class MetricContractError extends Error {
  constructor(field: string, reason: string) {
    super(`Nyst metric contract violation: ${field} ${reason}. This is an implementation defect, not a zero.`);
    this.name = "MetricContractError";
  }
}

/**
 * Read a required integer. An explicit 0 is valid. `undefined`/`null` means
 * the SQL and the contract disagree, which must fail loudly rather than
 * render a comforting zero.
 */
export function requireMetricInt(row: Readonly<Record<string, unknown>>, field: string): number {
  const value = row[field];
  if (value === undefined) throw new MetricContractError(field, "is absent from the metrics query");
  if (value === null) throw new MetricContractError(field, "resolved to null");
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new MetricContractError(field, `is not numeric (received ${typeof value})`);
  if (!Number.isInteger(parsed)) throw new MetricContractError(field, "must be an integer count");
  if (parsed < 0) throw new MetricContractError(field, "must not be negative");
  return parsed;
}

/** Optional numeric metric where "no data yet" is a legitimate null. */
export function optionalMetricNumber(row: Readonly<Record<string, unknown>>, field: string): number | null {
  const value = row[field];
  if (value === undefined) throw new MetricContractError(field, "is absent from the metrics query");
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new MetricContractError(field, "is not numeric");
  return parsed;
}

export function requireBreakdown(row: Readonly<Record<string, unknown>>, field: string): Readonly<Record<string, number>> {
  const value = row[field];
  if (value === undefined || value === null) throw new MetricContractError(field, "is absent from the metrics query");
  if (typeof value !== "object" || Array.isArray(value)) throw new MetricContractError(field, "must be an object keyed by dimension");
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const parsed = Number(count);
    if (!Number.isInteger(parsed) || parsed < 0) throw new MetricContractError(`${field}.${key}`, "must be a non-negative integer");
    out[key] = parsed;
  }
  return out;
}

export const METRIC_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  consequential_actions:
    "Distinct durable logical actions in this environment. Demo environments and Failure Lab runs are excluded.",
  ambiguous_executions:
    "Distinct actions carrying active (non-superseded) transport_error or transport_only evidence — executions where the caller could not know what happened.",
  unsafe_retries_prevented_enforced:
    "Distinct actions where Nyst actually blocked a retry while controlling the action in Canary or Enforced mode. Shadow can never contribute.",
  unsafe_retries_detected_shadow:
    "Distinct Shadow evaluations where Enforced mode WOULD have blocked a retry. Nyst did not control the action; nothing was prevented.",
  unsafe_continuations_prevented_enforced:
    "Distinct actions where Nyst actually held an unsafe downstream continuation in Canary or Enforced mode.",
  unsafe_continuations_detected_shadow:
    "Distinct Shadow evaluations where Enforced mode WOULD have held a continuation. Counterfactual only.",
  auto_resolved:
    "Distinct actions whose ambiguity Nyst resolved automatically through completed authorized recovery, with no human involvement.",
  human_escalations:
    "Distinct actions Nyst escalated to durable human review because it could not proceed safely on its own.",
  median_reconciliation_duration_ms:
    "Median wall-clock milliseconds from intent creation to the current terminal resolution. Null until at least one action reaches a terminal state.",
  recent_interventions:
    "Durable intervention records. One logical intervention appears exactly once regardless of scheduler runs, repeated observations, webhook attempts, or page refreshes.",
  provider_breakdown: "Consequential actions grouped by external provider.",
  effect_breakdown: "Consequential actions grouped by EffectSpec.",
  agent_breakdown: "Consequential actions grouped by the Agent that caused them. Actions with no bound Agent are grouped under 'unattributed'.",
});

/** Zeroed contract used for an environment with no activity. Still fully typed. */
export function emptyMetrics(mode: EnvironmentMode, range: MetricRange): CanonicalMetrics {
  return {
    mode,
    range,
    consequential_actions: 0,
    ambiguous_executions: 0,
    unsafe_retries_prevented_enforced: 0,
    unsafe_retries_detected_shadow: 0,
    unsafe_continuations_prevented_enforced: 0,
    unsafe_continuations_detected_shadow: 0,
    auto_resolved: 0,
    human_escalations: 0,
    median_reconciliation_duration_ms: null,
    recent_interventions: [],
    provider_breakdown: {},
    effect_breakdown: {},
    agent_breakdown: {},
    metric_definitions: METRIC_DEFINITIONS,
  };
}

export function resolveRange(label: MetricRange["label"], from?: string, to?: string, now: Date = new Date()): MetricRange {
  const end = to ? new Date(to) : now;
  if (!Number.isFinite(end.getTime())) throw new Error("Invalid metric range end");
  if (label === "custom") {
    if (!from) throw new Error("A custom metric range requires an explicit start");
    const start = new Date(from);
    if (!Number.isFinite(start.getTime())) throw new Error("Invalid metric range start");
    if (start >= end) throw new Error("A metric range must start before it ends");
    const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
    if (spanDays > 366) throw new Error("A custom metric range is bounded to 366 days");
    return { from: start.toISOString(), to: end.toISOString(), label: "custom", sql_upper_bound: end.toISOString() };
  }
  if (label === "all") return { from: new Date(0).toISOString(), to: end.toISOString(), label: "all", sql_upper_bound: null };
  const hours = label === "24h" ? 24 : label === "7d" ? 24 * 7 : 24 * 30;
  return { from: new Date(end.getTime() - hours * 3_600_000).toISOString(), to: end.toISOString(), label, sql_upper_bound: null };
}
