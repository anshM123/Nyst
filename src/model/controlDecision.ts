/**
 * AXIS 2 — CONTROL DECISION.
 *
 * Effect state describes what Outcome KNOWS.
 * ControlDecision describes what software is PERMITTED/EXPECTED to do next.
 *
 * These are deliberately separate structures. There is no global 1:1 mapping
 * from effect state to a simplistic next action; e.g. `satisfied_unattributed`
 * commonly yields { primary: do_not_retry, retry: forbidden, continuation: allowed }.
 */
import { en, num, obj, opt, str, type Schema } from "../core/validate.js";

export const CONTROL_DECISION_VERSION = 1 as const;

export const PRIMARY_DIRECTIVES = [
  "continue",
  "retry",
  "do_not_retry",
  "hold",
  "compensate",
  "escalate",
] as const;
export type PrimaryDirective = (typeof PRIMARY_DIRECTIVES)[number];

export const RETRY_DISPOSITIONS = ["allowed", "forbidden", "unknown"] as const;
export type RetryDisposition = (typeof RETRY_DISPOSITIONS)[number];

export const CONTINUATION_DISPOSITIONS = ["allowed", "blocked", "conditional"] as const;
export type ContinuationDisposition = (typeof CONTINUATION_DISPOSITIONS)[number];

export const RECOVERY_DISPOSITIONS = ["none", "compensate", "escalate"] as const;
export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];

export interface ControlDecision {
  decision_version: number;
  primary: PrimaryDirective;
  retry: RetryDisposition;
  continuation: ContinuationDisposition;
  recovery: RecoveryDisposition;
  /** Machine-readable reason code, e.g. "CORE.PENDING_BLOCKS_CONTINUATION". */
  reason_code: string;
  /** Human-readable explanation. */
  explanation: string;
  /** When resolution should be re-checked (pending etc.), ISO-8601. */
  next_check_at?: string;
  /** Version of the decision policy that produced this decision. */
  policy_version: string;
  /** Version of the EffectSpec consulted. */
  spec_version: string;
}

export const ControlDecisionSchema: Schema<ControlDecision> = obj({
  decision_version: num({ int: true, min: 1 }),
  primary: en(PRIMARY_DIRECTIVES),
  retry: en(RETRY_DISPOSITIONS),
  continuation: en(CONTINUATION_DISPOSITIONS),
  recovery: en(RECOVERY_DISPOSITIONS),
  reason_code: str({ min: 1, max: 120 }),
  explanation: str({ min: 1 }),
  next_check_at: opt(str({ min: 20 })),
  policy_version: str({ min: 1 }),
  spec_version: str({ min: 1 }),
});
