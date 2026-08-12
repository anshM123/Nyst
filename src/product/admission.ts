/**
 * CONSEQUENCE ADMISSION — the single gate every new external consequence
 * passes through before it may BEGIN.
 *
 * Two independent guards are evaluated here, in ONE SQL statement:
 *
 *   EMERGENCY FREEZE   is this scope frozen right now?
 *   BLAST RADIUS       is this Agent executing too much consequence?
 *
 * Doing both in one statement is what makes them un-raceable. The statement
 * takes `FOR UPDATE` row locks on the applicable budgets, so concurrent
 * admissions against the same budget serialize instead of each reading a stale
 * count and both being admitted.
 *
 * LINEARIZATION BOUNDARY
 * ----------------------
 * A freeze becomes active the instant its row commits. Admission reads
 * committed freezes and writes the admission row in the same statement, so
 * there is no interval in which an action is admitted after the freeze is
 * visible. Actions already in flight are unaffected — freeze stops new
 * consequence beginning, it does not abort work already past this gate, and it
 * never stops read-only observation or reconciliation.
 *
 * MONEY
 * -----
 * Amounts arrive as integer minor units from structured EffectSpec semantics.
 * Nothing here parses currency out of free text. A budget with a monetary
 * limit applied to an action carrying no authoritative amount FAILS CLOSED.
 */
import { randomUUID } from "node:crypto";
import type { ProductDb } from "./productRepository.js";
import type { TenantScope } from "./types.js";

/**
 * A connection pool that can hand out one dedicated connection.
 *
 * Admission REQUIRES a real multi-statement transaction. Under PostgreSQL's
 * default READ COMMITTED isolation a single statement takes one snapshot: a
 * `FOR UPDATE` inside that statement does make concurrent callers queue, but
 * when the second caller unblocks, its budget-count subquery still reads the
 * pre-lock snapshot and therefore misses the admission the first caller just
 * committed. Both callers would see "0 used" and both be admitted.
 *
 * Taking the lock in one statement and counting in the NEXT statement of the
 * same transaction fixes it: in READ COMMITTED each statement takes a fresh
 * snapshot that includes everything committed before it began.
 */
export interface PooledClient extends ProductDb { release(): void }
export interface PoolLike extends ProductDb { connect(): Promise<PooledClient> }

function isPool(db: ProductDb): db is PoolLike {
  return typeof (db as { connect?: unknown }).connect === "function";
}

export interface AdmissionRequest {
  agent_id: string | null;
  effect_name: string;
  business_key: string;
  /** Authoritative integer minor units, or null when the effect has no amount. */
  amount_minor: number | null;
  /** ISO-4217 lowercase, required whenever amount_minor is present. */
  currency: string | null;
}

export interface AdmissionDecision {
  admitted: boolean;
  blocked_by: "freeze" | "blast_radius" | null;
  freeze_id: string | null;
  budget_id: string | null;
  limit_kind: "action_count" | "amount_per_action" | "amount_per_window" | null;
  observed_value: number | null;
  limit_value: number | null;
  window_seconds: number | null;
  reason: string;
  admission_id: string;
}

export class ConsequenceBlockedError extends Error {
  readonly statusCode = 409;
  readonly decision: AdmissionDecision;
  constructor(decision: AdmissionDecision) { super(decision.reason); this.name = "ConsequenceBlockedError"; this.decision = decision; }
}

/**
 * Decide whether one consequence may begin, and durably record the decision.
 *
 * Returns the decision rather than throwing so callers can persist an
 * intervention and open a Human Review before surfacing the refusal.
 */
