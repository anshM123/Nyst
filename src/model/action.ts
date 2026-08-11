/**
 * LOGICAL ACTION IDENTITY.
 *
 *   action_id     Outcome-generated immutable UUID for one logical action.
 *   effect_name   e.g. "fake.repository_permission_change" in tests.
 *   business_key  Stable caller-defined identity, e.g. "offboard:alice:repo_prod".
 *   input_hash    Deterministic canonical hash of SEMANTICALLY RELEVANT inputs
 *                 (projected by the EffectSpec's semantic_fields, then ojc-1
 *                 canonicalized, then sha256).
 *
 * Identity law:
 *   same (effect_name, business_key, semantic input)      -> same logical action
 *   same (effect_name, business_key), different semantics -> collision error
 *
 * Uniqueness is enforced in PostgreSQL (unique index on effect_name,
 * business_key), not only in application code. The in-memory store mirrors
 * the same constraint for dependency-free tests.
 *
 * PERSIST INTENT FIRST: an action row exists (internal_state=intent_recorded)
 * BEFORE any provider mutation may ever be dispatched. The record is designed
 * around intent + recovery, not around successful provider responses.
 */
import { canonicalHash } from "../core/canonical.js";
import { UUID_RE } from "../core/ids.js";
import { obj, opt, str, unknownJson, type Schema } from "../core/validate.js";
import { ClockAttestationSchema, type ClockAttestation } from "../core/clock.js";
import { InternalStateSchema, type InternalState } from "./internalState.js";
import { nullable } from "../core/validate.js";
import { ActionContextSchema, type ActionContext } from "./metadata.js";

export interface LogicalActionIdentity {
  action_id: string;
  effect_name: string;
  business_key: string;
  input_hash: string;
}

/**
 * The exact provider-operation identity for the (future) external mutation.
 * PERSISTED BEFORE DISPATCH: once a mutation may have been issued, crash
 * recovery must never depend on being able to recompute correlation or
 * idempotency material — it reads what was durably recorded at `prepared`.
 */
export interface DispatchPlan {
  /** Correlation metadata that accompanies the provider mutation. */
  correlation: { method: string; value: string };
  /** Provider idempotency key semantics, where the provider supports them. */
  idempotency_key: string | null;
  /** Phase 1: description only. No real mutation is ever issued. */
  description: string;
  /** Provider-neutral, non-secret execution identity persisted before consequence. */
  provider?: string;
  operation?: string;
  api_version?: string;
  credential_ref?: string;
  target?: unknown;
}

export const DispatchPlanSchema: Schema<DispatchPlan> = obj({
  correlation: obj({ method: str({ min: 1 }), value: str({ min: 1 }) }),
  idempotency_key: nullable(str({ min: 1 })),
  description: str({ min: 1 }),
  provider: opt(str({ min: 1, max: 100 })),
  operation: opt(str({ min: 1, max: 100 })),
  api_version: opt(str({ min: 1, max: 50 })),
  credential_ref: opt(str({ min: 1, max: 500 })),
  target: opt(unknownJson()),
});

export interface ActionRecord extends LogicalActionIdentity {
  /** Full caller input as recorded at intent time (semantic + non-semantic). */
  input: unknown;
  spec_version: string;
  internal_state: InternalState;
  /** Null until `prepared`; REQUIRED before the lifecycle may enter `dispatching`. */
  dispatch_plan: DispatchPlan | null;
  context: ActionContext;
  created_at: string;
  created_clock: ClockAttestation;
}

export const ActionRecordSchema: Schema<ActionRecord> = obj({
  action_id: str({ pattern: UUID_RE }),
  effect_name: str({ min: 1, max: 200 }),
  business_key: str({ min: 1, max: 500 }),
  input_hash: str({ pattern: /^sha256:[0-9a-f]{64}$/ }),
  input: unknownJson(),
  spec_version: str({ min: 1 }),
  internal_state: InternalStateSchema,
  dispatch_plan: nullable(DispatchPlanSchema),
  context: ActionContextSchema,
  created_at: str({ min: 20 }),
  created_clock: ClockAttestationSchema,
});

export class InputCollisionError extends Error {
  override name = "InputCollisionError";
  constructor(
    public effect_name: string,
    public business_key: string,
    public existing_hash: string,
    public attempted_hash: string
  ) {
    super(
      `Logical action collision: ${effect_name} / ${business_key} already exists with a ` +
        `different semantic input (existing ${existing_hash}, attempted ${attempted_hash}). ` +
        `Ambiguous requests must not silently mint a new retry identity.`
    );
  }
}

/**
 * Project the semantically relevant fields of an input, then hash canonically.
 * Key ordering of the caller's object never affects the hash.
 */
export function computeInputHash(semanticFields: readonly string[], input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Action input must be a plain object");
  }
  const rec = input as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const f of [...semanticFields].sort()) {
    projected[f] = rec[f] === undefined ? null : rec[f];
  }
  return canonicalHash(projected);
}
