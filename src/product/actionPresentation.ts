import type { EffectState } from "../model/effectState.js";
import type { OutcomeResolution } from "../model/resolution.js";

export interface ResolutionView {
  document: OutcomeResolution;
  resolution_id: string;
  resolution_sequence: number;
  resolved_at: string;
  effect_state: EffectState;
  primary_directive: OutcomeResolution["control"]["primary"];
  retry_disposition: OutcomeResolution["control"]["retry"];
  continuation_disposition: OutcomeResolution["control"]["continuation"];
  recovery_disposition: OutcomeResolution["control"]["recovery"];
  reason_code: string;
  explanation: string;
}

export interface ExplanationFact {
  evidence_id: string;
  sequence: number;
  source: string;
  fact: string;
  attribution: string;
  strength: string;
}

export interface ActionExplanation {
  generated_from: "current_resolution_cited_active_evidence";
  effect_name: string;
  effect_state: EffectState;
  decision: OutcomeResolution["control"]["primary"];
  facts: ExplanationFact[];
  attribution_note: string | null;
  therefore: {
    retry: OutcomeResolution["control"]["retry"];
    continuation: OutcomeResolution["control"]["continuation"];
    recovery: OutcomeResolution["control"]["recovery"];
  };
}

export function resolutionView(value: unknown): ResolutionView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const document = value as OutcomeResolution;
  if (!document.effect || !document.control || !document.trust || typeof document.resolution_id !== "string") return null;
  return {
    document,
    resolution_id: document.resolution_id,
    resolution_sequence: document.runtime?.resolution_sequence ?? 0,
    resolved_at: document.trust.resolved_at,
    effect_state: document.effect.state,
    primary_directive: document.control.primary,
    retry_disposition: document.control.retry,
    continuation_disposition: document.control.continuation,
    recovery_disposition: document.control.recovery,
    reason_code: document.control.reason_code,
    explanation: document.control.explanation,
  };
}

/** Current means greatest durable logical sequence, never array position or wall-clock time. */
export function latestResolution(values: readonly unknown[]): ResolutionView | null {
  let latest: ResolutionView | null = null;
  for (const value of values) {
    const candidate = resolutionView(value);
    if (!candidate) continue;
    if (!latest || candidate.resolution_sequence > latest.resolution_sequence ||
      (candidate.resolution_sequence === latest.resolution_sequence && candidate.resolution_id > latest.resolution_id)) latest = candidate;
  }
  return latest;
}

export function resolutionHistory(values: readonly unknown[]): ResolutionView[] {
  return values.map(resolutionView).filter((value): value is ResolutionView => value !== null)
    .sort((a, b) => b.resolution_sequence - a.resolution_sequence || b.resolution_id.localeCompare(a.resolution_id));
}

export function currentExplanation(action: Record<string, unknown>, evidence: readonly Record<string, unknown>[], current: ResolutionView): ActionExplanation {
  const superseded = new Set(evidence.map(item => item.supersedes_evidence_id).filter((id): id is string => typeof id === "string"));
  const cited = new Set(current.document.effect.evidence_refs);
  const maximumSequence = current.document.runtime?.evidence_sequence ?? Number.MAX_SAFE_INTEGER;
  const facts = evidence.filter(item => {
    const id = String(item.evidence_id ?? "");
    return cited.has(id) && !superseded.has(id) && Number(item.seq ?? 0) <= maximumSequence;
  }).sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0)).map(item => ({
    evidence_id: String(item.evidence_id),
    sequence: Number(item.seq ?? 0),
    source: String(item.source ?? "unknown"),
    fact: String(item.observed_disposition ?? item.kind ?? "observation"),
    attribution: String(item.attribution ?? "indeterminate"),
    strength: String(item.strength ?? "unknown"),
  }));
  const lacksAttribution = current.effect_state === "satisfied_unattributed" || facts.some(fact => fact.attribution !== "attributed");
  return {
    generated_from: "current_resolution_cited_active_evidence",
    effect_name: String(action.effect_name ?? current.document.effect_name),
    effect_state: current.effect_state,
    decision: current.primary_directive,
    facts,
    attribution_note: lacksAttribution ? "The observed state is not attributable to this exact Nyst action." : null,
    therefore: {
      retry: current.retry_disposition,
      continuation: current.continuation_disposition,
      recovery: current.recovery_disposition,
    },
  };
}