const ADMISSION_SQL = `
    WITH active_freeze AS (
      SELECT freeze_id FROM nyst_freezes
      WHERE environment_id=$1 AND released_at IS NULL
        AND (scope_agent_id IS NULL OR scope_agent_id=$4::uuid)
        AND (scope_effect_name IS NULL OR scope_effect_name=$5::text)
      ORDER BY activated_at, freeze_id LIMIT 1
    ), applicable AS (
      -- FOR UPDATE serializes concurrent admissions against the same budget,
      -- which is what makes the counters correct under 2/10/100 concurrency.
      SELECT * FROM nyst_blast_radius_budgets
      WHERE environment_id=$1 AND enabled
        AND (agent_id IS NULL OR agent_id=$4::uuid)
        AND (effect_name IS NULL OR effect_name=$5::text)
      ORDER BY budget_id
      FOR UPDATE
    ), evaluated AS (
      -- Counted from the admission ledger, which the SAME statement writes
      -- under the SAME budget lock. Reading one table and writing another
      -- would let two concurrent admissions each see a stale total.
      SELECT b.*,
        (SELECT count(*) FROM nyst_consequence_admissions ca
           WHERE ca.environment_id=b.environment_id AND ca.admitted
             AND (b.agent_id IS NULL OR ca.agent_id=b.agent_id)
             AND (b.effect_name IS NULL OR ca.effect_name=b.effect_name)
             AND ca.decided_at > now() - make_interval(secs => b.window_seconds)) used_actions,
        (SELECT coalesce(sum(ca.amount_minor),0) FROM nyst_consequence_admissions ca
           WHERE ca.environment_id=b.environment_id AND ca.admitted
             AND (b.agent_id IS NULL OR ca.agent_id=b.agent_id)
             AND (b.effect_name IS NULL OR ca.effect_name=b.effect_name)
             AND ca.decided_at > now() - make_interval(secs => b.window_seconds)) used_amount
      FROM applicable b
    ), violations AS (
      SELECT budget_id, 'action_count'::text kind, (used_actions + 1)::bigint observed, max_actions_per_window::bigint lim, window_seconds,
             'The consequence budget of ' || max_actions_per_window || ' actions per ' || window_seconds || 's is exhausted.' reason
        FROM evaluated WHERE max_actions_per_window IS NOT NULL AND used_actions + 1 > max_actions_per_window
      UNION ALL
      -- Fail closed: a monetary limit cannot be evaluated without an
      -- authoritative amount, so the consequence is held rather than admitted.
      SELECT budget_id, 'amount_per_action'::text, NULL::bigint, max_amount_minor_per_action::bigint, window_seconds,
             'This effect carries no authoritative amount, so a monetary consequence budget cannot be evaluated.'
        FROM evaluated WHERE max_amount_minor_per_action IS NOT NULL AND $6::bigint IS NULL
      UNION ALL
      SELECT budget_id, 'amount_per_action'::text, $6::bigint, max_amount_minor_per_action::bigint, window_seconds,
             'The single-action amount exceeds the configured maximum.'
        FROM evaluated WHERE max_amount_minor_per_action IS NOT NULL AND $6::bigint IS NOT NULL AND $6::bigint > max_amount_minor_per_action
      UNION ALL
      SELECT budget_id, 'amount_per_action'::text, $6::bigint, max_amount_minor_per_action::bigint, window_seconds,
             'The action currency does not match the currency this consequence budget is denominated in.'
        FROM evaluated WHERE currency IS NOT NULL AND $7::text IS NOT NULL AND currency <> $7::text
      UNION ALL
      SELECT budget_id, 'amount_per_window'::text, (used_amount + coalesce($6::bigint,0)), max_amount_minor_per_window::bigint, window_seconds,
             'The aggregate amount budget for this window is exhausted.'
        FROM evaluated WHERE max_amount_minor_per_window IS NOT NULL AND used_amount + coalesce($6::bigint,0) > max_amount_minor_per_window
    ), verdict AS (
      SELECT
        (SELECT freeze_id FROM active_freeze) frozen_by,
        (SELECT budget_id FROM violations LIMIT 1) violated_budget,
        (SELECT kind FROM violations LIMIT 1) violated_kind,
        (SELECT observed FROM violations LIMIT 1) violated_observed,
        (SELECT lim FROM violations LIMIT 1) violated_limit,
        (SELECT window_seconds FROM violations LIMIT 1) violated_window,
        (SELECT reason FROM violations LIMIT 1) violated_reason
    ), admission AS (
      INSERT INTO nyst_consequence_admissions(admission_id,environment_id,project_id,organization_id,agent_id,effect_name,business_key,amount_minor,currency,admitted,blocked_by,freeze_id,budget_id,reason)
      SELECT $9::uuid,$1,$2,$3,$4::uuid,$5,$8,$6::bigint,$7,
        v.frozen_by IS NULL AND v.violated_budget IS NULL,
        CASE WHEN v.frozen_by IS NOT NULL THEN 'freeze' WHEN v.violated_budget IS NOT NULL THEN 'blast_radius' ELSE NULL END,
        v.frozen_by, v.violated_budget,
        CASE WHEN v.frozen_by IS NOT NULL
               THEN 'A durable Emergency Freeze covering this scope is active; no new consequential provider mutation may begin.'
             WHEN v.violated_budget IS NOT NULL THEN v.violated_reason
             ELSE 'Admitted: no active freeze covers this scope and every applicable consequence budget has headroom.' END
      FROM verdict v
      ON CONFLICT(environment_id,effect_name,business_key) DO NOTHING
      RETURNING admission_id,admitted,blocked_by,freeze_id,budget_id,reason
    ), logged AS (
      INSERT INTO nyst_blast_radius_decisions(decision_id,budget_id,environment_id,project_id,organization_id,agent_id,effect_name,decision,limit_kind,observed_value,limit_value,window_seconds,business_key,reason)
      SELECT $10::uuid, coalesce(v.violated_budget,(SELECT budget_id FROM evaluated ORDER BY budget_id LIMIT 1)), $1,$2,$3,$4::uuid,$5,
        CASE WHEN a.admitted THEN 'admitted' ELSE 'held' END,
        v.violated_kind, v.violated_observed, v.violated_limit, v.violated_window, $8, a.reason
      FROM verdict v, admission a
      WHERE EXISTS(SELECT 1 FROM evaluated) OR NOT a.admitted
      RETURNING decision_id
    )
    SELECT a.admission_id,a.admitted,a.blocked_by,a.freeze_id,a.budget_id,a.reason,
      v.violated_kind,v.violated_observed,v.violated_limit,v.violated_window
    FROM admission a, verdict v`;

