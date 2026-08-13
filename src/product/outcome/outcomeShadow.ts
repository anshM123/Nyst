/**
 * OUTCOME SHADOW.
 *
 * The customer changes nothing. Their Agent keeps running exactly as it does
 * today, keeps deciding for itself when a workflow is finished, and keeps
 * being wrong occasionally. Nyst watches, evaluates the outcome independently,
 * and reports the gap.
 *
 * The finding this exists to produce:
 *
 *     Your Agent considered this offboarding complete at 14:02:11.
 *     Inherited GitHub production access remained until 14:16:34.
 *     That is 14 minutes 23 seconds of production access after the offboarding
 *     was recorded as done.
 *
 * THE LANGUAGE RULE IS ABSOLUTE.
 *
 * Nyst prevented nothing in Shadow. It was not in the path, it held nothing,
 * it blocked nothing. Every sentence this module produces is in the
 * counterfactual voice — DETECTED, OBSERVED, WOULD HAVE BLOCKED — and
 * `assertShadowLanguage` below is called on every finding before it is stored,
 * so a future edit that reaches for "prevented" fails loudly rather than
 * shipping a claim the product cannot support.
 */
import { randomUUID } from "node:crypto";
import type { ProductDb } from "../productRepository.js";
import type { TenantScope } from "../types.js";
import type { OutcomeVerdict } from "./invariantEngine.js";
import type { OutcomeRepository } from "./outcomeRepository.js";

export type ShadowFindingKind =
  | "declared_complete_too_early"
  | "unsafe_continuation_opportunity"
  | "temporarily_indeterminate"
  | "established_later"
  | "human_review_opportunity";

export const SHADOW_FINDING_DEFINITIONS: Readonly<Record<ShadowFindingKind, string>> = Object.freeze({
  declared_complete_too_early:
    "The Agent declared this workflow complete while a required condition was still false. Nyst did not stop anything; it observed the gap.",
  unsafe_continuation_opportunity:
    "A dependent consequence could have proceeded while the outcome was not established. In Enforced, Nyst would have held it.",
  temporarily_indeterminate:
    "Nyst could not establish the outcome for a period. It does not know what was true during that window, and says so.",
  established_later:
    "The outcome became true on its own after the Agent declared completion. Nothing Nyst did caused that.",
  human_review_opportunity:
    "In Enforced, Nyst would have asked a person before proceeding here.",
});

/**
 * Words Shadow may never use about itself.
 *
 * "Prevented", "blocked" and "stopped" are claims about having been in the
 * path. In Shadow, Nyst was not. Selling on a verb the product did not earn is
 * the fastest way to lose a customer's trust in every other number.
 */
const FORBIDDEN_SHADOW_CLAIMS = /\b(prevented|prevents|blocked|stopped|protected|we stopped|nyst stopped)\b/i;

/** Phrasing Shadow uses instead. Kept here so the vocabulary is one list. */
export const SHADOW_VOCABULARY = Object.freeze({
  detected: "detected", observed: "observed", would_have_blocked: "would have blocked",
  would_have_held: "would have held", would_have_asked: "would have asked a person",
});

export function assertShadowLanguage(finding: string): void {
  if (FORBIDDEN_SHADOW_CLAIMS.test(finding)) {
    throw new Error(
      `A Shadow finding may not claim Nyst prevented or blocked anything: ${finding}. ` +
      `Shadow was not in the path. Use "detected", "observed" or "would have blocked".`,
    );
  }
}

export interface ShadowMetrics {
  /** Every outcome Nyst evaluated in Shadow. */
  outcomes_observed: number;
  /** Outcomes Nyst could not establish for some period. */
  outcomes_temporarily_indeterminate: number;
  /** The headline: the Agent said done, and it was not. */
  outcomes_agent_declared_complete_too_early: number;
  /** Dependent consequences that could have proceeded on a false outcome. */
  unsafe_continuation_opportunities: number;
  /** Total seconds outcomes spent not established after being declared done. */
  total_exposure_seconds: number;
  /** The longest single exposure window, which is the one that gets quoted. */
  longest_exposure_seconds: number;
  /** Outcomes that became true later, with no help from Nyst. */
  automatically_established_later: number;
  /** Points at which Enforced would have asked a person. */
  human_review_opportunities: number;
  /** Every number above is counterfactual. Stated in the payload, not implied. */
  language: "detected";
  disclaimer: string;
}

