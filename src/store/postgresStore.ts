/**
 * PostgresStore — durable implementation backed by db/migrations/0001_init.sql.
 *
 * `pg` is an optional peer dependency loaded dynamically so the core builds
 * with zero runtime dependencies. Constraints (identity uniqueness, append-only
 * evidence, closed enums) live in the DATABASE; this class relies on them
 * rather than re-implementing them.
 *
 * recordIntent concurrency strategy:
 *   INSERT ... ON CONFLICT (effect_name, business_key) DO NOTHING
 *   then SELECT the winning row and compare input_hash.
 * This is race-free under concurrent creation attempts: exactly one row wins,
 * everyone else observes it, and a mismatched input hash raises
 * InputCollisionError instead of silently minting a new retry identity.
 */
import {
  ActionRecordSchema,
  DispatchPlanSchema,
  InputCollisionError,
  type ActionRecord,
  type DispatchPlan,
} from "../model/action.js";
import { canonicalHash } from "../core/canonical.js";
import { assertTransition, type InternalState } from "../model/internalState.js";
import { EvidenceRecordSchema, type EvidenceRecord } from "../model/evidence.js";
import { OutcomeResolutionSchema, type OutcomeResolution } from "../model/resolution.js";
import { assertNoRawCredential, type ActionContext } from "../model/metadata.js";
import { newUuid } from "../core/ids.js";
import type {
  ActionLedger,
  EvidenceLedger,
  NewActionIntent,
  NewEvidence,
  ResolutionStore,
  RuntimeLedger,
  Store,
  DispatchGuard,
} from "./store.js";
import type { DispatchClaim, DispatchStatus, RuntimeState } from "../runtime/runtimeState.js";
import type { EffectState } from "../model/effectState.js";
import { PostgresOffboardingRunLedger } from "../offboarding/offboardingRun.js";

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
interface PgPoolLike extends PgClientLike {
  end(): Promise<void>;
}

/**
 * PostgreSQL BIGINT arrives as text. Converting through Number() silently
 * loses precision above 2^53-1 — unacceptable for monetary minor units.
 * Parse via BigInt and refuse anything outside the JS safe-integer range.
 */
function safeBigintToNumber(v: unknown, column: string): number {
  const b = typeof v === "bigint" ? v : BigInt(String(v));
  if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${column}=${b} exceeds JavaScript's safe integer range; ` +
        `refusing lossy conversion of a monetary value`
    );
  }
  return Number(b);
}

function rowToAction(r: Record<string, unknown>): ActionRecord {
  const context: ActionContext = {
    value_minor_units:
      r.value_minor_units === null ? null : safeBigintToNumber(r.value_minor_units, "value_minor_units"),
    value_currency: (r.value_currency as string | null)?.trim() ?? null,
    risk_magnitude: (r.risk_magnitude as string | null) ?? null,
    workload_id: (r.workload_id as string | null) ?? null,
    workload_version: (r.workload_version as string | null) ?? null,
    model_identity: (r.model_identity as string | null) ?? null,
    model_config_hash: (r.model_config_hash as string | null) ?? null,
    credential_ref: (r.credential_ref as string | null) ?? null,
    approval: {
      required: Boolean(r.approval_required),
      fired: Boolean(r.approval_fired),
      reference: (r.approval_reference as string | null) ?? null,
    },
  };
  return ActionRecordSchema.parse({
    action_id: r.action_id,
    effect_name: r.effect_name,
    business_key: r.business_key,
    input_hash: r.input_hash,
    input: r.input,
    spec_version: r.spec_version,
    internal_state: r.internal_state,
    dispatch_plan: r.dispatch_plan ?? null,
    context,
    created_at: new Date(r.created_at as string | Date).toISOString(),
    created_clock: r.created_clock,
  });
}

class PgActions implements ActionLedger {
  constructor(private db: PgClientLike) {}