/**
 * Cross the environment authority boundary.
 *
 * Every operation that decides whether consequence may begin — admission,
 * freeze activation, freeze release — calls this FIRST, inside its own
 * transaction. The lock is released by COMMIT or ROLLBACK.
 *
 * The row is normally created by a trigger when the environment is created and
 * backfilled by migration 0018. The insert here is a belt-and-braces path for
 * an environment that predates both, so a missing guard row can never silently
 * mean "no guard".
 */
export async function lockEnvironmentAuthority(
  client: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  scope: TenantScope,
): Promise<void> {
  const locked = await client.query(
    `SELECT environment_id FROM nyst_environment_authority WHERE environment_id=$1 FOR UPDATE`,
    [scope.environment_id]);
  if (locked.rows.length) return;
  await client.query(
    `INSERT INTO nyst_environment_authority(environment_id,project_id,organization_id)
     VALUES($1,$2,$3) ON CONFLICT (environment_id) DO NOTHING`,
    [scope.environment_id, scope.project_id, scope.organization_id]);
  const retried = await client.query(
    `SELECT environment_id FROM nyst_environment_authority WHERE environment_id=$1 FOR UPDATE`,
    [scope.environment_id]);
  if (!retried.rows.length) {
    // The environment does not exist. Refusing here is correct: without a
    // durable authority boundary there is nothing to serialize against, and
    // proceeding would silently drop the guarantee this function exists for.
    throw new Error("No environment authority boundary exists for this scope; consequence cannot be admitted");
  }
}