export interface ShadowFinding {
  shadow_finding_id: string;
  outcome_instance_id: string;
  kind: ShadowFindingKind;
  invariant_id: string | null;
  finding: string;
  observed_from: string;
  observed_until: string | null;
  exposure_seconds: number | null;
}

export class OutcomeShadow {
  constructor(private readonly db: ProductDb, private readonly outcomes: OutcomeRepository) {}

  /**
   * Record an Agent's claim that it is finished, and evaluate the outcome
   * independently at that instant.
   *
   * If the outcome is not SATISFIED when the Agent says it is done, that is
   * the finding. The exposure window opens here and closes when the outcome
   * actually becomes satisfied — measured, never estimated.
   */
  async recordCompletionSignal(scope: TenantScope, input: {
    outcome_instance_id: string;
    agent_id?: string | null;
    declared_status: "complete" | "failed" | "abandoned";
    declared_at?: Date;
    held_capabilities?: readonly string[];
    now?: Date;
  }): Promise<{ signal: Record<string, unknown>; verdict: OutcomeVerdict; finding: ShadowFinding | null }> {
    const now = input.now ?? new Date();
    const declaredAt = input.declared_at ?? now;

    // Evaluate independently. The Agent's opinion is an input to the record,
    // never an input to the verdict.
    const { instance, evaluation } = await this.outcomes.evaluate(scope, input.outcome_instance_id, {
      held_capabilities: input.held_capabilities ?? [], now,
    });

    const signal = (await this.db.query(
      `INSERT INTO nyst_agent_completion_signals(completion_signal_id,organization_id,project_id,environment_id,
         outcome_instance_id,agent_id,declared_status,declared_at,verdict_at_signal,detail)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING completion_signal_id,declared_status,declared_at,verdict_at_signal,received_at`,
      [randomUUID(), scope.organization_id, scope.project_id, scope.environment_id,
        input.outcome_instance_id, input.agent_id ?? null, input.declared_status,
        declaredAt.toISOString(), evaluation.verdict,
        JSON.stringify({ primary_reason: evaluation.primary_reason, coverage: evaluation.coverage })])).rows[0]!;

    if (input.declared_status !== "complete" || evaluation.verdict === "satisfied") {
      return { signal, verdict: evaluation.verdict, finding: null };
    }

    // The gap. Name the exact invariant, in the counterfactual voice.
    const violated = evaluation.required.find((item) => item.result === "false")
      ?? evaluation.required.find((item) => item.result === "indeterminate");
    const kind: ShadowFindingKind = evaluation.verdict === "unsatisfied"
      ? "declared_complete_too_early" : "temporarily_indeterminate";
    const text = evaluation.verdict === "unsatisfied"
      ? `The Agent declared this workflow complete at ${declaredAt.toISOString()}. Nyst independently observed that a required condition was still false: ${violated?.reason ?? "a required invariant did not hold"} In Enforced, Nyst would have held any dependent consequence here.`
      : `The Agent declared this workflow complete at ${declaredAt.toISOString()}. Nyst could not establish the outcome: ${violated?.reason ?? "a required invariant could not be evaluated"} In Enforced, Nyst would have asked a person rather than proceeding.`;

    const finding = await this.openFinding(scope, {
      outcome_instance_id: input.outcome_instance_id,
      completion_signal_id: String(signal.completion_signal_id),
      kind, invariant_id: violated?.invariant_id ?? null, finding: text,
      observed_from: declaredAt,
      detail: { verdict: evaluation.verdict, coverage: evaluation.coverage },
    });

    // A dependent consequence could have run here. Record that separately: it
    // is a different sales fact from "the workflow finished early".
    if (evaluation.verdict === "unsatisfied") {
      await this.openFinding(scope, {
        outcome_instance_id: input.outcome_instance_id,
        completion_signal_id: String(signal.completion_signal_id),
        kind: "unsafe_continuation_opportunity", invariant_id: violated?.invariant_id ?? null,
        finding: `A dependent consequence could have proceeded at ${declaredAt.toISOString()} on an outcome Nyst observed to be false. In Enforced, Nyst would have held it. Nyst was not in the path here and held nothing.`,
        observed_from: declaredAt, detail: {},
      }).catch(() => null); // A window of this kind may already be open.
    }

    void instance;
    return { signal, verdict: evaluation.verdict, finding };
  }

