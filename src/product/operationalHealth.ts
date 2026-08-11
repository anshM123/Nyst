/**
 * OPERATIONAL OBSERVABILITY (Phase 23).
 *
 * Deliberately NOT a monitoring product. This answers one operational question
 * that Nyst uniquely must answer:
 *
 *   IF THE API IS ALIVE BUT THE BACKGROUND WORKERS ARE NOT, CAN YOU TELL?
 *
 * A Nyst deployment whose API responds while its reconciliation and recovery
 * workers are dead is *worse* than one that is plainly down: it accepts
 * consequential actions and then never resolves their ambiguity. So worker
 * liveness is a first-class health signal, not a nice-to-have dashboard.
 *
 * No credential, credential reference, secret, or provider payload is ever
 * exposed here.
 */
import type { ProductDb } from "./productRepository.js";

export type WorkerKind = "reconciliation" | "recovery" | "reobservation" | "webhook";

export interface QueueDepth {
  queue: WorkerKind;
  /** Ready to be claimed right now. */
  pending: number;
  /** Claimed by a live lease. */
  in_flight: number;
  /** Claimed by a lease that has EXPIRED — the signal that a worker died. */
  stale_leases: number;
  /** Oldest pending item's age in seconds. Null when the queue is empty. */
  oldest_pending_seconds: number | null;
}

export interface OperationalHealth {
  status: "ok" | "degraded" | "unhealthy";
  checked_at: string;
  api: { status: "ok"; database_reachable: boolean };
  workers: ReadonlyArray<{ kind: WorkerKind; last_heartbeat_at: string | null; seconds_since_heartbeat: number | null; healthy: boolean }>;
  queues: readonly QueueDepth[];
  human_reviews_open: number;
  provider_preflight_failures_24h: number;
  freezes_active: number;
  blast_radius_holds_24h: number;
  /** Human-readable reasons the status is not "ok". */
  problems: readonly string[];
}

/** A worker is considered dead if it has not checked in within this window. */
export const WORKER_HEARTBEAT_TIMEOUT_SECONDS = 120;

export async function recordWorkerHeartbeat(db: ProductDb, kind: WorkerKind, instance: string): Promise<void> {
  await db.query(
    `INSERT INTO nyst_worker_heartbeats(worker_kind,instance_id,last_heartbeat_at)
     VALUES($1,$2,now())
     ON CONFLICT(worker_kind,instance_id) DO UPDATE SET last_heartbeat_at=now()`,
    [kind, instance.slice(0, 120)]);
}

