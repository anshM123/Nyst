/**
 * Nyst v0.2.2 — Phases 22-23.
 *
 *   22 Outbound webhook hardening (re-verified, not assumed)
 *   23 Operational observability
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { NystDecisionWebhookWorker } from "../src/product/webhookWorker.js";
import { validateWebhookTarget, privateAddress, signWebhook, verifyWebhook } from "../src/product/controlPlane.js";
import { healthMetricsText } from "../src/product/operationalHealth.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";
import { runtimeInput } from "./runtimeHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phases 22-23", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let runtime: ReturnType<typeof createProductProviderRuntime>["runtime"];
  let effect: string;
  const suffix = randomUUID().slice(0, 8);
  const secret = "synthetic-webhook-secret-value-000000000";

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Wire", organization_slug: `wire-${suffix}`, project: "Wire", project_slug: "wireproject",
      environment: "Production", environment_slug: "production", email: `wire-${suffix}@wire.test`, display_name: "Wire", password: "Nyst v022 webhook fixture 66!",
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p2223"), new MutableClock(), { production: false, enable_development_fake: true });
    runtime = product.runtime;
    effect = product.descriptors.find((item) => item.provider === "fake")!.effect_name;
    await repository.configureEffectSpec(tenant, product.descriptors.find((item) => item.effect_name === effect)!, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 300 });
    await repository.configureWebhook(tenant, tenant.user_id, "https://events.example.com/nyst", "env:NYST_WEBHOOK_SECRET");
  });
  after(async () => { await store.close(); await pool.end(); });

  async function commit(key: string, scenario: string): Promise<string> {
    const result = await runtime.commit(effect, `${tenant.environment_id}:${key}`, runtimeInput(scenario, { repository_id: key }), EMPTY_CONTEXT, {
      establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, key),
    });
    await repository.recordResolutionTransition(result.action.action_id, result.resolution, "action_commit");
    return result.action.action_id;
  }

  const worker = (fetchImpl: typeof fetch, addresses: Array<{ address: string }>) =>
    new NystDecisionWebhookWorker(pool, { async resolve() { return secret; } }, fetchImpl, 30_000, async () => addresses, tenant.environment_id);

  /* ============================================================ PHASE 22 */

  it("P22: every unsafe webhook target class is rejected at configuration time", async () => {
    const unsafe = [
      "http://events.example.com/hook",            // wrong protocol
      "https://user:pass@events.example.com/hook", // URL credentials
      "https://127.0.0.1/hook",                    // loopback
      "https://[::1]/hook",                        // IPv6 loopback
      "https://169.254.169.254/latest/meta-data",  // cloud metadata service
      "https://10.0.0.5/hook",                     // private IPv4
      "https://192.168.1.5/hook",
      "https://172.16.0.5/hook",
      "https://100.64.0.5/hook",                   // carrier-grade NAT
      "https://[fd00::1]/hook",                    // unique local IPv6
      "https://[fe80::1]/hook",                    // link-local IPv6
      "https://localhost/hook",
      "https://service.internal/hook",
      "https://box.local/hook",
      "ftp://events.example.com/hook",             // unexpected protocol
      "https://events.example.com:8443/hook",      // non-443 port
    ];
    for (const target of unsafe) {
      assert.throws(() => validateWebhookTarget(target), `${target} must be rejected`);
      await assert.rejects(() => repository.configureWebhook(tenant, tenant.user_id, target, "env:NYST_WEBHOOK_SECRET"), `${target} must be rejected by the repository too`);
    }
    assert.ok(validateWebhookTarget("https://events.example.com/nyst"), "a public HTTPS host is accepted");
  });

  it("P22: the private-address classifier covers every reserved range", () => {
    for (const address of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "192.0.2.1", "100.64.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fc00::1", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
      assert.equal(privateAddress(address), true, `${address} must be classified private/unsafe`);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) {
      assert.equal(privateAddress(address), false, `${address} is public`);
    }
  });

  it("P22: DNS rebinding is defeated because delivery pins the resolved address", async () => {
    await commit(`rebind-${suffix}`, "definitely_applied");
    let attempted = 0;
    // A hostile resolver returns one public and one private address.
    const pinned = worker(async () => { attempted++; return new Response("", { status: 204 }); }, [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]);
    let attempt: Record<string, unknown> | undefined;
    for (let i = 0; i < 40 && !attempt; i++) {
      await pinned.runOne();
      attempt = (await pool.query(`SELECT a.error_code FROM nyst_webhook_attempts a JOIN nyst_webhook_events e USING(webhook_event_id)
        JOIN nyst_webhook_endpoints w USING(webhook_endpoint_id) WHERE w.environment_id=$1 ORDER BY a.attempted_at DESC LIMIT 1`, [tenant.environment_id])).rows[0];
    }
    assert.equal(attempted, 0, "no socket may be opened when ANY resolved address is unsafe");
    assert.equal(attempt?.error_code, "webhook_target_not_public");
  });

  it("P22: redirects are refused rather than followed", async () => {
    const actionId = await commit(`redirect-${suffix}`, "definitely_applied");
    await repository.recordResolutionTransition(actionId, await runtime.reconcile(actionId), "manual_reconcile");
    let sawRedirectOption = false;
    const redirecting = worker(async (_input, init) => { sawRedirectOption = init?.redirect === "error"; return new Response("", { status: 302, headers: { location: "https://127.0.0.1/" } }); }, [{ address: "93.184.216.34" }]);
    assert.equal(await redirecting.runOne(), true);
    assert.equal(sawRedirectOption, true, "the fetch must be configured to error on redirect, never to follow it");
    const attempt = (await pool.query(`SELECT response_status,error_code FROM nyst_webhook_attempts ORDER BY attempted_at DESC LIMIT 1`)).rows[0]!;
    assert.equal(attempt.response_status, 302);
    assert.equal(attempt.error_code, "webhook_http_302");
  });

  it("P22: deliveries are signed, replay-bounded, and tied to a stable event id", async () => {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ event_type: "effect.resolved" });
    const eventId = randomUUID();
    const signature = signWebhook(secret, timestamp, body, eventId);
    assert.match(signature, /^v1=[0-9a-f]{64}$/);
    assert.equal(verifyWebhook(secret, timestamp, body, signature, Date.now(), eventId), true);
    assert.equal(verifyWebhook(secret, timestamp, body, signature, Date.now(), randomUUID()), false, "the signature is bound to the event id");
    assert.equal(verifyWebhook(secret, timestamp, `${body} `, signature, Date.now(), eventId), false, "and to the exact body");
    assert.equal(verifyWebhook("a-different-secret-value-0000000000000", timestamp, body, signature, Date.now(), eventId), false);
    assert.equal(verifyWebhook(secret, timestamp, body, signature, Date.now() + 6 * 60_000, eventId), false, "a stale timestamp is refused");
  });

  it("P22: one logical event is delivered at most once per endpoint and attempts are durable", async () => {
    const actionId = await commit(`once-${suffix}`, "definitely_applied");
    const event = (await pool.query(`SELECT webhook_event_id FROM nyst_webhook_events WHERE action_id=$1 ORDER BY occurred_at LIMIT 1`, [actionId])).rows[0]!;
    let deliveries = 0;
    const delivering = worker(async () => { deliveries++; return new Response("", { status: 204 }); }, [{ address: "93.184.216.34" }]);
    for (let i = 0; i < 40; i++) {
      await delivering.runOne();
      const done = (await pool.query(`SELECT delivered_at FROM nyst_webhook_events WHERE webhook_event_id=$1`, [event.webhook_event_id])).rows[0]?.delivered_at;
      if (done) break;
    }
    const before = deliveries;
    for (let i = 0; i < 5; i++) await delivering.runOne();
    const redelivered = Number((await pool.query(`SELECT count(*)::int c FROM nyst_webhook_attempts WHERE webhook_event_id=$1`, [event.webhook_event_id])).rows[0]!.c);
    assert.equal(redelivered, 1, "a delivered event is never re-attempted");
    assert.ok(deliveries >= before, "other pending events may still be delivered");
    const attempt = (await pool.query(`SELECT webhook_attempt_id FROM nyst_webhook_attempts WHERE webhook_event_id=$1`, [event.webhook_event_id])).rows[0]!;
    await assert.rejects(() => pool.query(`UPDATE nyst_webhook_attempts SET response_status=500 WHERE webhook_attempt_id=$1`, [attempt.webhook_attempt_id]), /immutable/);
  });

  /* ============================================================ PHASE 23 */

  it("P23: an API that is alive while workers are dead reports UNHEALTHY", async () => {
    const health = await repository.operationalHealth();
    assert.equal(health.api.database_reachable, true);
    assert.equal(health.status, "unhealthy", "no worker has checked in, so the deployment is not healthy");
    assert.ok(health.problems.some((problem) => /never checked in/.test(problem)));
    for (const worker of health.workers) assert.equal(worker.healthy, false);
  });

  it("P23: heartbeats make the workers visibly healthy", async () => {
    for (const kind of ["reconciliation", "recovery", "reobservation", "webhook"] as const) {
      await repository.recordWorkerHeartbeat(kind, `instance-${suffix}`);
    }
    const health = await repository.operationalHealth();
    for (const worker of health.workers) {
      assert.equal(worker.healthy, true, `${worker.kind} must be healthy after a heartbeat`);
      assert.ok(Number(worker.seconds_since_heartbeat) < 5);
    }
    assert.ok(["ok", "degraded", "unhealthy"].includes(health.status));
  });

  it("P23: queue depths, stale leases and safety counters are all exposed", async () => {
    const health = await repository.operationalHealth();
    assert.deepEqual(health.queues.map((queue) => queue.queue).sort(), ["reconciliation", "recovery", "reobservation", "webhook"]);
    for (const queue of health.queues) {
      for (const field of ["pending", "in_flight", "stale_leases"] as const) {
        assert.equal(typeof queue[field], "number", `${queue.queue}.${field} must be a number`);
      }
    }
    assert.equal(typeof health.human_reviews_open, "number");
    assert.equal(typeof health.provider_preflight_failures_24h, "number");
    assert.equal(typeof health.freezes_active, "number");
    assert.equal(typeof health.blast_radius_holds_24h, "number");

    const text = healthMetricsText(health);
    for (const metric of ["nyst_api_up", "nyst_worker_healthy", "nyst_queue_depth", "nyst_stale_leases", "nyst_human_reviews_open", "nyst_freezes_active"]) {
      assert.ok(text.includes(metric), `${metric} must be exposed`);
    }
    // Nothing sensitive may appear in an operational surface.
    assert.doesNotMatch(text, /token|secret|password|credential|Bearer/i);
    assert.doesNotMatch(JSON.stringify(health), /token|secret|password|credential_ref/i);
  });

  it("P23: a dead worker mid-claim is visible as a stale lease", async () => {
    const actionId = await commit(`stale-${suffix}`, "transport_timeout");
    const review = await repository.openHumanReview(tenant, actionId, "stale lease proof");
    await repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "request_reobservation");
    const claim = (await repository.claimReobservation({ environment_id: tenant.environment_id }))!;
    await pool.query(`UPDATE nyst_reobservation_jobs SET claimed_until=now()-interval '1 hour' WHERE reobservation_job_id=$1`, [claim.reobservation_job_id]);
    const health = await repository.operationalHealth();
    const queue = health.queues.find((item) => item.queue === "reobservation")!;
    assert.ok(queue.stale_leases >= 1, "an expired claim is reported as a stale lease");
    assert.equal(health.status, "unhealthy");
    assert.ok(health.problems.some((problem) => /expired lease/.test(problem)));
  });
});