  /**
   * Close every open exposure window for an outcome that has become SATISFIED.
   *
   * The duration is MEASURED: from when the Agent declared completion to when
   * Nyst actually observed the outcome hold. Nyst never estimates it, and
   * never closes a window on an outcome that is not satisfied.
   */
  async closeExposure(scope: TenantScope, instanceId: string, establishedAt?: Date): Promise<number> {
    const instance = await this.outcomes.instance(scope, instanceId);
    if (!instance || instance.verdict !== "satisfied") return 0;

    // WHEN THE WORLD CHANGED, not when Nyst wrote a row.
    //
    // The caller passes the observation that established the outcome, because
    // "access remained until 14:16:34" is a statement about the world. Falling
    // back to the instance's satisfied_at is correct but coarser: it is when
    // Nyst first CONCLUDED the outcome held, which can be later than when it
    // became true.
    const closedAt = establishedAt ?? (instance.satisfied_at ? new Date(instance.satisfied_at) : new Date());

    const closed = await this.db.query(
      `UPDATE nyst_outcome_shadow_findings
         -- GREATEST guards against clock skew between the application and the
         -- database producing a window that ends before it begins. A skewed
         -- measurement becomes zero rather than a negative claim.
         SET observed_until=GREATEST(observed_from, $3::timestamptz),
             exposure_seconds=GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($3::timestamptz - observed_from)))::int)
       WHERE outcome_instance_id=$1 AND environment_id=$2 AND observed_until IS NULL
       RETURNING shadow_finding_id,exposure_seconds`,
      [instanceId, scope.environment_id, closedAt.toISOString()]);

    if (closed.rows.length) {
      const longest = Math.max(...closed.rows.map((row) => Number(row.exposure_seconds)));
      await this.openFinding(scope, {
        outcome_instance_id: instanceId, completion_signal_id: null,
        kind: "established_later", invariant_id: null,
        finding: `Nyst observed this outcome become established at ${closedAt.toISOString()}, ${humanDuration(longest)} after the Agent declared the workflow complete. Nothing Nyst did caused that; Shadow observes only.`,
        observed_from: closedAt, detail: { exposure_seconds: longest },
      }).catch(() => null);
    }
    return closed.rows.length;
  }

  private async openFinding(scope: TenantScope, input: {
    outcome_instance_id: string; completion_signal_id: string | null;
    kind: ShadowFindingKind; invariant_id: string | null; finding: string;
    observed_from: Date; detail: Record<string, unknown>;
  }): Promise<ShadowFinding> {
    // Checked before the write, every time. A finding that claims prevention
    // must never reach the database, let alone a slide.
    assertShadowLanguage(input.finding);
    const row = (await this.db.query(
      `INSERT INTO nyst_outcome_shadow_findings(shadow_finding_id,organization_id,project_id,environment_id,
         outcome_instance_id,completion_signal_id,kind,invariant_id,finding,observed_from,detail)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING shadow_finding_id,outcome_instance_id,kind,invariant_id,finding,observed_from,observed_until,exposure_seconds`,
      [randomUUID(), scope.organization_id, scope.project_id, scope.environment_id,
        input.outcome_instance_id, input.completion_signal_id, input.kind, input.invariant_id,
        input.finding, input.observed_from.toISOString(), JSON.stringify(input.detail)])).rows[0]!;
    return hydrateFinding(row);
  }

  async findings(scope: TenantScope, limit = 50): Promise<ShadowFinding[]> {
    return (await this.db.query(
      `SELECT shadow_finding_id,outcome_instance_id,kind,invariant_id,finding,observed_from,observed_until,exposure_seconds
       FROM nyst_outcome_shadow_findings WHERE environment_id=$1 AND organization_id=$2
       ORDER BY created_at DESC LIMIT $3`,
      [scope.environment_id, scope.organization_id, Math.min(Math.max(1, limit), 200)])).rows.map(hydrateFinding);
  }

