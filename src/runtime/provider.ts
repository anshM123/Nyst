import type { ActionRecord, DispatchPlan } from "../model/action.js";
import type { EvidenceRecord } from "../model/evidence.js";
import type { NewEvidence } from "../store/store.js";

export type SendCertainty = "definitely_not_sent" | "may_have_been_sent" | "sent";

export interface DispatchResult {
  send_certainty: SendCertainty;
  evidence: NewEvidence[];
}

export interface CompensationResult {
  evidence: NewEvidence[];
}

export interface ProviderAdapter {
  readonly effect_name: string;
  dispatch(
    action: ActionRecord,
    plan: DispatchPlan,
    onMutation?: (() => void | Promise<void>) | undefined
  ): Promise<DispatchResult>;
  observe(
    action: ActionRecord,
    plan: DispatchPlan,
    priorEvidence?: readonly EvidenceRecord[]
  ): Promise<NewEvidence[]>;
  compensate?(action: ActionRecord, plan: DispatchPlan): Promise<CompensationResult>;
}

export class ProcessCrashError extends Error {
  override name = "ProcessCrashError";
  constructor(public readonly point: string) {
    super(`Injected process crash at ${point}`);
  }
}

export type RuntimeFaultPoint =
  | "after_intent_persistence"
  | "after_dispatch_eligibility"
  | "before_dispatch_plan"
  | "after_dispatch_plan_persistence"
  | "before_dispatch_claim"
  | "after_dispatch_claim"
  | "after_provider_mutation"
  | "before_provider_response_delivery"
  | "after_provider_response"
  | "before_evidence_persistence"
  | "after_evidence_persistence"
  | "before_reconciliation"
  | "after_state_derivation"
  | "after_control_derivation"
  | "before_resolution_signing"
  | "after_resolution_signing"
  | "before_resolution_persistence"
  | "after_resolution_persistence";

export type RuntimeFaultInjector = (point: RuntimeFaultPoint, action: ActionRecord) => void | Promise<void>;
