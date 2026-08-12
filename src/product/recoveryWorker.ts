import type { ProductRepository } from "./productRepository.js";

/**
 * RECOVERY WORKER.
 *
 * Recovery is the one background operation that MAY cause an external
 * consequence, so its crash/reclaim discipline is deliberately different from
 * the read-only workers.
 *
 * The durable dispatch boundary — not the lease — decides what a reclaiming
 * worker is allowed to do:
 *
 *   definitely_not_sent  + authority valid  -> may execute the send
 *   definitely_not_sent  + authority stale  -> cancel (never a consequence)
 *   attempted / may_have_been_sent / ambiguous -> OBSERVE ONLY, never resend
 *   completed                               -> no-op
 *
 * The boundary is written BEFORE the send, so a process killed mid-send still
 * leaves durable evidence that a send may have started.
 */
export interface RecoveryClaim {
  recovery_execution_id: string;
  action_id: string;
  resolution_id: string;
  operation: "authorized_continuation" | "supported_compensation";
  claim_token: string;
  downstream_operation_key: string;
  /** Stable logical identity of this recovery operation, for ABA protection. */
  recovery_operation_id: string;
  dispatch_state: "definitely_not_sent" | "attempted" | "may_have_been_sent" | "ambiguous" | "completed";
  status: "executing" | "observing" | "completed";
  attempt: number;
  authority_valid: boolean;
  /** The immutable policy this recovery was authorized under. */
  policy_version_id: string;
  resolution_sequence: number;
  evidence_sequence: number;
  environment_id: string;
  project_id: string;
  organization_id: string;
  agent_id: string | null;
  effect_name: string;
  spec_version: string;
}

export interface RecoveryResult { outcome: "completed"; provider_reference?: string; resolution?: unknown }

export type RecoveryExecutor = (claim: Readonly<RecoveryClaim>) => Promise<RecoveryResult>;

/**
 * Observe the outcome of a recovery whose consequence may already have
 * happened. This must be READ-ONLY. It answers "did the recovery take effect?"
 * without ever re-issuing it.
 */
export type RecoveryObserver = (claim: Readonly<RecoveryClaim>) => Promise<
  { outcome: "completed"; resolution?: unknown } | { outcome: "not_applied" } | { outcome: "unprovable"; reason: string }
>;

/** Explicit allowlist only: no arbitrary scripts, URLs, or callbacks from persisted data. */
export class RecoveryExecutorRegistry {
  private readonly handlers = new Map<string, RecoveryExecutor>();
  private readonly observers = new Map<string, RecoveryObserver>();

  register(effectName: string, operation: RecoveryClaim["operation"], executor: RecoveryExecutor): void {
    const key = `${effectName}:${operation}`;
    if (this.handlers.has(key)) throw new Error(`Duplicate recovery executor ${key}`);
    this.handlers.set(key, executor);
  }
  /** Optional read-only observer used when a recovery consequence is ambiguous. */
  registerObserver(effectName: string, operation: RecoveryClaim["operation"], observer: RecoveryObserver): void {
    const key = `${effectName}:${operation}`;
    if (this.observers.has(key)) throw new Error(`Duplicate recovery observer ${key}`);
    this.observers.set(key, observer);
  }
  resolve(claim: RecoveryClaim): RecoveryExecutor | null { return this.handlers.get(`${claim.effect_name}:${claim.operation}`) ?? null; }
  resolveObserver(claim: RecoveryClaim): RecoveryObserver | null { return this.observers.get(`${claim.effect_name}:${claim.operation}`) ?? null; }
}

export class NystRecoveryWorker {
  /**
   * `environment_id` optionally shards this worker to one environment. Omit it
   * for a single global worker pool; supply it to run dedicated workers per
   * tenant environment. Safety is identical either way.
   */
  constructor(private readonly repository: ProductRepository, private readonly executors: RecoveryExecutorRegistry,
    private readonly options: { environment_id?: string; leaseMs?: number } = {}) {}

