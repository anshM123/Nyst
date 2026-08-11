import type { ProductRepository } from "./productRepository.js";

/**
 * RE-OBSERVATION WORKER.
 *
 * Strictly READ-ONLY (I19). It calls `runtime.reconcile`, which observes and
 * reconciles; it can never reach a provider mutation. Because there is no
 * consequence to duplicate, an expired claim is always safe to reclaim — the
 * opposite of the recovery worker, whose reclaim is gated by a durable
 * dispatch boundary.
 *
 * Duplicate observations are safe by construction: reconcile appends evidence
 * to the append-only ledger and `recordResolutionTransition` deduplicates on
 * (action_id, resolution_id), so two workers observing the same action produce
 * one transition.
 */
export interface ObservationRuntime { reconcile(actionId: string): Promise<unknown> }

export class NystReobservationWorker {
  /** `environment_id` optionally shards this worker to one environment. */
  constructor(private readonly repository: ProductRepository, private readonly runtime: ObservationRuntime,
    private readonly options: { environment_id?: string; leaseMs?: number; maxAttempts?: number } = {}) {}

  async runOne(): Promise<boolean> {
    const claim = await this.repository.claimReobservation(this.options);
    if (!claim) return false;
    const jobId = String(claim.reobservation_job_id);
    const actionId = String(claim.action_id);
    const token = String(claim.claim_token);
    try {
      const resolution = await this.runtime.reconcile(actionId);
      await this.repository.recordResolutionTransition(actionId, resolution, "human_review");
      // Completion requires the CURRENT token. If another worker legitimately
      // reclaimed this job while we were observing, this returns false and our
      // (harmless, read-only) work is simply discarded.
      await this.repository.completeReobservation(jobId, token, true);
    } catch (error) {
      await this.repository.completeReobservation(jobId, token, false, safeError(error));
    }
    return true;
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.name : "observation_failed").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "observation_failed";
}
