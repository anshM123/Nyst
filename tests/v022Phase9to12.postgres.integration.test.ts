/**
 * Nyst v0.2.2 — Phases 9-12.
 *
 *   Phase 9   Protection Report (grounded metrics, deterministic recommendation)
 *   Phase 10  Blast Radius Guard (concurrency-safe consequence budgets)
 *   Phase 11  Emergency Freeze (durable, restart-safe, race-proof)
 *   Phase 12  Policy templates on the existing engine
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { buildProductServer } from "../src/product/server.js";
import { TestSecretProvider } from "../src/product/secretProvider.js";
import { protectionReportCsv, recommendRollout } from "../src/product/protectionReport.js";
import { NYST_SAFETY_FLOOR, POLICY_TEMPLATES } from "../src/product/policyTemplates.js";
import { emptyMetrics, resolveRange } from "../src/product/canonicalMetrics.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phases 9-12", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let descriptors: ReturnType<typeof createProductProviderRuntime>["descriptors"];
  let effect: string;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let auth: { cookie: string; csrf: string };
  let agentId: string;
  const suffix = randomUUID().slice(0, 8);
  const password = "Nyst v022 guards fixture 58!";
  const secrets = new TestSecretProvider();

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });

    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Guards", organization_slug: `guards-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production", email: `sec-${suffix}@guards.test`, display_name: "Security", password,
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p912"), new MutableClock(), { production: false, enable_development_fake: true });
    descriptors = product.descriptors;
    const fake = descriptors.find((item) => item.provider === "fake")!;
    effect = fake.effect_name;
    await repository.configureEffectSpec(tenant, fake, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 300 });
    app = await buildProductServer({ repository, effect_specs: descriptors, runtime: product.runtime, commit: product.commit, production: false, secrets });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `guards-${suffix}`, email: `sec-${suffix}@guards.test`, password } });
    auth = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, csrf: login.json().csrf };
    agentId = (await repository.createAgent(tenant, tenant.user_id, { name: "HR Offboarding Agent", slug: `guards-agent-${suffix}`, owner: "IT" })).agent_id as string;
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const headers = () => ({ cookie: auth.cookie, "x-nyst-csrf": auth.csrf });
  const action = (key: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
    effect, businessKey: key, agent_id: agentId,
    input: { repository_id: key, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied", ...extra } } });

  /* ============================================================ PHASE 10 */

  it("P10: an action-count budget holds the consequence at exactly the threshold", async () => {
    const budgetAgent = (await repository.createAgent(tenant, tenant.user_id, { name: "Count Agent", slug: `count-agent-${suffix}`, owner: "IT" })).agent_id as string;
    await repository.createBlastRadiusBudget(tenant, tenant.user_id, { agent_id: budgetAgent, effect_name: effect, window_seconds: 3600, max_actions_per_window: 3 });
    const send = (key: string) => app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: key, agent_id: budgetAgent, input: { repository_id: key, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });

    for (let i = 1; i <= 3; i++) assert.equal((await send(`count-${i}-${suffix}`)).statusCode, 200, `action ${i} is inside the budget`);
    const blocked = await send(`count-4-${suffix}`);
    assert.equal(blocked.statusCode, 409, "the fourth action must be held");
    assert.match(JSON.parse(blocked.body).error ?? blocked.body, /invalid_request|conflict/i);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM outcome_actions WHERE business_key=$1`, [`${tenant.environment_id}:count-4-${suffix}`])).rows[0]!.c, 0,
      "a held consequence must never create a durable action");
    const decisions = await repository.blastRadiusDecisions(tenant);
    const held = decisions.find((row) => row.decision === "held");
    assert.ok(held, "the hold must be persisted with its numbers");
    assert.equal(held!.limit_kind, "action_count");
    assert.equal(Number(held!.limit_value), 3);
    const interventions = (await repository.canonicalMetrics(tenant)).recent_interventions;
    assert.ok(interventions.some((item) => item.kind === "blast_radius_hold"), "a durable intervention event is emitted");
  });

  it("P10: 2, 10 and 100 concurrent callers cannot race past the budget", async () => {
    for (const concurrency of [2, 10, 100]) {
      const raceAgent = (await repository.createAgent(tenant, tenant.user_id, { name: `Race ${concurrency}`, slug: `race-${concurrency}-${suffix}`, owner: "IT" })).agent_id as string;
      const limit = Math.max(1, Math.floor(concurrency / 4));
      await repository.createBlastRadiusBudget(tenant, tenant.user_id, { agent_id: raceAgent, effect_name: effect, window_seconds: 3600, max_actions_per_window: limit });
      const results = await Promise.all(Array.from({ length: concurrency }, (_, index) =>
        repository.admitConsequence(tenant, { agent_id: raceAgent, effect_name: effect, business_key: `race-${concurrency}-${index}-${suffix}`, amount_minor: null, currency: null })));
      const admitted = results.filter((item) => item.admitted).length;
      assert.equal(admitted, limit, `${concurrency} concurrent callers must admit exactly ${limit}, got ${admitted}`);
      const persisted = Number((await pool.query(
        `SELECT count(*)::int c FROM nyst_consequence_admissions WHERE environment_id=$1 AND agent_id=$2 AND admitted`,
        [tenant.environment_id, raceAgent])).rows[0]!.c);
      assert.equal(persisted, limit, "the durable ledger agrees with the returned decisions");
    }
  });

  it("P10: monetary budgets use structured EffectSpec amounts and fail closed without one", async () => {
    const moneyAgent = (await repository.createAgent(tenant, tenant.user_id, { name: "Refund Agent", slug: `refund-agent-${suffix}`, owner: "Finance" })).agent_id as string;
    await repository.createBlastRadiusBudget(tenant, tenant.user_id, { agent_id: moneyAgent, effect_name: effect, window_seconds: 3600, max_amount_minor_per_action: 500_000, max_amount_minor_per_window: 2_000_000, currency: "usd" });

    const withinLimit = await repository.admitConsequence(tenant, { agent_id: moneyAgent, effect_name: effect, business_key: `money-ok-${suffix}`, amount_minor: 400_000, currency: "usd" });
    assert.equal(withinLimit.admitted, true);

    const tooLarge = await repository.admitConsequence(tenant, { agent_id: moneyAgent, effect_name: effect, business_key: `money-big-${suffix}`, amount_minor: 600_000, currency: "usd" });
    assert.equal(tooLarge.admitted, false);
    assert.equal(tooLarge.limit_kind, "amount_per_action");

    const noAmount = await repository.admitConsequence(tenant, { agent_id: moneyAgent, effect_name: effect, business_key: `money-none-${suffix}`, amount_minor: null, currency: null });
    assert.equal(noAmount.admitted, false, "a monetary budget must fail closed when the effect carries no authoritative amount");
    assert.match(noAmount.reason, /no authoritative amount/i);

    const wrongCurrency = await repository.admitConsequence(tenant, { agent_id: moneyAgent, effect_name: effect, business_key: `money-eur-${suffix}`, amount_minor: 100_000, currency: "eur" });
    assert.equal(wrongCurrency.admitted, false);
    assert.match(wrongCurrency.reason, /currency/i);

    // Aggregate window: 400k already used. Three more at 450k each keeps the
    // per-action limit satisfied and reaches 1_750k of the 2_000k window.
    for (let i = 0; i < 3; i++) {
      const step = await repository.admitConsequence(tenant, { agent_id: moneyAgent, effect_name: effect, business_key: `money-step-${i}-${suffix}`, amount_minor: 450_000, currency: "usd" });
      assert.equal(step.admitted, true, `step ${i} is inside both limits`);
    }
    // A fourth 450k would reach 2_200k, over the window ceiling, even though it
    // is individually within the per-action limit.
    const overWindow = await repository.admitConsequence(tenant, { agent_id: moneyAgent, effect_name: effect, business_key: `money-window-${suffix}`, amount_minor: 450_000, currency: "usd" });
    assert.equal(overWindow.admitted, false);
    assert.equal(overWindow.limit_kind, "amount_per_window");
    assert.equal(Number(overWindow.observed_value), 2_200_000);
  });

  it("P10: budget decisions are immutable history", async () => {
    const row = (await pool.query(`SELECT decision_id FROM nyst_blast_radius_decisions WHERE environment_id=$1 LIMIT 1`, [tenant.environment_id])).rows[0]!;
    await assert.rejects(() => pool.query(`UPDATE nyst_blast_radius_decisions SET decision='admitted' WHERE decision_id=$1`, [row.decision_id]), /immutable/);
    await assert.rejects(() => pool.query(`DELETE FROM nyst_blast_radius_decisions WHERE decision_id=$1`, [row.decision_id]), /immutable/);
  });

  /* ============================================================ PHASE 11 */

  it("P11: a Freeze stops new consequence, keeps read-only work alive, and survives restart", async () => {
    const before = await action(`freeze-before-${suffix}`);
    assert.equal(before.statusCode, 200, before.body);
    const beforeActionId = before.json().action.action_id;

    const freeze = await app.inject({ method: "POST", url: "/v1/freezes", headers: headers(), payload: { reason: "suspected runaway agent" } });
    assert.equal(freeze.statusCode, 200, freeze.body);
    const freezeId = freeze.json().freeze_id;

    const blocked = await action(`freeze-blocked-${suffix}`);
    assert.equal(blocked.statusCode, 409, "no new consequential mutation may begin while frozen");
    assert.equal((await pool.query(`SELECT count(*)::int c FROM outcome_actions WHERE business_key=$1`, [`${tenant.environment_id}:freeze-blocked-${suffix}`])).rows[0]!.c, 0);

    // Read-only work is explicitly NOT frozen.
    const reconcile = await app.inject({ method: "POST", url: `/v1/actions/${beforeActionId}/reconcile`, headers: headers(), payload: {} });
    assert.equal(reconcile.statusCode, 200, `read-only reconciliation must continue during a freeze: ${reconcile.body}`);
    assert.equal((await app.inject({ method: "GET", url: `/v1/actions/${beforeActionId}/evidence`, headers: headers() })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/v1/actions/${beforeActionId}/receipt`, headers: headers() })).statusCode, 200);

    // A brand-new repository instance models a process restart: the freeze is
    // durable state, not in-memory.
    const restarted = new ProductRepository(pool);
    assert.equal((await restarted.freezeState(tenant)).frozen, true, "the freeze survives a restart");

    const released = await app.inject({ method: "POST", url: `/v1/freezes/${freezeId}/release`, headers: headers(), payload: { confirm: true, reason: "investigated" } });
    assert.equal(released.statusCode, 200, released.body);
    assert.equal((await action(`freeze-after-${suffix}`)).statusCode, 200, "the product continues normally after unfreeze");
  });

  it("P11: releasing a freeze requires explicit confirmation", async () => {
    const freeze = await app.inject({ method: "POST", url: "/v1/freezes", headers: headers(), payload: { reason: "confirm test" } });
    const id = freeze.json().freeze_id;
    assert.equal((await app.inject({ method: "POST", url: `/v1/freezes/${id}/release`, headers: headers(), payload: { reason: "no confirm" } })).statusCode, 400);
    assert.equal((await repository.freezeState(tenant)).frozen, true);
    assert.equal((await app.inject({ method: "POST", url: `/v1/freezes/${id}/release`, headers: headers(), payload: { confirm: true, reason: "done" } })).statusCode, 200);
  });

  it("P11: a Freeze racing 100 incoming actions lets nothing cross the boundary", async () => {
    const raceAgent = (await repository.createAgent(tenant, tenant.user_id, { name: "Freeze Race", slug: `freeze-race-${suffix}`, owner: "IT" })).agent_id as string;
    const admissions: Promise<{ admitted: boolean }>[] = [];
    for (let i = 0; i < 50; i++) admissions.push(repository.admitConsequence(tenant, { agent_id: raceAgent, effect_name: effect, business_key: `race-pre-${i}-${suffix}`, amount_minor: null, currency: null }));
    const freeze = await repository.activateFreeze(tenant, tenant.user_id, { reason: "race" });
    for (let i = 50; i < 100; i++) admissions.push(repository.admitConsequence(tenant, { agent_id: raceAgent, effect_name: effect, business_key: `race-post-${i}-${suffix}`, amount_minor: null, currency: null }));
    const results = await Promise.all(admissions);
    assert.equal(results.length, 100);

    // The invariant is not "how many were admitted" (the freeze commits partway
    // through) but that NOTHING was admitted after the freeze became visible.
    const afterFreeze = Number((await pool.query(
      `SELECT count(*)::int c FROM nyst_consequence_admissions ca, nyst_freezes f
       WHERE ca.environment_id=$1 AND ca.admitted AND f.freeze_id=$2 AND ca.decided_at > f.activated_at
         AND ca.business_key LIKE 'race-%'`,
      [tenant.environment_id, freeze.freeze_id])).rows[0]!.c);
    assert.equal(afterFreeze, 0, "no consequence may be admitted after the freeze boundary");
    await repository.releaseFreeze(tenant, tenant.user_id, String(freeze.freeze_id), "race complete");
  });

  it("P11: freeze/unfreeze cannot ABA into two overlapping authorities", async () => {
    const first = await repository.activateFreeze(tenant, tenant.user_id, { reason: "first" });
    await assert.rejects(() => repository.activateFreeze(tenant, tenant.user_id, { reason: "second" }), /already active/);
    await repository.releaseFreeze(tenant, tenant.user_id, String(first.freeze_id), "done");
    await assert.rejects(() => repository.releaseFreeze(tenant, tenant.user_id, String(first.freeze_id), "again"), /No active freeze/);
    await assert.rejects(() => pool.query(`UPDATE nyst_freezes SET released_at=NULL,released_by=NULL WHERE freeze_id=$1`, [first.freeze_id]), /immutable/);
    await assert.rejects(() => pool.query(`DELETE FROM nyst_freezes WHERE freeze_id=$1`, [first.freeze_id]), /immutable/);
    const second = await repository.activateFreeze(tenant, tenant.user_id, { reason: "after release" });
    await repository.releaseFreeze(tenant, tenant.user_id, String(second.freeze_id), "cleanup");
  });

  it("P11: a scoped Freeze only stops its own scope", async () => {
    const scopedAgent = (await repository.createAgent(tenant, tenant.user_id, { name: "Scoped", slug: `scoped-freeze-${suffix}`, owner: "IT" })).agent_id as string;
    const freeze = await repository.activateFreeze(tenant, tenant.user_id, { scope_agent_id: scopedAgent, reason: "one agent only" });
    const inside = await repository.admitConsequence(tenant, { agent_id: scopedAgent, effect_name: effect, business_key: `scoped-in-${suffix}`, amount_minor: null, currency: null });
    const outside = await repository.admitConsequence(tenant, { agent_id: agentId, effect_name: effect, business_key: `scoped-out-${suffix}`, amount_minor: null, currency: null });
    assert.equal(inside.admitted, false);
    assert.equal(inside.blocked_by, "freeze");
    assert.equal(outside.admitted, true, "an unrelated Agent keeps working");
    await repository.releaseFreeze(tenant, tenant.user_id, String(freeze.freeze_id), "cleanup");
  });

  /* ============================================================ PHASE 12 */

  it("P12: templates produce real versioned policies on the existing engine", async () => {
    const listed = await app.inject({ method: "GET", url: "/v1/policy-templates", headers: headers() });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().templates.length, 3);
    assert.deepEqual(listed.json().safety_floor, NYST_SAFETY_FLOOR);

    for (const template of POLICY_TEMPLATES) {
      const created = await app.inject({ method: "POST", url: `/v1/policy-templates/${template.template_id}`, headers: headers(), payload: { effect_name: effect } });
      assert.equal(created.statusCode, 200, created.body);
      const body = created.json();
      assert.equal(body.template_id, template.template_id);
      assert.equal(body.retry_mode, "never", "no template can enable an automatic retry");
      const stored = (await pool.query(`SELECT template_id,retry_mode,execution_mode FROM nyst_policy_versions WHERE policy_version_id=$1`, [body.policy_version_id])).rows[0]!;
      assert.equal(stored.template_id, template.template_id);
      assert.equal(stored.retry_mode, "never");
      assert.equal(stored.execution_mode, template.policy.execution_mode);
    }
  });

  it("P12: a customer may make a template stricter but never weaker than the floor", async () => {
    const stricter = await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: effect, execution_mode: "approval_required", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 60 });
    assert.equal(stricter.retry_mode, "never");
    // There is no representable policy value that enables automatic retry.
    await assert.rejects(() => pool.query(`UPDATE nyst_policy_versions SET retry_mode='always' WHERE policy_version_id=$1`, [stricter.policy_version_id]), /immutable/);
    await assert.rejects(() => pool.query(
      `INSERT INTO nyst_policy_versions(policy_version_id,environment_id,project_id,organization_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_by)
       VALUES($1,$2,$3,$4,$5,999,'automatic','always',true,true,300,$6)`,
      [randomUUID(), tenant.environment_id, tenant.project_id, tenant.organization_id, effect, tenant.user_id]),
      /retry_mode/, "the database itself refuses a policy that would allow automatic retry");
  });

  /* ============================================================ PHASE 9 */

  it("P9: the Protection Report is grounded, separated, and honest", async () => {
    const report = (await app.inject({ method: "GET", url: "/v1/protection-report?range=30d", headers: headers() })).json();
    assert.equal(report.range.label, "30d");
    assert.ok(report.metrics, "the report carries the canonical metric contract");
    assert.equal(report.enforced.unsafe_retries_prevented, report.metrics.unsafe_retries_prevented_enforced);
    assert.equal(report.shadow.unsafe_retries_detected, report.metrics.unsafe_retries_detected_shadow);
    assert.ok(Array.isArray(report.risk_by_agent) && report.risk_by_agent.length > 0);
    assert.ok(Array.isArray(report.risk_by_effect) && report.risk_by_effect.length > 0);
    assert.ok(report.honesty_notes.some((note: string) => /counterfactual/i.test(note)));
    assert.ok(report.honesty_notes.some((note: string) => /No monetary saving is estimated/i.test(note)));
    assert.equal(report.demonstrated_financial_exposure, null, "no authoritative amounts exist here, so no exposure is claimed");
    assert.doesNotMatch(JSON.stringify(report).toLowerCase(), /estimated savings|roi of|we saved/);
  });

  it("P9: the rollout recommendation is deterministic and states its inputs", async () => {
    const range = resolveRange("7d");
    const ready = [{ provider: "github", available: true, enabled: true, configured: true, credential_available: true, preflight_verified: true,
      capabilities_sufficient: true, missing_capabilities: [], capability_manifest: null,
      ready: true, last_preflight_at: new Date().toISOString(), last_preflight_status: "verified_ready" as const, preflight_stale: false,
      failure_category: null, reason: "ok", enabled_effect_specs: ["github.repository_permission_change"] }];
    const notReady = [{ ...ready[0]!, ready: false, preflight_verified: false, failure_category: "credential_unavailable" as const, reason: "credential missing" }];

    const blocked = recommendRollout({ metrics: { ...emptyMetrics("shadow", range), consequential_actions: 100 }, readiness: notReady, unresolved_incidents: 0 });
    assert.equal(blocked.result, "BLOCKED BY READINESS");
    assert.ok(blocked.considered.readiness_blockers.length > 0);

    const tooEarly = recommendRollout({ metrics: { ...emptyMetrics("shadow", range), consequential_actions: 2 }, readiness: ready, unresolved_incidents: 0 });
    assert.equal(tooEarly.result, "KEEP IN SHADOW");

    const canary = recommendRollout({ metrics: { ...emptyMetrics("shadow", range), consequential_actions: 20 }, readiness: ready, unresolved_incidents: 0 });
    assert.equal(canary.result, "CANARY");

    const incidentsOpen = recommendRollout({ metrics: { ...emptyMetrics("canary", range), consequential_actions: 200 }, readiness: ready, unresolved_incidents: 3 });
    assert.equal(incidentsOpen.result, "CANARY");
    assert.equal(incidentsOpen.considered.unresolved_incidents, 3);

    const enforce = recommendRollout({ metrics: { ...emptyMetrics("canary", range), consequential_actions: 200 }, readiness: ready, unresolved_incidents: 0 });
    assert.equal(enforce.result, "ENFORCE");

    // Determinism: identical inputs, identical output, 50 times.
    for (let i = 0; i < 50; i++) {
      assert.equal(recommendRollout({ metrics: { ...emptyMetrics("canary", range), consequential_actions: 200 }, readiness: ready, unresolved_incidents: 0 }).result, "ENFORCE");
    }
  });

  it("P9: CSV export is well-formed and neutralises spreadsheet formula injection", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/protection-report.csv", headers: headers() });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/csv/);
    const lines = response.body.split("\r\n");
    assert.equal(lines[0], "metric,value,definition");
    assert.ok(lines.some((line) => line.startsWith("unsafe_retries_prevented_enforced,")));

    const report = (await app.inject({ method: "GET", url: "/v1/protection-report", headers: headers() })).json();
    // Every cell in the export must be safe to open in a spreadsheet.
    const hostile = protectionReportCsv({ ...report, mode: "=cmd|'/c calc'!A1" as never,
      risk_by_effect: [{ effect_name: "+SUM(A1)", actions: 1, interventions: 0 }] });
    for (const line of hostile.split(CSV_ROW_SEPARATOR)) {
      for (const cell of splitCsvLine(line)) {
        assert.doesNotMatch(cell, /^[=+\-@]/, `a cell beginning with a formula character must be neutralised: ${cell}`);
      }
    }
    assert.ok(hostile.includes("'=cmd"), "the hostile value is preserved, but quoted so it cannot execute");
  });
});

const CSV_ROW_SEPARATOR = String.fromCharCode(13) + String.fromCharCode(10);

/** Minimal CSV splitter, sufficient for asserting on our own well-formed output. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = ""; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { cells.push(current); current = ""; }
    else current += char;
  }
  cells.push(current);
  return cells;
}
