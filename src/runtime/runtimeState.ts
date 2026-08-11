import type { EffectState } from "../model/effectState.js";

export const DISPATCH_STATUSES = [
  "not_started",
  "claimed",
  "attempted",
  "definitely_not_sent",
] as const;

export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export interface RuntimeState {
  action_id: string;
  dispatch_status: DispatchStatus;
  dispatch_attempts: number;
  dispatch_claim_token: string | null;
  compensation_claim_token: string | null;
  compensation_attempts: number;
  resolution_sequence: number;
  evidence_sequence: number;
  next_check_at: string | null;
  last_effect_state: EffectState | null;
}

export interface DispatchClaim {
  claimed: boolean;
  token: string | null;
  state: RuntimeState;
}
