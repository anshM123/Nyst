import { randomUUID } from "node:crypto";
import type { ProductDb } from "./productRepository.js";

export interface Reconciler { reconcile(actionId: string): Promise<{ effect: { state: string }; control: { primary: string; next_check_at?: string | undefined } }>; }
export interface SchedulerMetrics { increment(name: "scheduler_claims" | "scheduler_errors" | "reconciliations", by?: number): void; observe(name: "scheduler_lag_ms" | "reconciliation_latency_ms", value: number): void; }
export interface ProductSchedulerControls { escalateOverdueReconciliations(nowIso?:string):Promise<number>;recordResolutionTransition(actionId:string,resolution:unknown,origin:"scheduler"):Promise<boolean>; }

export class NystReconciliationScheduler {
  constructor(private readonly db: ProductDb, private readonly runtime: Reconciler, private readonly metrics: SchedulerMetrics, private readonly leaseMs = 30_000,private readonly controls?:ProductSchedulerControls,private readonly now:()=>Date=()=>new Date()) {}
  async sync(): Promise<number> { await this.controls?.escalateOverdueReconciliations(this.now().toISOString());const result = await this.db.query(`INSERT INTO nyst_reconciliation_jobs(action_id,due_at)
    SELECT action_id,next_check_at FROM outcome_runtime WHERE next_check_at IS NOT NULL
    ON CONFLICT(action_id) DO UPDATE SET due_at=GREATEST(nyst_reconciliation_jobs.due_at,excluded.due_at),updated_at=now()
      WHERE nyst_reconciliation_jobs.claim_token IS NULL RETURNING action_id`); return result.rows.length; }
  async runOne(): Promise<boolean> {
    const token = randomUUID();
    const claim = await this.db.query(`WITH candidate AS (SELECT action_id,due_at FROM nyst_reconciliation_jobs
      WHERE due_at<=now() AND (claim_token IS NULL OR claimed_until<=now()) ORDER BY due_at,action_id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE nyst_reconciliation_jobs j SET claim_token=$1,claimed_until=now()+($2::text||' milliseconds')::interval,attempts=attempts+1,updated_at=now()
      FROM candidate c WHERE j.action_id=c.action_id RETURNING j.action_id,c.due_at`, [token, this.leaseMs]);
    const row = claim.rows[0]; if (!row) return false;
    this.metrics.increment("scheduler_claims"); this.metrics.observe("scheduler_lag_ms", Math.max(0, Date.now() - new Date(row.due_at as string | Date).getTime())); const started = Date.now();
    try {
      const current = await this.db.query(`SELECT a.internal_state,rt.next_check_at FROM outcome_actions a JOIN outcome_runtime rt USING(action_id) WHERE a.action_id=$1`, [row.action_id]);
      if (!current.rows[0]?.next_check_at || current.rows[0]?.internal_state === "resolved") {
        await this.db.query(`DELETE FROM nyst_reconciliation_jobs WHERE action_id=$1 AND claim_token=$2`, [row.action_id, token]);
        return true;
      }
      const resolution = await this.runtime.reconcile(String(row.action_id));await this.controls?.recordResolutionTransition(String(row.action_id),resolution,"scheduler"); this.metrics.increment("reconciliations"); this.metrics.observe("reconciliation_latency_ms", Date.now() - started);
      const next = resolution.control.next_check_at ?? null;
      if (next) await this.db.query(`UPDATE nyst_reconciliation_jobs SET due_at=GREATEST($3::timestamptz,now()+interval '1 second'),claim_token=NULL,claimed_until=NULL,last_error_code=NULL,updated_at=now() WHERE action_id=$1 AND claim_token=$2`, [row.action_id, token, next]);
      else await this.db.query(`DELETE FROM nyst_reconciliation_jobs WHERE action_id=$1 AND claim_token=$2`, [row.action_id, token]);
    } catch {
      this.metrics.increment("scheduler_errors");
      await this.db.query(`UPDATE nyst_reconciliation_jobs SET due_at=now()+(LEAST(300,GREATEST(5,power(2,LEAST(attempts,8))))::text||' seconds')::interval,claim_token=NULL,claimed_until=NULL,last_error_code='reconcile_failed',updated_at=now() WHERE action_id=$1 AND claim_token=$2`, [row.action_id, token]);
    }
    return true;
  }
}

export class InMemoryOperationalMetrics implements SchedulerMetrics {
  private readonly counters = new Map<string, number>(); private readonly observations = new Map<string, { count: number; sum: number; max: number }>();
  increment(name: string, by = 1): void { this.counters.set(name, (this.counters.get(name) ?? 0) + by); }
  observe(name: string, value: number): void { const current = this.observations.get(name) ?? { count: 0, sum: 0, max: 0 }; current.count++; current.sum += value; current.max = Math.max(current.max, value); this.observations.set(name, current); }
  snapshot(): Record<string, unknown> { return { counters: Object.fromEntries(this.counters), observations: Object.fromEntries(this.observations) }; }
}
