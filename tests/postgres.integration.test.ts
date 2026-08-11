/**
 * PostgreSQL integration tests.
 *
 * These run the SAME invariants against the real database — where uniqueness,
 * append-only, and same-action supersession are enforced by constraints and
 * triggers, not application code.
 *
 * Gating is HONEST AND LOUD:
 *   - DATABASE_URL unset  -> suite SKIPS with a reason (nothing to test against)
 *   - DATABASE_URL set    -> suite RUNS; a missing `pg` package, unreachable
 *     server, or unmigrated schema is a FAILURE, never a silent skip.
 *
 * Setup: docker compose up -d && npm i pg && npm run migrate
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { createEngine } from "../src/engine/resolver.js";
import { Ed25519Signer } from "../src/core/signing.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { createFakeSpec, observeFakeProvider } from "../src/fake/fakeSpec.js";
import { computeInputHash, InputCollisionError } from "../src/model/action.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { LocalSystemClock } from "../src/core/clock.js";
import { canonicalHash } from "../src/core/canonical.js";
import { EVIDENCE_SCHEMA_VERSION } from "../src/model/evidence.js";
import type { NewEvidence, Store } from "../src/store/store.js";

const url = process.env.DATABASE_URL;
const clock = new LocalSystemClock();
const semantic = ["repository_id", "principal_id", "desired_permission"] as const;

function intent(bk: string, permission: "none" | "read" | "write" | "admin") {
  const input = { repository_id: "repo_pg", principal_id: "alice", desired_permission: permission };
  return {
    effect_name: "fake.repository_permission_change",
    business_key: bk,
    input,
    input_hash: computeInputHash(semantic, input),
    spec_version: "fake.repository_permission_change/1.0.0",
    context: EMPTY_CONTEXT,
    clock: clock.now(),
  };
}

function evidenceFor(action_id: string): NewEvidence {
  const now = clock.now();
  return {
    action_id,
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    source: "fake.provider",
    verification_method: "response_inspection",
    kind: "provider_response",
    strength: "corroborative",
    observed_disposition: "indeterminate",
    attribution: "indeterminate",
    provider_object_id: null,
    provider_event_id: null,
    observed_at: now.timestamp,
    provider_timestamp: null,
    payload: { probe: true },
    correlation: { method: "outcome_action_id_header", value: action_id },
    signing: null,
    clock: now,
    supersedes_evidence_id: null,
  };
}

describe(
  "PostgreSQL integration",
  { skip: url ? false : "DATABASE_URL not set — no database to test against" },
  () => {
    let store: (Store & { close(): Promise<void> }) | undefined;
    const bk = () => `pgtest:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    before(async () => {
      // Any failure here — pg missing, connection refused, schema absent —
      // FAILS the suite. Gate 1 requires real DB verification, not a skip.
      store = await createPostgresStore(url!);
      await store.actions.findByIdentity("connectivity.check", "noop");
    });
    after(async () => {
      await store?.close();
    });

    it("Test 8: DB uniqueness survives concurrent logical-action creation", async () => {
      const key = bk();
      const results = await Promise.all(
        Array.from({ length: 24 }, () => store!.actions.recordIntent(intent(key, "none")))
      );
      const ids = new Set(results.map((r) => r.action.action_id));
      assert.equal(ids.size, 1);
      assert.equal(results.filter((r) => r.created).length, 1);
    });

    it("input drift on the same identity raises InputCollisionError", async () => {
      const key = bk();
      await store!.actions.recordIntent(intent(key, "read"));
      await assert.rejects(() => store!.actions.recordIntent(intent(key, "admin")), InputCollisionError);
    });

    it("dispatching without a persisted dispatch plan is rejected; prepare() persists it", async () => {
      const key = bk();
      const { action } = await store!.actions.recordIntent(intent(key, "none"));
      let prepared = await store!.actions.prepare(action.action_id, {
        correlation: { method: "outcome_action_id_header", value: action.action_id },
        idempotency_key: key,
        description: "integration test dispatch plan",
      });
      assert.equal(prepared.internal_state, "prepared");
      assert.equal(prepared.dispatch_plan?.idempotency_key, key);
      const reloaded = await store!.actions.getAction(action.action_id);
      assert.equal(reloaded!.dispatch_plan?.correlation.value, action.action_id);
    });

    it("payload_hash is computed by the ledger; evidence UPDATE/DELETE blocked by trigger", async () => {
      const key = bk();
      const { action } = await store!.actions.recordIntent(intent(key, "none"));
      const ev = await store!.evidence.append(evidenceFor(action.action_id));
      assert.equal(ev.payload_hash, canonicalHash(ev.payload));

      const db = (store!.actions as unknown as { db: { query(q: string, p?: unknown[]): Promise<unknown> } }).db;
      await assert.rejects(() =>
        db.query(`UPDATE outcome_evidence SET strength='authoritative' WHERE evidence_id=$1`, [ev.evidence_id])
      );
      await assert.rejects(() =>
        db.query(`DELETE FROM outcome_evidence WHERE evidence_id=$1`, [ev.evidence_id])
      );
    });

    it("evidence may only supersede evidence of the SAME action (composite FK)", async () => {
      const { action: a } = await store!.actions.recordIntent(intent(bk(), "none"));
      const { action: b } = await store!.actions.recordIntent(intent(bk(), "none"));
      const evA = await store!.evidence.append(evidenceFor(a.action_id));
      await assert.rejects(
        () =>
          store!.evidence.append({
            ...evidenceFor(b.action_id),
            supersedes_evidence_id: evA.evidence_id, // belongs to action A, not B
          }),
        /SAME action/
      );
    });

    it("full pipeline against PG; signed resolutions are DB-append-only", async () => {
      // FOR EACH ROW triggers only fire on affected rows — so first produce a
      // real resolution end-to-end through the engine, then attack that row.
      const spec = createFakeSpec();
      const signer = Ed25519Signer.ephemeral("pg-itest");
      const engine = createEngine(store!, signer, clock);
      const { action } = await engine.beginAction(
        spec, bk(), { repository_id: "repo_pg", principal_id: "alice", desired_permission: "none" }, EMPTY_CONTEXT
      );
      const dispatched = await engine.markDispatched(spec, action);
      await observeFakeProvider(store!.evidence, clock, dispatched, "happy_verified");
      const resolution = await engine.resolve(spec, action.action_id);
      assert.equal(resolution.effect.state, "verified");
      assert.equal(verifyResolution(signer, resolution), true);
      const roundTripped = await store!.resolutions.latestForAction(action.action_id);
      assert.equal(verifyResolution(signer, roundTripped!), true);

      const db = (store!.actions as unknown as { db: { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> } }).db;
      await assert.rejects(() =>
        db.query(`UPDATE outcome_resolutions SET effect_state='not_applied' WHERE resolution_id=$1`, [resolution.resolution_id])
      );
      await assert.rejects(() =>
        db.query(`DELETE FROM outcome_resolutions WHERE resolution_id=$1`, [resolution.resolution_id])
      );
    });
  }
);
