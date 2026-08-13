/**
 * THE UNIFIED WORKER LEASE MODEL.
 *
 * Nyst runs six kinds of background worker. They must share one vocabulary,
 * because an operator debugging a stuck job at 3am should not have to learn
 * six of them, and because a subtle difference between two of them is exactly
 * where a duplicate external consequence hides.
 *
 * THE SHARED CONCEPTS
 *
 *   claim_token     the identity of the CURRENT owner of one unit of work
 *   claimed_at      when that ownership began
 *   claimed_until   when it lapses, ALWAYS in database time
 *   attempt         how many times ownership has been taken
 *   status          where the unit of work is in its own lifecycle
 *
 * Two rules are absolute:
 *
 *   STALE-TOKEN REJECTION. Every write a worker makes is conditioned on its
 *   own claim token still being the current one. A worker that pauses, has its
 *   lease expire, and wakes up cannot complete, fail, or advance anything.
 *   Its writes simply do not match.
 *
 *   DATABASE TIME. Lease expiry is decided by the database clock, never by the
 *   worker's. A worker whose host clock jumps backwards a day does not thereby
 *   extend its own lease; a worker whose clock jumps forward does not steal
 *   anyone else's. Application clocks remain injectable for POLICY deadlines,
 *   which are semantic, and for Outcome deadlines, which must be deterministic
 *   in tests — but never for ownership.
 *
 * WHERE THEY DIFFER: RECLAIM
 *
 * Reclaim is NOT uniform, and pretending it were would be the dangerous
 * simplification. What a second worker may do with abandoned work depends
 * entirely on whether the first worker may have caused an external effect.
 *
 *   read_only          reconciliation, re-observation, outcome evaluation.
 *                      Nothing external happened. Reclaim freely; the worst
 *                      case is duplicated reading.
 *
 *   logical_identity   webhook delivery. Delivery is at-least-once by design
 *                      and the receiver deduplicates on a stable logical event
 *                      id, so reclaim is safe as long as that identity is
 *                      preserved across attempts.
 *
 *   consequence_aware  recovery. The reclaiming worker may only act on the
 *                      durable DISPATCH BOUNDARY, never on the lease. An
 *                      expired lease says nothing about whether a provider was
 *                      contacted. Only `definitely_not_sent` permits a send;
 *                      anything else means observe, never resend.
 *
 * This file is the declaration. The audit test asserts that every worker's SQL
 * actually obeys the class it claims.
 */

/** How a second worker may treat work abandoned by a first. */
export type ReclaimClass = "read_only" | "logical_identity" | "consequence_aware";

export interface WorkerLeaseContract {
  /** Stable identifier used in logs, metrics and the operational health page. */
  worker: string;
  /** The table whose rows carry the lease. */
  table: string;
  /** The column holding the current owner's token. */
  token_column: string;
  /** The column holding the lease expiry, in database time. */
  until_column: string;
  reclaim: ReclaimClass;
  /** Why this reclaim class is the correct one for this worker. */
  rationale: string;
  /**
   * True when a reclaiming worker may cause an external effect the previous
   * worker might already have caused. Exactly one worker may set this, and it
   * must gate on a durable dispatch boundary rather than on the lease.
   */
  may_cause_external_effect: boolean;
}

/**
 * Every worker in Nyst, with the lease discipline it is required to follow.
 *
 * Adding a worker means adding an entry here. The audit test fails if a claim
 * query exists for a table that is not declared, which is the point: a new
 * background worker must state its reclaim semantics before it may run.
 */
export const WORKER_LEASES: readonly WorkerLeaseContract[] = Object.freeze([
  Object.freeze({
    worker: "reconciliation", table: "nyst_reconciliation_jobs",
    token_column: "claim_token", until_column: "claimed_until", reclaim: "read_only" as const,
    rationale: "Reconciliation only READS external truth and writes Nyst's own evidence. A duplicated read costs a provider call and nothing else.",
    may_cause_external_effect: false,
  }),
  Object.freeze({
    worker: "reobservation", table: "nyst_reobservation_jobs",
    token_column: "claim_token", until_column: "claimed_until", reclaim: "read_only" as const,
    rationale: "Re-observation is a read a human asked for. It cannot change the world, so a second worker repeating it is safe.",
    may_cause_external_effect: false,
  }),
  Object.freeze({
    worker: "outcome_evaluation", table: "nyst_outcome_evaluations",
    token_column: "claim_token", until_column: "claimed_until", reclaim: "read_only" as const,
    rationale: "Outcome evaluation is a pure computation over already-durable facts. Reclaim is safe; completion is fenced so a stale evaluator cannot overwrite a newer verdict.",
    may_cause_external_effect: false,
  }),
  Object.freeze({
    worker: "webhook_delivery", table: "nyst_webhook_events",
    token_column: "claim_token", until_column: "claimed_until", reclaim: "logical_identity" as const,
    rationale: "Delivery is at-least-once and the receiver deduplicates on a stable logical event id, which every attempt preserves.",
    may_cause_external_effect: false,
  }),
  Object.freeze({
    worker: "recovery", table: "nyst_recovery_executions",
    token_column: "claim_token", until_column: "claimed_until", reclaim: "consequence_aware" as const,
    rationale: "Recovery is the one background operation that may cause an external consequence. A reclaiming worker acts on the durable dispatch boundary, never on the lease: an expired lease says nothing about whether a provider was contacted.",
    may_cause_external_effect: true,
  }),
]);

export function workerLease(worker: string): WorkerLeaseContract | null {
  return WORKER_LEASES.find((item) => item.worker === worker) ?? null;
}

/**
 * The SQL predicate that decides whether one row is claimable.
 *
 * Written once so every worker asks the same question, in database time. A
 * row is claimable when nobody owns it, or when the owner's lease has lapsed
 * according to the DATABASE clock — `now()`, never a parameter.
 */
export function claimablePredicate(tokenColumn = "claim_token", untilColumn = "claimed_until"): string {
  return `(${tokenColumn} IS NULL OR ${untilColumn} IS NULL OR ${untilColumn} <= now())`;
}

/**
 * The SQL predicate every worker write must carry.
 *
 * Ownership is the token AND an unexpired lease. Checking only the token would
 * let a worker that paused for an hour, and whose work was reclaimed and then
 * released, write as though it had never stopped.
 */
export function ownershipPredicate(tokenColumn = "claim_token", untilColumn = "claimed_until"): string {
  return `${tokenColumn} = $1 AND ${untilColumn} IS NOT NULL AND ${untilColumn} > now()`;
}
