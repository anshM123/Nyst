/**
 * Storage interfaces. Two implementations:
 *   - MemoryStore (deterministic; mirrors the SQL constraints; used in unit tests)
 *   - PostgresStore (real durability; SQL constraints are the source of truth)
 */
import type { ActionRecord, DispatchPlan } from "../model/action.js";
import type { InternalState } from "../model/internalState.js";
import type { EvidenceRecord } from "../model/evidence.js";
import type { OutcomeResolution } from "../model/resolution.js";
import type { ActionContext } from "../model/metadata.js";
import type { ClockAttestation } from "../core/clock.js";
import type { DispatchClaim, DispatchStatus, RuntimeState } from "../runtime/runtimeState.js";
import type { EffectState } from "../model/effectState.js";
import type { OffboardingRunLedger } from "../offboarding/offboardingRun.js";

export interface NewActionIntent {
  effect_name: string;
  business_key: string;
  input: unknown;
  input_hash: string;
  spec_version: string;
  context: ActionContext;
  clock: ClockAttestation;
}

export interface ActionLedger {
  /**
   * Idempotent intent recording:
   *  - no existing (effect_name, business_key): create, internal_state=intent_recorded
   *  - existing with SAME input_hash: return existing record (created=false)
   *  - existing with DIFFERENT input_hash: throw InputCollisionError
   */
  recordIntent(intent: NewActionIntent): Promise<{ action: ActionRecord; created: boolean }>;
  getAction(action_id: string): Promise<ActionRecord | null>;
  findByIdentity(effect_name: string, business_key: string): Promise<ActionRecord | null>;
  transition(action_id: string, from: InternalState, to: InternalState): Promise<ActionRecord>;
  /**
   * Atomically persist the exact provider-operation identity (correlation +
   * idempotency material) AND advance intent_recorded -> prepared.
   * PERSIST EXECUTION IDENTITY BEFORE DISPATCH: transitioning to `dispatching`
   * is rejected by both stores unless a dispatch plan has been recorded.
   */
  prepare(action_id: string, plan: DispatchPlan): Promise<ActionRecord>;
}

/**
 * `payload_hash` is intentionally NOT accepted from callers: the ledger
 * computes it from the payload itself, so a stored hash can never disagree
 * with the stored payload.
 */
export type NewEvidence = Omit<EvidenceRecord, "evidence_id" | "seq" | "payload_hash">;

export interface EvidenceLedger {
  /** Append-only; assigns evidence_id + monotonic per-action seq. */
  append(ev: NewEvidence): Promise<EvidenceRecord>;
  listForAction(action_id: string): Promise<EvidenceRecord[]>; // ordered by seq
}

export interface ResolutionStore {
  save(resolution: OutcomeResolution): Promise<void>;
  latestForAction(action_id: string): Promise<OutcomeResolution | null>;
}

export interface RuntimeLedger {
  initialize(action_id: string): Promise<RuntimeState>;
  get(action_id: string): Promise<RuntimeState | null>;
  claimDispatch(
    action_id: string,
    allowed: readonly DispatchStatus[],
    guard?: DispatchGuard | undefined
  ): Promise<DispatchClaim>;
  finishDispatch(
    action_id: string,
    token: string,
    status: Exclude<DispatchStatus, "claimed">
  ): Promise<RuntimeState>;
  setDispatchStatus(
    action_id: string,
    from: DispatchStatus,
    to: Exclude<DispatchStatus, "claimed">
  ): Promise<RuntimeState>;
  claimCompensation(action_id: string): Promise<DispatchClaim>;
  finishCompensation(action_id: string, token: string): Promise<RuntimeState>;
  nextResolutionSequence(
    action_id: string,
    effect_state: EffectState,
    next_check_at: string | null
  ): Promise<number>;
}

export interface DispatchGuard {
  /** Same-action guard used by controlled retry. */
  resolution_sequence?: number;
  evidence_sequence?: number;
  /**
   * Cross-action continuation guard. Implementations must check this at the
   * same durable boundary that acquires downstream dispatch ownership.
   */
  continuation?: {
    action_id: string;
    resolution_id: string;
    resolution_sequence: number;
    evidence_sequence: number;
  };
}

export interface Store {
  actions: ActionLedger;
  evidence: EvidenceLedger;
  resolutions: ResolutionStore;
  runtime: RuntimeLedger;
  offboarding: OffboardingRunLedger;
}
