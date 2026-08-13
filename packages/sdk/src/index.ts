/**
 * @nyst-ai/sdk — the client for Nyst, effect-control infrastructure for
 * autonomous software.
 *
 * Nyst determines what external effect actually happened after a consequential
 * action, and decides what is safe to do next. This package is the typed way to
 * ask it, and to verify what it tells you.
 *
 * The public surface is small on purpose. Everything that decides safety lives
 * in the Nyst control plane, not here.
 */
export { NystClient, NystApiError } from "./client.js";
export type { NystClientOptions, ExecuteActionResult } from "./client.js";

export {
  EFFECT_STATES, PRIMARY_DIRECTIVES, RETRY_DISPOSITIONS,
  CONTINUATION_DISPOSITIONS, RECOVERY_DISPOSITIONS,
  mayContinue, mayRetry, needsHuman,
  OUTCOME_VERDICTS, outcomeEstablished, outcomeUnknown, mayContinueOutcome,
} from "./types.js";
export type {
  EffectState, PrimaryDirective, RetryDisposition, ContinuationDisposition, RecoveryDisposition,
  ControlDecision, EffectView, Resolution, ActionSummary,
  ExecuteActionInput, ShadowObservation, ShadowEvaluationInput,
  OutcomeVerdict, OutcomeContinuation, OutcomeInstance, OutcomeEvaluation, InvariantResult, FactValue,
} from "./types.js";

export { verifyWebhook, signWebhook, WEBHOOK_TOLERANCE_MS } from "./webhook.js";