  /** The Shadow report. Every number counterfactual, and labelled as such. */
  async metrics(scope: TenantScope): Promise<ShadowMetrics> {
    const row = (await this.db.query(
      `SELECT
         (SELECT count(*)::int FROM nyst_outcome_instances WHERE environment_id=$1 AND mode='shadow') observed,
         (SELECT count(DISTINCT outcome_instance_id)::int FROM nyst_outcome_shadow_findings
           WHERE environment_id=$1 AND kind='temporarily_indeterminate') indeterminate,
         (SELECT count(*)::int FROM nyst_outcome_shadow_findings
           WHERE environment_id=$1 AND kind='declared_complete_too_early') too_early,
         (SELECT count(*)::int FROM nyst_outcome_shadow_findings
           WHERE environment_id=$1 AND kind='unsafe_continuation_opportunity') unsafe_continuation,
         (SELECT coalesce(sum(exposure_seconds),0)::int FROM nyst_outcome_shadow_findings
           WHERE environment_id=$1 AND kind='declared_complete_too_early') total_exposure,
         (SELECT coalesce(max(exposure_seconds),0)::int FROM nyst_outcome_shadow_findings
           WHERE environment_id=$1 AND kind='declared_complete_too_early') longest_exposure,
         (SELECT count(*)::int FROM nyst_outcome_shadow_findings
           WHERE environment_id=$1 AND kind='established_later') established_later,
         (SELECT count(*)::int FROM nyst_outcome_shadow_findings
           WHERE environment_id=$1 AND kind IN ('human_review_opportunity','temporarily_indeterminate')) review_opportunities`,
      [scope.environment_id])).rows[0]!;

    return {
      outcomes_observed: Number(row.observed),
      outcomes_temporarily_indeterminate: Number(row.indeterminate),
      outcomes_agent_declared_complete_too_early: Number(row.too_early),
      unsafe_continuation_opportunities: Number(row.unsafe_continuation),
      total_exposure_seconds: Number(row.total_exposure),
      longest_exposure_seconds: Number(row.longest_exposure),
      automatically_established_later: Number(row.established_later),
      human_review_opportunities: Number(row.review_opportunities),
      language: "detected",
      disclaimer:
        "Nyst was not in the path for any of these. It controlled nothing, held nothing and prevented nothing. Every number above is what Nyst OBSERVED, and what it WOULD HAVE done in Enforced.",
    };
  }

  /** The one sentence a salesperson reads out loud, or null when there isn't one. */
  async headline(scope: TenantScope): Promise<string | null> {
    const row = (await this.db.query(
      `SELECT f.finding, f.exposure_seconds, i.subject
       FROM nyst_outcome_shadow_findings f JOIN nyst_outcome_instances i USING(outcome_instance_id)
       WHERE f.environment_id=$1 AND f.kind='declared_complete_too_early' AND f.exposure_seconds IS NOT NULL
       ORDER BY f.exposure_seconds DESC LIMIT 1`,
      [scope.environment_id])).rows[0];
    if (!row) return null;
    const subject = row.subject as Record<string, unknown>;
    const who = String(subject.person_email ?? subject.subject ?? "this subject");
    return `Your Agent considered this workflow complete for ${who}, and Nyst observed that the required condition remained false for ${humanDuration(Number(row.exposure_seconds))} afterwards.`;
  }
}

function hydrateFinding(row: Record<string, unknown>): ShadowFinding {
  return {
    shadow_finding_id: String(row.shadow_finding_id),
    outcome_instance_id: String(row.outcome_instance_id),
    kind: row.kind as ShadowFindingKind,
    invariant_id: row.invariant_id ? String(row.invariant_id) : null,
    finding: String(row.finding),
    observed_from: new Date(String(row.observed_from)).toISOString(),
    observed_until: row.observed_until ? new Date(String(row.observed_until)).toISOString() : null,
    exposure_seconds: row.exposure_seconds === null || row.exposure_seconds === undefined ? null : Number(row.exposure_seconds),
  };
}

/** "14m 23s". Exact, never rounded up into something more dramatic. */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