export async function admitConsequence(db: ProductDb, scope: TenantScope, request: AdmissionRequest): Promise<AdmissionDecision> {
  if (request.amount_minor !== null && (!Number.isInteger(request.amount_minor) || request.amount_minor < 0)) {
    throw new Error("A blast-radius amount must be an integer number of minor units");
  }
  if (request.amount_minor !== null && !request.currency) {
    throw new Error("An authoritative amount requires its currency");
  }

  if (!isPool(db)) {
    throw new Error(
      "Consequence admission requires a connection pool that can open a transaction. " +
      "Blast Radius counters cannot be made concurrency-safe on a single-statement interface.",
    );
  }

  const client = await db.connect();
  let result: { rows: Record<string, unknown>[] };
  try {
    await client.query("BEGIN");
    // STATEMENT 0 — cross the environment authority boundary.
    //
    // Emergency Freeze activation and release take this same row lock. Before
    // it existed, admission and freeze shared nothing: admission read
    // committed freezes on a fresh snapshot, and freeze was a bare INSERT that
    // waited for no one. That is probably correct for most interleavings, but
    // "probably, because of snapshot timing" is not a safety property — and it
    // left a window in which a freeze could report durable success to an
    // operator while an admission whose snapshot predated it was still about
    // to commit.
    //
    // With the shared guard the three operations have one total order per
    // environment: whichever crosses first completes first, and the other
    // waits and then observes the result. It is also now provable with a
    // barrier test instead of a sleep.
    await lockEnvironmentAuthority(client, scope);

    // STATEMENT 1 — take the budget row locks. Concurrent admissions against
    // the same budget queue here.
    await client.query(
      `SELECT budget_id FROM nyst_blast_radius_budgets
       WHERE environment_id=$1 AND enabled
         AND (agent_id IS NULL OR agent_id=$2::uuid)
         AND (effect_name IS NULL OR effect_name=$3::text)
       ORDER BY budget_id FOR UPDATE`,
      [scope.environment_id, request.agent_id, request.effect_name]);

    // STATEMENT 2 — a NEW snapshot, taken after the lock was granted, so it
    // sees every admission committed by whoever we queued behind.
    const params = [
      scope.environment_id, scope.project_id, scope.organization_id,
      request.agent_id, request.effect_name, request.amount_minor, request.currency,
      request.business_key, randomUUID(), randomUUID(),
    ];
    result = await client.query(ADMISSION_SQL, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const row = result.rows[0];
  if (!row) {
    // ON CONFLICT DO NOTHING: this logical action was already decided. Replay
    // the original decision rather than deciding twice.
    const previous = (await db.query(
      `SELECT admission_id,admitted,blocked_by,freeze_id,budget_id,reason FROM nyst_consequence_admissions
       WHERE environment_id=$1 AND effect_name=$2 AND business_key=$3`,
      [scope.environment_id, request.effect_name, request.business_key])).rows[0];
    if (!previous) throw new Error("Consequence admission could not be recorded");
    return {
      admitted: previous.admitted === true,
      blocked_by: (previous.blocked_by as AdmissionDecision["blocked_by"]) ?? null,
      freeze_id: previous.freeze_id ? String(previous.freeze_id) : null,
      budget_id: previous.budget_id ? String(previous.budget_id) : null,
      limit_kind: null, observed_value: null, limit_value: null, window_seconds: null,
      reason: String(previous.reason), admission_id: String(previous.admission_id),
    };
  }

  return {
    admitted: row.admitted === true,
    blocked_by: (row.blocked_by as AdmissionDecision["blocked_by"]) ?? null,
    freeze_id: row.freeze_id ? String(row.freeze_id) : null,
    budget_id: row.budget_id ? String(row.budget_id) : null,
    limit_kind: (row.violated_kind as AdmissionDecision["limit_kind"]) ?? null,
    observed_value: row.violated_observed === null || row.violated_observed === undefined ? null : Number(row.violated_observed),
    limit_value: row.violated_limit === null || row.violated_limit === undefined ? null : Number(row.violated_limit),
    window_seconds: row.violated_window === null || row.violated_window === undefined ? null : Number(row.violated_window),
    reason: String(row.reason),
    admission_id: String(row.admission_id),
  };
}

/**
 * Attach the durable action to its admission record.
 *
 * The admission row IS the consumption ledger; this only back-fills the
 * action id once the intent exists, so an operator can trace a budget
 * decision to the action it governed.
 */
export async function linkAdmissionToAction(db: ProductDb, admissionId: string, actionId: string): Promise<void> {
  await db.query(`UPDATE nyst_consequence_admissions SET action_id=$2 WHERE admission_id=$1 AND action_id IS NULL`, [admissionId, actionId]);
}
