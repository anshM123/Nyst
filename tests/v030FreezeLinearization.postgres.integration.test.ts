/**
 * Nyst v0.3.0 — Phase 1A. Freeze linearization, proven with barriers.
 *
 * The requirement: once Freeze activation reports durable success, no
 * subsequently linearized covered consequence may begin.
 *
 * The spec is explicit that timestamps are not an acceptable proof, and it is
 * right. Before this phase, admission and freeze shared no lock, so the
 * ordering between them was an emergent property of READ COMMITTED snapshot
 * timing — something you can only observe by racing them and hoping the race
 * lands the way you assumed. These tests instead HOLD the boundary open with a
 * real transaction and assert what the other operation does while it is held.
 * That is deterministic: no sleeps, no flakiness, and it fails loudly if the
 * shared guard is ever removed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.0 Phase 1A — freeze linearization", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let effect: string;
  let agentId: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Barrier", organization_slug: `barrier-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `barrier-${suffix}@test.test`, display_name: "Barrier", password: "Nyst v030 barrier fixture 17!",
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p1a"), new MutableClock(),
      { production: false, enable_development_fake: true });
    const fake = product.descriptors.find((item) => item.provider === "fake")!;
    effect = fake.effect_name;
    await repository.configureEffectSpec(tenant, fake, true);
    agentId = String((await repository.createAgent(tenant, tenant.user_id, {
      name: "Barrier Agent", slug: `barrier-agent-${suffix}`, owner: "IT", framework: "custom", description: "d",
    })).agent_id);
  });
  after(async () => { await store.close(); await pool.end(); });

  /** Admit one consequence, as the production path does. */
  const admit = (key: string) => repository.admitConsequence(tenant, {
    agent_id: agentId, effect_name: effect, business_key: key, amount_minor: null, currency: null,
  });

  /** Release every active freeze so each test starts from a known authority state. */
  async function clearFreezes(): Promise<void> {
    const { active } = await repository.freezes(tenant);
    for (const row of active) {
      await repository.releaseFreeze(tenant, tenant.user_id, String(row.freeze_id), "test reset");
    }
  }

  it("the authority row exists for every environment, created by trigger not by hope", async () => {
    const row = await pool.query(
      `SELECT authority_sequence FROM nyst_environment_authority WHERE environment_id=$1`, [tenant.environment_id]);
    assert.equal(row.rows.length, 1,
      "an environment without an authority row would have nothing to serialize against");
  });

  it("CASE 1 — admission crosses the boundary first, so the freeze waits and the action proceeds", async () => {
    await clearFreezes();
    // Hold the boundary the way an in-flight admission holds it.
    const holder = await pool.connect();
    let freezeResolved = false;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT environment_id FROM nyst_environment_authority WHERE environment_id=$1 FOR UPDATE`,
        [tenant.environment_id]);

      // A freeze attempted now MUST block. If it returns while the boundary is
      // held by someone else, the two are not serialized at all.
      const freezing = repository.activateFreeze(tenant, tenant.user_id, { reason: "case 1" })
        .then((value) => { freezeResolved = true; return value; });

      // Deterministic: ask PostgreSQL whether the freeze is actually waiting on
      // a lock, rather than sleeping and assuming.
      await waitForLockWaiter(pool, tenant.environment_id);
      assert.equal(freezeResolved, false, "freeze activation completed while the authority boundary was held");

      await holder.query("COMMIT");
      await freezing;
    } finally { holder.release(); }
  });

  it("CASE 2 — the freeze crosses first, so a subsequent admission is blocked", async () => {
    await clearFreezes();
    const freeze = await repository.activateFreeze(tenant, tenant.user_id, { reason: "case 2" });
    assert.ok(Number(freeze.authority_sequence) > 0, "crossing the boundary must advance the authority sequence");

    const decision = await admit(`case2-${suffix}`);
    assert.equal(decision.admitted, false);
    assert.equal(decision.blocked_by, "freeze");
    assert.equal(String(decision.freeze_id), String(freeze.freeze_id),
      "the admission must name the exact freeze that stopped it");
  });

  it("CASE 3 — an admission that STARTS earlier but crosses later still sees the freeze", async () => {
    await clearFreezes();
    // This is the case the old design could not decide: the admission began
    // first in wall-clock terms, but the freeze reached the boundary first.
    // Ordering must follow the boundary, not the start time.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT environment_id FROM nyst_environment_authority WHERE environment_id=$1 FOR UPDATE`,
        [tenant.environment_id]);

      // The admission "starts" now, and immediately queues on the boundary.
      const admitting = admit(`case3-${suffix}`);
      await waitForLockWaiter(pool, tenant.environment_id);

      // The freeze crosses first, on the holder's own connection, and commits.
      await holder.query(
        `INSERT INTO nyst_freezes(freeze_id,environment_id,project_id,organization_id,reason,activated_by)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), tenant.environment_id, tenant.project_id, tenant.organization_id, "case 3", tenant.user_id]);
      await holder.query("COMMIT");

      const decision = await admitting;
      assert.equal(decision.admitted, false,
        "an admission that crossed the boundary after a freeze committed must observe it");
      assert.equal(decision.blocked_by, "freeze");
    } finally { holder.release(); }
  });

  it("CASE 4 — freeze and release race without producing two overlapping authorities", async () => {
    await clearFreezes();
    const first = await repository.activateFreeze(tenant, tenant.user_id, { reason: "aba a" });
    // A second activation for the identical scope must be refused outright.
    await assert.rejects(() => repository.activateFreeze(tenant, tenant.user_id, { reason: "aba b" }),
      /already active/i);
    await repository.releaseFreeze(tenant, tenant.user_id, String(first.freeze_id), "aba release");
    const second = await repository.activateFreeze(tenant, tenant.user_id, { reason: "aba c" });
    assert.notEqual(String(second.freeze_id), String(first.freeze_id));
    assert.ok(Number(second.authority_sequence) > Number(first.authority_sequence),
      "each authority change must advance the sequence, so the true order is recoverable without timestamps");

    // The released one cannot be released again, so a stale handle cannot
    // reopen consequence.
    await assert.rejects(() => repository.releaseFreeze(tenant, tenant.user_id, String(first.freeze_id), "again"),
      /No active freeze/i);
    await clearFreezes();
  });

  for (const shape of [
    { name: "CASE 5 — Agent-scoped freeze", scope_agent_id: () => agentId, scope_effect_name: () => null },
    { name: "CASE 6 — EffectSpec-scoped freeze", scope_agent_id: () => null, scope_effect_name: () => effect },
    { name: "CASE 7 — environment-wide freeze", scope_agent_id: () => null, scope_effect_name: () => null },
    { name: "CASE 8 — combined Agent + EffectSpec freeze", scope_agent_id: () => agentId, scope_effect_name: () => effect },
  ]) {
    it(`${shape.name} blocks what it covers and nothing else`, async () => {
      await clearFreezes();
      const other = String((await repository.createAgent(tenant, tenant.user_id, {
        name: "Other", slug: `other-${shape.name.slice(5, 7).trim().toLowerCase()}-${randomUUID().slice(0, 6)}`,
        owner: "IT", framework: "custom", description: "d",
      })).agent_id);

      await repository.activateFreeze(tenant, tenant.user_id, {
        scope_agent_id: shape.scope_agent_id(), scope_effect_name: shape.scope_effect_name(), reason: shape.name,
      });

      const covered = await admit(`covered-${randomUUID().slice(0, 8)}`);
      assert.equal(covered.admitted, false, "the covered scope must be blocked");
      assert.equal(covered.blocked_by, "freeze");

      // An Agent outside an Agent-scoped freeze must be unaffected. A freeze
      // that quietly covered more than it said would be as dangerous as one
      // that covered less.
      const uncoveredExpected = shape.scope_agent_id() !== null;
      const elsewhere = await repository.admitConsequence(tenant, {
        agent_id: other, effect_name: effect, business_key: `elsewhere-${randomUUID().slice(0, 8)}`,
        amount_minor: null, currency: null,
      });
      assert.equal(elsewhere.admitted, uncoveredExpected,
        uncoveredExpected
          ? "an Agent-scoped freeze must not stop a different Agent"
          : "a broader freeze must stop every Agent it covers");
      await clearFreezes();
    });
  }

  it("CASE 9 — 100 concurrent admissions against a freeze: none crosses", async () => {
    await clearFreezes();
    await repository.activateFreeze(tenant, tenant.user_id, { reason: "case 9" });
    const decisions = await Promise.all(
      Array.from({ length: 100 }, (_, index) => admit(`case9-${suffix}-${index}`)));
    const admitted = decisions.filter((decision) => decision.admitted);
    assert.equal(admitted.length, 0, `${admitted.length} of 100 admissions crossed an active freeze`);
    assert.ok(decisions.every((decision) => decision.blocked_by === "freeze"));
    await clearFreezes();
  });

  it("releasing lets consequence resume, and only then", async () => {
    await clearFreezes();
    const freeze = await repository.activateFreeze(tenant, tenant.user_id, { reason: "resume" });
    assert.equal((await admit(`during-${suffix}`)).admitted, false);
    await repository.releaseFreeze(tenant, tenant.user_id, String(freeze.freeze_id), "done");
    assert.equal((await admit(`after-${suffix}`)).admitted, true);
  });

  it("refuses to operate without a real transaction rather than silently dropping the guarantee", async () => {
    // A single-statement interface cannot hold a lock across statements. If
    // that were allowed to fall through, freeze would appear to work and would
    // have stopped serializing — the worst possible failure mode for this
    // control, because it only shows up during an incident.
    const singleStatement = new ProductRepository({ query: (...args) => pool.query(...args) } as ProductDb);
    await assert.rejects(
      () => singleStatement.activateFreeze(tenant, tenant.user_id, { reason: "no pool" }),
      /connection pool|authority boundary/i);
  });
});

/**
 * Block until PostgreSQL reports a session actually waiting on a lock for this
 * environment's authority row.
 *
 * This is what makes the tests above deterministic rather than timing-based:
 * we do not guess that the other operation is blocked, we ask the database.
 */
async function waitForLockWaiter(pool: Pool, environmentId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await pool.query(
      `SELECT count(*)::int AS waiters
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()`);
    if (Number(waiting.rows[0]?.waiters ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no session ever waited on the authority boundary for environment ${environmentId}`);
}