  async runOne(): Promise<boolean> {
    const value = await this.repository.claimRecovery(this.options);
    if (!value) return false;
    const claim = value as unknown as RecoveryClaim;

    if (claim.dispatch_state === "completed") {
      await this.repository.completeRecovery(claim.recovery_execution_id, claim.claim_token, true, { outcome: "completed", note: "already past the dispatch boundary" }, this.expected(claim));
      return true;
    }

    // The consequence may already exist. Observe; never resend.
    if (claim.dispatch_state !== "definitely_not_sent") return this.observeAmbiguousRecovery(claim);

    // Nothing was sent. Resuming is only safe while the effective authority
    // that justified this recovery is still valid.
    if (!claim.authority_valid) {
      await this.repository.cancelRecovery(claim.recovery_execution_id, claim.claim_token,
        "The bound policy, resolution, or evidence sequence changed before the recovery was dispatched; no consequence was issued.");
      return true;
    }

    const executor = this.executors.resolve(claim);
    if (!executor) {
      await this.repository.cancelRecovery(claim.recovery_execution_id, claim.claim_token, "No registered recovery executor for this effect and operation; nothing was dispatched.");
      return true;
    }

    // THE DISPATCH GATE.
    //
    // This both verifies that we may still send and durably advances the
    // boundary to may_have_been_sent, in one statement. If this process dies on
    // the very next line, a reclaiming worker sees may_have_been_sent and will
    // observe rather than re-send.
    //
    // The previous version of this code called the marker and threw away its
    // boolean, so a worker whose claim had already been taken by another worker
    // still reached the provider. That is a duplicate external effect — the one
    // thing invariant S1 forbids absolutely. The result is now checked, and a
    // false return returns immediately without touching the executor.
    const mayDispatch = await this.repository.beginRecoveryDispatch({
      recovery_execution_id: claim.recovery_execution_id,
      claim_token: claim.claim_token,
      attempt: claim.attempt,
      action_id: claim.action_id,
      recovery_operation_id: claim.recovery_operation_id,
      policy_version_id: claim.policy_version_id,
      resolution_sequence: claim.resolution_sequence,
      evidence_sequence: claim.evidence_sequence,
      detail: { operation: claim.operation, downstream_operation_key: claim.downstream_operation_key },
    });
    if (!mayDispatch) {
      // We no longer own this work, or the world moved under us. Someone else
      // is responsible for it now. Do nothing at all: not a retry, not an
      // observation, not a status write. Any write here would be this worker
      // acting without authority.
      return true;
    }

    try {
      const result = await executor(Object.freeze({ ...claim }));
      await this.repository.recordRecoveryDispatch(claim.recovery_execution_id, claim.claim_token, claim.attempt, "after_send", "completed",
        result.provider_reference ? { provider_reference: result.provider_reference } : {});
      if (result.resolution) await this.repository.recordResolutionTransition(claim.action_id, result.resolution, "recovery_worker");
      await this.repository.completeRecovery(claim.recovery_execution_id, claim.claim_token, true,
        { outcome: result.outcome, ...(result.provider_reference ? { provider_reference: result.provider_reference } : {}) }, this.expected(claim));
    } catch (error) {
      // The executor threw AFTER dispatch began. That is exactly the
      // may-have-been-sent case: it is never proof the effect did not happen.
      await this.repository.recordRecoveryDispatch(claim.recovery_execution_id, claim.claim_token, claim.attempt, "failed_after_send", "may_have_been_sent",
        { error_code: safeError(error) });
      await this.settleAmbiguous(claim, safeError(error));
    }
    return true;
  }

  /** Read-only path for a recovery whose consequence may already exist. */
  private async observeAmbiguousRecovery(claim: RecoveryClaim): Promise<boolean> {
    const observer = this.executors.resolveObserver(claim);
    if (!observer) {
      await this.repository.recoveryNeedsReview(claim.recovery_execution_id, claim.claim_token,
        "The recovery consequence may have been sent and no authoritative read-only observation mechanism is registered for this effect.");
      return true;
    }
    try {
      const observed = await observer(Object.freeze({ ...claim }));
      await this.repository.recordRecoveryDispatch(claim.recovery_execution_id, claim.claim_token, claim.attempt, "observed",
        observed.outcome === "completed" ? "completed" : "ambiguous", { observed: observed.outcome });
      if (observed.outcome === "completed") {
        if (observed.resolution) await this.repository.recordResolutionTransition(claim.action_id, observed.resolution, "recovery_worker");
        await this.repository.completeRecovery(claim.recovery_execution_id, claim.claim_token, true, { outcome: "completed", established_by: "read_only_observation" }, this.expected(claim));
      } else {
        // "not_applied" is deliberately NOT auto-retried here. Re-authorizing a
        // consequence is a fresh decision, not a worker's to make.
        await this.repository.recoveryNeedsReview(claim.recovery_execution_id, claim.claim_token,
          observed.outcome === "not_applied"
            ? "Read-only observation shows the recovery did not take effect. Re-authorization is a human decision, never an automatic resend."
            : `Read-only observation could not establish the recovery outcome: ${observed.reason}`);
      }
    } catch (error) {
      await this.settleAmbiguous(claim, safeError(error));
    }
    return true;
  }

  private async settleAmbiguous(claim: RecoveryClaim, errorCode: string): Promise<void> {
    await this.repository.recoveryNeedsReview(claim.recovery_execution_id, claim.claim_token,
      `The recovery consequence may have been sent and could not be confirmed (${errorCode}). Nyst will not resend it.`);
  }

  /** ABA guard: every completion pins the identity it believed it was finishing. */
  private expected(claim: RecoveryClaim): { action_id: string; recovery_operation_id: string; resolution_sequence: number; evidence_sequence: number } {
    return {
      action_id: claim.action_id,
      recovery_operation_id: claim.recovery_operation_id,
      resolution_sequence: claim.resolution_sequence,
      evidence_sequence: claim.evidence_sequence,
    };
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.name : "recovery_failed").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "recovery_failed";
}