  async recordIntent(intent: NewActionIntent): Promise<{ action: ActionRecord; created: boolean }> {
    assertNoRawCredential(intent.context);
    const id = newUuid();
    const c = intent.context;
    const inserted = await this.db.query(
      `INSERT INTO outcome_actions (
         action_id, effect_name, business_key, input_hash, input, spec_version,
         internal_state, value_minor_units, value_currency, risk_magnitude,
         workload_id, workload_version, model_identity, model_config_hash,
         credential_ref, approval_required, approval_fired, approval_reference,
         created_at, created_clock)
       VALUES ($1,$2,$3,$4,$5,$6,'intent_recorded',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (effect_name, business_key) DO NOTHING
       RETURNING action_id`,
      [
        id, intent.effect_name, intent.business_key, intent.input_hash,
        JSON.stringify(intent.input ?? null), intent.spec_version,
        c.value_minor_units, c.value_currency, c.risk_magnitude,
        c.workload_id, c.workload_version, c.model_identity, c.model_config_hash,
        c.credential_ref, c.approval.required, c.approval.fired, c.approval.reference,
        intent.clock.timestamp, JSON.stringify(intent.clock),
      ]
    );
    const created = inserted.rows.length === 1;
    const winner = await this.db.query(
      `SELECT * FROM outcome_actions WHERE effect_name=$1 AND business_key=$2`,
      [intent.effect_name, intent.business_key]
    );
    const row = winner.rows[0];
    if (!row) throw new Error("Invariant violation: identity row missing after upsert");
    const action = rowToAction(row);
    if (action.input_hash !== intent.input_hash) {
      throw new InputCollisionError(
        intent.effect_name, intent.business_key, action.input_hash, intent.input_hash
      );
    }
    return { action, created };
  }

  async getAction(action_id: string): Promise<ActionRecord | null> {
    const r = await this.db.query(`SELECT * FROM outcome_actions WHERE action_id=$1`, [action_id]);
    return r.rows[0] ? rowToAction(r.rows[0]) : null;
  }

  async findByIdentity(effect_name: string, business_key: string): Promise<ActionRecord | null> {
    const r = await this.db.query(
      `SELECT * FROM outcome_actions WHERE effect_name=$1 AND business_key=$2`,
      [effect_name, business_key]
    );
    return r.rows[0] ? rowToAction(r.rows[0]) : null;
  }

  async transition(action_id: string, from: InternalState, to: InternalState): Promise<ActionRecord> {
    assertTransition(from, to);
    // Execution identity must be durable BEFORE dispatch: the conditional
    // UPDATE refuses to enter `dispatching` when no dispatch plan is stored.
    const guard = to === "dispatching" ? " AND dispatch_plan IS NOT NULL" : "";
    const r = await this.db.query(
      `UPDATE outcome_actions SET internal_state=$3
       WHERE action_id=$1 AND internal_state=$2${guard} RETURNING *`,
      [action_id, from, to]
    );
    const row = r.rows[0];
    if (!row) {
      if (to === "dispatching") {
        const probe = await this.db.query(
          `SELECT internal_state, dispatch_plan FROM outcome_actions WHERE action_id=$1`,
          [action_id]
        );
        if (probe.rows[0] && probe.rows[0].dispatch_plan === null) {
          throw new Error(
            `Refusing to enter 'dispatching' without a persisted dispatch plan — ` +
              `execution identity must be durable BEFORE any mutation (use prepare()).`
          );
        }
      }
      throw new Error(`Stale transition for ${action_id}: not currently in '${from}'`);
    }
    return rowToAction(row);
  }

  async prepare(action_id: string, plan: DispatchPlan): Promise<ActionRecord> {
    assertTransition("intent_recorded", "prepared");
    const parsed = DispatchPlanSchema.parse(plan);
    const r = await this.db.query(
      `UPDATE outcome_actions SET internal_state='prepared', dispatch_plan=$2
       WHERE action_id=$1 AND internal_state='intent_recorded' RETURNING *`,
      [action_id, JSON.stringify(parsed)]
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error(`Stale transition for ${action_id}: not currently in 'intent_recorded'`);
    }
    return rowToAction(row);
  }
}

class PgEvidence implements EvidenceLedger {
  constructor(private db: PgClientLike) {}