export async function operationalHealth(db: ProductDb, now: Date = new Date()): Promise<OperationalHealth> {
  let databaseReachable = true;
  try { await db.query("SELECT 1"); } catch { databaseReachable = false; }

  const [heartbeats, queues, counts] = await Promise.all([
    db.query(`SELECT worker_kind,max(last_heartbeat_at) last_heartbeat_at,
        extract(epoch FROM (now()-max(last_heartbeat_at)))::bigint seconds_since
      FROM nyst_worker_heartbeats GROUP BY worker_kind`),
    db.query(`
      SELECT 'reconciliation'::text queue,
        count(*) FILTER (WHERE claim_token IS NULL AND due_at<=now())::int pending,
        count(*) FILTER (WHERE claim_token IS NOT NULL AND claimed_until>now())::int in_flight,
        count(*) FILTER (WHERE claim_token IS NOT NULL AND claimed_until<=now())::int stale,
        extract(epoch FROM (now()-min(due_at) FILTER (WHERE claim_token IS NULL AND due_at<=now())))::bigint oldest
      FROM nyst_reconciliation_jobs
      UNION ALL
      SELECT 'recovery',
        count(*) FILTER (WHERE status='authorized')::int,
        count(*) FILTER (WHERE status IN ('executing','observing') AND claimed_until>now())::int,
        count(*) FILTER (WHERE status IN ('executing','observing') AND claimed_until<=now())::int,
        extract(epoch FROM (now()-min(created_at) FILTER (WHERE status='authorized')))::bigint
      FROM nyst_recovery_executions
      UNION ALL
      SELECT 'reobservation',
        count(*) FILTER (WHERE status='requested')::int,
        count(*) FILTER (WHERE status='executing' AND claimed_until>now())::int,
        count(*) FILTER (WHERE status='executing' AND claimed_until<=now())::int,
        extract(epoch FROM (now()-min(requested_at) FILTER (WHERE status='requested')))::bigint
      FROM nyst_reobservation_jobs
      UNION ALL
      SELECT 'webhook',
        count(*) FILTER (WHERE delivered_at IS NULL AND terminal_at IS NULL AND next_attempt_at<=now() AND claim_token IS NULL)::int,
        count(*) FILTER (WHERE claim_token IS NOT NULL AND claimed_until>now())::int,
        count(*) FILTER (WHERE claim_token IS NOT NULL AND claimed_until<=now())::int,
        extract(epoch FROM (now()-min(occurred_at) FILTER (WHERE delivered_at IS NULL AND terminal_at IS NULL)))::bigint
      FROM nyst_webhook_events`),
    db.query(`SELECT
      (SELECT count(*)::int FROM nyst_human_reviews WHERE status='open') human_reviews_open,
      (SELECT count(*)::int FROM nyst_integration_preflights WHERE status<>'verified_ready' AND performed_at>now()-interval '24 hours') preflight_failures,
      (SELECT count(*)::int FROM nyst_freezes WHERE released_at IS NULL) freezes_active,
      (SELECT count(*)::int FROM nyst_blast_radius_decisions WHERE decision='held' AND decided_at>now()-interval '24 hours') blast_radius_holds`),
  ]);

  const seen = new Map(heartbeats.rows.map((row) => [String(row.worker_kind), row]));
  const workers = (["reconciliation", "recovery", "reobservation", "webhook"] as const).map((kind) => {
    const row = seen.get(kind);
    const seconds = row ? Number(row.seconds_since) : null;
    return {
      kind,
      last_heartbeat_at: row ? new Date(String(row.last_heartbeat_at)).toISOString() : null,
      seconds_since_heartbeat: seconds,
      // Never heartbeated is NOT healthy. A worker that has never run is
      // indistinguishable from one that died before its first tick.
      healthy: seconds !== null && seconds <= WORKER_HEARTBEAT_TIMEOUT_SECONDS,
    };
  });

  const queueDepths: QueueDepth[] = queues.rows.map((row) => ({
    queue: String(row.queue) as WorkerKind,
    pending: Number(row.pending ?? 0),
    in_flight: Number(row.in_flight ?? 0),
    stale_leases: Number(row.stale ?? 0),
    oldest_pending_seconds: row.oldest === null || row.oldest === undefined ? null : Number(row.oldest),
  }));

  const summary = counts.rows[0] ?? {};
  const problems: string[] = [];
  if (!databaseReachable) problems.push("The database is not reachable.");
  for (const worker of workers) {
    if (!worker.healthy) {
      problems.push(worker.last_heartbeat_at === null
        ? `The ${worker.kind} worker has never checked in. Ambiguous actions in this queue will not be resolved.`
        : `The ${worker.kind} worker last checked in ${worker.seconds_since_heartbeat}s ago, beyond the ${WORKER_HEARTBEAT_TIMEOUT_SECONDS}s timeout.`);
    }
  }
  for (const queue of queueDepths) {
    if (queue.stale_leases > 0) problems.push(`${queue.stale_leases} ${queue.queue} item(s) hold an expired lease, which means a worker died mid-claim.`);
  }
  if (Number(summary.freezes_active ?? 0) > 0) problems.push(`${summary.freezes_active} Emergency Freeze(s) active: no new consequence may begin in those scopes.`);

  // An unreachable database or a dead worker is unhealthy, because
  // consequential ambiguity would go unresolved. A freeze is intentional, so
  // it is only degraded.
  const unhealthy = !databaseReachable || workers.some((worker) => !worker.healthy) || queueDepths.some((queue) => queue.stale_leases > 0);
  return {
    status: unhealthy ? "unhealthy" : problems.length ? "degraded" : "ok",
    checked_at: now.toISOString(),
    api: { status: "ok", database_reachable: databaseReachable },
    workers,
    queues: queueDepths,
    human_reviews_open: Number(summary.human_reviews_open ?? 0),
    provider_preflight_failures_24h: Number(summary.preflight_failures ?? 0),
    freezes_active: Number(summary.freezes_active ?? 0),
    blast_radius_holds_24h: Number(summary.blast_radius_holds ?? 0),
    problems,
  };
}

/** Prometheus-style text exposition. Protected endpoint only. */
export function healthMetricsText(health: OperationalHealth): string {
  const lines: string[] = [
    "# HELP nyst_api_up Whether the Nyst API can reach its database.",
    "# TYPE nyst_api_up gauge",
    `nyst_api_up ${health.api.database_reachable ? 1 : 0}`,
    "# HELP nyst_worker_healthy Whether each background worker has checked in recently.",
    "# TYPE nyst_worker_healthy gauge",
  ];
  for (const worker of health.workers) lines.push(`nyst_worker_healthy{worker="${worker.kind}"} ${worker.healthy ? 1 : 0}`);
  lines.push("# HELP nyst_queue_depth Items awaiting a worker.", "# TYPE nyst_queue_depth gauge");
  for (const queue of health.queues) lines.push(`nyst_queue_depth{queue="${queue.queue}"} ${queue.pending}`);
  lines.push("# HELP nyst_stale_leases Claims whose lease expired, indicating a dead worker.", "# TYPE nyst_stale_leases gauge");
  for (const queue of health.queues) lines.push(`nyst_stale_leases{queue="${queue.queue}"} ${queue.stale_leases}`);
  lines.push(
    "# HELP nyst_human_reviews_open Incidents awaiting a human.", "# TYPE nyst_human_reviews_open gauge",
    `nyst_human_reviews_open ${health.human_reviews_open}`,
    "# HELP nyst_preflight_failures_24h Read-only provider preflight failures in the last 24h.", "# TYPE nyst_preflight_failures_24h gauge",
    `nyst_preflight_failures_24h ${health.provider_preflight_failures_24h}`,
    "# HELP nyst_freezes_active Emergency Freezes currently active.", "# TYPE nyst_freezes_active gauge",
    `nyst_freezes_active ${health.freezes_active}`,
    "# HELP nyst_blast_radius_holds_24h Consequences held by a budget in the last 24h.", "# TYPE nyst_blast_radius_holds_24h gauge",
    `nyst_blast_radius_holds_24h ${health.blast_radius_holds_24h}`,
  );
  return lines.join("\n") + "\n";
}
