/**
 * CONTROL-PLANE IDEMPOTENCY.
 *
 * A browser double-click, a proxy retry, or an impatient operator must not
 * duplicate a control-plane command. The frontend may disable a button while a
 * request is in flight, but the backend has to be safe on its own — the button
 * is a courtesy, not a guarantee.
 *
 * Three outcomes, all decided by the database:
 *
 *   FIRST CALL     -> reserve the key, run the operation, store the response.
 *   EXACT REPLAY   -> same key, same request hash: return the stored response.
 *                     The operation does NOT run again.
 *   CONFLICT       -> same key, DIFFERENT request hash: 409. The caller reused a
 *                     key for a different command, which is a bug; silently
 *                     serving the old result would hide it.
 *   IN FLIGHT      -> the first call has not finished: 409, retry shortly.
 *
 * Consequential SDK actions are deliberately excluded. `POST /v1/actions`
 * already derives logical identity from (environment, business key) and is
 * protected by the engine's dispatch-before-consequence machinery; adding a
 * second dedupe mechanism would create two competing definitions of "the same
 * action".
 */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../core/canonical.js";
import type { ProductDb } from "./productRepository.js";
import type { TenantScope } from "./types.js";

/** Control-plane operations that accept an idempotency key. */
export const IDEMPOTENT_OPERATIONS = [
  "api_key.create",
  "policy.create_version",
  "webhook.configure",
  "webhook.set_enabled",
  "review.command",
  "review.open",
  "failure_lab.run",
  "recovery.authorize",
  "agent.create",
  "freeze.activate",
  "freeze.release",
  "environment.set_mode",
  "integration.configure",
  "effect_spec.configure",
  "blast_radius.configure",
  // v0.3.0. Every one of these is a mutation a browser can double-submit, and
  // several of them create durable authority. Backend safety must not depend
  // on a disabled button.
  "outcome_contract.create",
  "outcome.open",
  "outcome.evaluate",
  "outcome.receipt",
  "autonomy_rule.create",
  "authority_exception.create",
  "authority_exception.revoke",
  "continuation_grant.issue",
  "capability.attest",
] as const;

export type IdempotentOperation = (typeof IDEMPOTENT_OPERATIONS)[number];

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,200}$/;

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = "IdempotencyConflictError"; }
}

export function hashRequest(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export interface IdempotentResult<T> {
  value: T;
  /** True when the stored response was replayed instead of re-running the work. */
  replayed: boolean;
}

/**
 * Run `operationFn` at most once per (environment, operation, key).
 *
 * With no key supplied the operation simply runs — idempotency is opt-in per
 * request, but the guarantee is unconditional once a key is present.
 */
export async function withIdempotency<T>(
  db: ProductDb,
  scope: TenantScope,
  operation: IdempotentOperation,
  key: string | null,
  body: unknown,
  operationFn: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  if (key === null) return { value: await operationFn(), replayed: false };
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw Object.assign(new Error("An idempotency key must be 8-200 characters of [A-Za-z0-9_.:-]"), { statusCode: 400 });
  }
  const requestHash = hashRequest(body);

  // Reserve the key. The unique constraint is the arbiter, so two concurrent
  // callers cannot both win the reservation.
  const reserved = await db.query(
    `INSERT INTO nyst_idempotency_keys(idempotency_id,organization_id,project_id,environment_id,operation,idempotency_key,request_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(environment_id,operation,idempotency_key) DO NOTHING
     RETURNING idempotency_id`,
    [randomUUID(), scope.organization_id, scope.project_id, scope.environment_id, operation, key, requestHash],
  );

  if (!reserved.rows.length) {
    const existing = (await db.query(
      `SELECT request_hash,status,response,expires_at FROM nyst_idempotency_keys
       WHERE environment_id=$1 AND operation=$2 AND idempotency_key=$3`,
      [scope.environment_id, operation, key],
    )).rows[0];
    if (!existing) throw new IdempotencyConflictError("The idempotency key is being processed concurrently. Retry shortly.");
    if (String(existing.request_hash) !== requestHash) {
      throw new IdempotencyConflictError(
        "This idempotency key was already used with different parameters. Reusing a key for a different command is not a replay.",
      );
    }
    if (existing.status !== "completed") {
      throw new IdempotencyConflictError("The original request with this idempotency key is still in flight. Retry shortly.");
    }
    return { value: (existing.response as { value: T }).value, replayed: true };
  }

  let value: T;
  try {
    value = await operationFn();
  } catch (error) {
    // A failed operation must not poison the key: the caller should be able to
    // retry the same command. Releasing the reservation is safe precisely
    // because the operation did not complete.
    await db.query(`DELETE FROM nyst_idempotency_keys WHERE environment_id=$1 AND operation=$2 AND idempotency_key=$3 AND status='in_flight'`,
      [scope.environment_id, operation, key]);
    throw error;
  }

  await db.query(
    `UPDATE nyst_idempotency_keys SET status='completed',response=$4,response_status=200,completed_at=now()
     WHERE environment_id=$1 AND operation=$2 AND idempotency_key=$3 AND status='in_flight'`,
    [scope.environment_id, operation, key, { value }],
  );
  return { value, replayed: false };
}

/** Delete expired keys. Called by the maintenance sweep, never on the hot path. */
export async function pruneIdempotencyKeys(db: ProductDb): Promise<number> {
  const result = await db.query(`DELETE FROM nyst_idempotency_keys WHERE expires_at<=now() RETURNING idempotency_id`);
  return result.rows.length;
}