  async append(ev: NewEvidence): Promise<EvidenceRecord> {
    // Serialize seq assignment per action via the (action_id, seq) unique
    // constraint + retry; deterministic order is DB-enforced.
    for (let attempt = 0; attempt < 25; attempt++) {
      const seqRow = await this.db.query(
        `SELECT COALESCE(MAX(seq),0)+1 AS next FROM outcome_evidence WHERE action_id=$1`,
        [ev.action_id]
      );
      const seq = Number(seqRow.rows[0]?.next ?? 1);
      const record = EvidenceRecordSchema.parse({
        ...ev,
        evidence_id: newUuid(),
        seq,
        // Computed by the ledger from the payload it stores.
        payload_hash: canonicalHash(ev.payload ?? null),
      });
      try {
        await this.db.query(
          `INSERT INTO outcome_evidence (
             evidence_id, action_id, seq, evidence_schema_version, source,
             verification_method, kind, strength, observed_disposition, attribution,
             provider_object_id,
             provider_event_id, observed_at, provider_timestamp, payload,
             payload_hash, correlation, signing, clock, supersedes_evidence_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            record.evidence_id, record.action_id, record.seq,
            record.evidence_schema_version, record.source, record.verification_method,
            record.kind, record.strength, record.observed_disposition, record.attribution,
            record.provider_object_id,
            record.provider_event_id, record.observed_at, record.provider_timestamp,
            JSON.stringify(record.payload ?? null), record.payload_hash,
            JSON.stringify(record.correlation),
            record.signing ? JSON.stringify(record.signing) : null,
            JSON.stringify(record.clock), record.supersedes_evidence_id,
          ]
        );
        return record;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/duplicate key.*action_id.*seq|outcome_evidence_action_id_seq/.test(msg)) continue;
        if (record.provider_event_id && /outcome_evidence_provider_event_uq/.test(msg)) {
          const duplicate = await this.db.query(
            `SELECT * FROM outcome_evidence WHERE action_id=$1 AND provider_event_id=$2`,
            [record.action_id, record.provider_event_id]
          );
          if (duplicate.rows[0]) {
            return (await this.listForAction(record.action_id)).find(
              (item) => item.evidence_id === duplicate.rows[0]!.evidence_id
            )!;
          }
        }
        if (/outcome_evidence_supersedes_same_action_fk/.test(msg)) {
          throw new Error(
            `supersedes_evidence_id ${record.supersedes_evidence_id} does not exist ` +
              `for this action — evidence may only supersede evidence of the SAME action`
          );
        }
        throw e;
      }
    }
    throw new Error("Failed to append evidence after contention retries");
  }

  async listForAction(action_id: string): Promise<EvidenceRecord[]> {
    const r = await this.db.query(
      `SELECT * FROM outcome_evidence WHERE action_id=$1 ORDER BY seq ASC`,
      [action_id]
    );
    return r.rows.map((row) =>
      EvidenceRecordSchema.parse({
        evidence_id: row.evidence_id,
        action_id: row.action_id,
        seq: Number(row.seq),
        evidence_schema_version: Number(row.evidence_schema_version),
        source: row.source,
        verification_method: row.verification_method,
        kind: row.kind,
        strength: row.strength,
        observed_disposition: row.observed_disposition,
        attribution: row.attribution,
        provider_object_id: row.provider_object_id ?? null,
        provider_event_id: row.provider_event_id ?? null,
        observed_at: new Date(row.observed_at as string | Date).toISOString(),
        provider_timestamp: row.provider_timestamp
          ? new Date(row.provider_timestamp as string | Date).toISOString()
          : null,
        payload: row.payload,
        payload_hash: row.payload_hash,
        correlation: row.correlation,
        signing: row.signing ?? null,
        clock: row.clock,
        supersedes_evidence_id: row.supersedes_evidence_id ?? null,
      })
    );
  }
}

class PgResolutions implements ResolutionStore {
  constructor(private db: PgClientLike) {}
  async save(r: OutcomeResolution): Promise<void> {
    OutcomeResolutionSchema.parse(r);
    await this.db.query(
      `INSERT INTO outcome_resolutions (
         resolution_id, resolution_version, action_id, effect_name, business_key,
         input_hash, effect_state, primary_directive, retry_disposition,
         continuation_disposition, recovery_disposition,
         effect_detail, control_decision, context,
         created_at, resolved_at, clock, signature, full_document, resolution_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        r.resolution_id, r.resolution_version, r.action_id, r.effect_name,
        r.business_key, r.input_hash, r.effect.state,
        r.control.primary, r.control.retry, r.control.continuation, r.control.recovery,
        JSON.stringify(r.effect),
        JSON.stringify(r.control), JSON.stringify(r.context),
        r.trust.created_at, r.trust.resolved_at, JSON.stringify(r.trust.clock),
        r.trust.signature ? JSON.stringify(r.trust.signature) : null,
        JSON.stringify(r), r.runtime?.resolution_sequence ?? null,
      ]
    );
  }
  async latestForAction(action_id: string): Promise<OutcomeResolution | null> {
    const r = await this.db.query(
      `SELECT full_document FROM outcome_resolutions
       WHERE action_id=$1
       ORDER BY resolution_sequence DESC NULLS LAST, resolved_at DESC, resolution_id DESC
       LIMIT 1`,
      [action_id]
    );
    const doc = r.rows[0]?.full_document;
    return doc ? OutcomeResolutionSchema.parse(doc) : null;
  }
}

function rowToRuntime(row: Record<string, unknown>): RuntimeState {
  return {
    action_id: String(row.action_id),
    dispatch_status: row.dispatch_status as DispatchStatus,
    dispatch_attempts: Number(row.dispatch_attempts),
    dispatch_claim_token: (row.dispatch_claim_token as string | null) ?? null,
    compensation_claim_token: (row.compensation_claim_token as string | null) ?? null,
    compensation_attempts: Number(row.compensation_attempts),
    resolution_sequence: Number(row.resolution_sequence),
    evidence_sequence: Number(row.evidence_sequence),
    next_check_at: row.next_check_at
      ? new Date(row.next_check_at as string | Date).toISOString()
      : null,
    last_effect_state: (row.last_effect_state as EffectState | null) ?? null,
  };
}

class PgRuntime implements RuntimeLedger {
  constructor(private db: PgClientLike) {}

  async initialize(action_id: string): Promise<RuntimeState> {
    await this.db.query(
      `INSERT INTO outcome_runtime (action_id, dispatch_status)
       VALUES ($1,'not_started') ON CONFLICT (action_id) DO NOTHING`,
      [action_id]
    );
    const state = await this.get(action_id);
    if (!state) throw new Error(`Runtime state missing after initialization for ${action_id}`);
    return state;
  }

  async get(action_id: string): Promise<RuntimeState | null> {
    const r = await this.db.query(`SELECT * FROM outcome_runtime WHERE action_id=$1`, [action_id]);
    return r.rows[0] ? rowToRuntime(r.rows[0]) : null;
  }

  async claimDispatch(
    action_id: string,
    allowed: readonly DispatchStatus[],
    guard?: DispatchGuard | undefined
  ): Promise<DispatchClaim> {
    if (allowed.length === 0) throw new Error("Dispatch claim requires at least one allowed status");
    const token = newUuid();
    const r = await this.db.query(
      `WITH continuation_guard AS MATERIALIZED (
         SELECT source.action_id
         FROM outcome_runtime source
         JOIN outcome_resolutions resolution
           ON resolution.resolution_id=$9::uuid
          AND resolution.action_id=source.action_id
         WHERE $6::uuid IS NOT NULL
           AND source.action_id=$6::uuid
           AND source.resolution_sequence=$7
           AND source.evidence_sequence=$8
           AND resolution.continuation_disposition='allowed'
           AND (resolution.full_document->'runtime'->>'resolution_sequence')::integer=$7
           AND (resolution.full_document->'runtime'->>'evidence_sequence')::integer=$8
         FOR UPDATE OF source
       )
       UPDATE outcome_runtime
       SET dispatch_status='claimed', dispatch_claim_token=$2,
           dispatch_attempts=dispatch_attempts+1, updated_at=now()
       WHERE action_id=$1 AND dispatch_status = ANY($3::text[])
         AND dispatch_attempts < 2
         AND ($4::integer IS NULL OR resolution_sequence=$4)
         AND ($5::integer IS NULL OR evidence_sequence=$5)
         AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM continuation_guard))
       RETURNING *`,
      [
        action_id,
        token,
        [...allowed],
        guard?.resolution_sequence ?? null,
        guard?.evidence_sequence ?? null,
        guard?.continuation?.action_id ?? null,
        guard?.continuation?.resolution_sequence ?? null,
        guard?.continuation?.evidence_sequence ?? null,
        guard?.continuation?.resolution_id ?? null,
      ]
    );
    if (r.rows[0]) return { claimed: true, token, state: rowToRuntime(r.rows[0]) };
    const state = await this.get(action_id);
    if (!state) throw new Error(`Runtime state missing for ${action_id}`);
    return { claimed: false, token: null, state };
  }

  async finishDispatch(
    action_id: string,
    token: string,
    status: Exclude<DispatchStatus, "claimed">
  ): Promise<RuntimeState> {
    const r = await this.db.query(
      `UPDATE outcome_runtime
       SET dispatch_status=$3, dispatch_claim_token=NULL, updated_at=now()
       WHERE action_id=$1 AND dispatch_status='claimed' AND dispatch_claim_token=$2
       RETURNING *`,
      [action_id, token, status]
    );
    if (!r.rows[0]) throw new Error(`Stale dispatch claim for ${action_id}`);
    return rowToRuntime(r.rows[0]);
  }

  async setDispatchStatus(
    action_id: string,
    from: DispatchStatus,
    to: Exclude<DispatchStatus, "claimed">
  ): Promise<RuntimeState> {
    const r = await this.db.query(
      `UPDATE outcome_runtime SET dispatch_status=$3, updated_at=now()
       WHERE action_id=$1 AND dispatch_status=$2 RETURNING *`,
      [action_id, from, to]
    );
    if (!r.rows[0]) throw new Error(`Stale dispatch status for ${action_id}: expected ${from}`);
    return rowToRuntime(r.rows[0]);
  }

  async claimCompensation(action_id: string): Promise<DispatchClaim> {
    const token = newUuid();
    const r = await this.db.query(
      `UPDATE outcome_runtime
       SET compensation_claim_token=$2, compensation_attempts=compensation_attempts+1,
           updated_at=now()
       WHERE action_id=$1 AND compensation_claim_token IS NULL AND compensation_attempts=0
       RETURNING *`,
      [action_id, token]
    );
    if (r.rows[0]) return { claimed: true, token, state: rowToRuntime(r.rows[0]) };
    const state = await this.get(action_id);
    if (!state) throw new Error(`Runtime state missing for ${action_id}`);
    return { claimed: false, token: null, state };
  }

  async finishCompensation(action_id: string, token: string): Promise<RuntimeState> {
    const r = await this.db.query(
      `UPDATE outcome_runtime SET compensation_claim_token=NULL, updated_at=now()
       WHERE action_id=$1 AND compensation_claim_token=$2 RETURNING *`,
      [action_id, token]
    );
    if (!r.rows[0]) throw new Error(`Stale compensation claim for ${action_id}`);
    return rowToRuntime(r.rows[0]);
  }

  async nextResolutionSequence(
    action_id: string,
    effect_state: EffectState,
    next_check_at: string | null
  ): Promise<number> {
    const r = await this.db.query(
      `UPDATE outcome_runtime
       SET resolution_sequence=resolution_sequence+1,
           last_effect_state=$2, next_check_at=$3, updated_at=now()
       WHERE action_id=$1 RETURNING resolution_sequence`,
      [action_id, effect_state, next_check_at]
    );
    const value = r.rows[0]?.resolution_sequence;
    if (value === undefined) throw new Error(`Runtime state missing for ${action_id}`);
    return Number(value);
  }
}

export async function createPostgresStore(databaseUrl: string): Promise<Store & { close(): Promise<void> }> {
  let PgMod: { Pool: new (cfg: { connectionString: string }) => PgPoolLike };
  try {
    PgMod = (await import("pg")) as unknown as typeof PgMod;
  } catch {
    throw new Error(
      "PostgresStore requires the optional 'pg' package (npm i pg). " +
        "Unit tests use MemoryStore; PG integration tests are gated on availability."
    );
  }
  const pool = new PgMod.Pool({ connectionString: databaseUrl });
  return {
    actions: new PgActions(pool),
    evidence: new PgEvidence(pool),
    resolutions: new PgResolutions(pool),
    runtime: new PgRuntime(pool),
    offboarding: new PostgresOffboardingRunLedger(pool),
    close: () => pool.end(),
  };
}
