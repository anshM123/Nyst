/**
 * Nyst background worker host.
 *
 * Runs the reconciliation, recovery, re-observation and webhook-delivery loops
 * in a process SEPARATE from the web/API host. This is the deployment shape a
 * design partner should run: the API can restart, or be scaled, without
 * stranding ambiguous actions.
 *
 *   node --experimental-strip-types scripts/startWorker.ts
 *
 * Each loop records a heartbeat so an operator can tell a dead worker from an
 * idle one — an API that answers while its workers are dead is the single most
 * dangerous state a Nyst deployment can be in.
 */
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { ProductRepository } from "../dist/src/product/productRepository.js";
import { createProductProviderRuntime } from "../dist/src/product/providerRuntimeFactory.js";
import { InMemoryOperationalMetrics, NystReconciliationScheduler } from "../dist/src/product/scheduler.js";
import { NystDecisionWebhookWorker } from "../dist/src/product/webhookWorker.js";
import { NystRecoveryWorker, RecoveryExecutorRegistry } from "../dist/src/product/recoveryWorker.js";
import { NystReobservationWorker } from "../dist/src/product/reobservationWorker.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";
import { loadConfig, structuredLog } from "../dist/src/product/config.js";

const config = loadConfig();
const signer = config.signing.source === "ephemeral_development"
  ? Ed25519Signer.ephemeral("local-preview-software-key")
  : Ed25519Signer.fromEnv();

const store = await createPostgresStore(config.database_url);
const pg = await import("pg");
const pool = new pg.default.Pool({
  connectionString: config.database_url,
  ...(config.database_ssl.enabled ? { ssl: { rejectUnauthorized: config.database_ssl.reject_unauthorized } } : {}),
});
const repository = new ProductRepository(pool);
const product = createProductProviderRuntime(store, repository, signer, new LocalSystemClock(), {
  production: config.production, enable_development_fake: config.enable_development_fake,
});

const metrics = new InMemoryOperationalMetrics();
const scheduler = new NystReconciliationScheduler(pool, product.runtime, metrics, 30_000, repository);
const webhookWorker = new NystDecisionWebhookWorker(pool);
// Recovery executors are an explicit allowlist. With none registered, a
// recovery that never crossed the dispatch boundary is CANCELLED rather than
// executed — deliberately fail-safe for a deployment that has not opted in.
const recoveryWorker = new NystRecoveryWorker(repository, new RecoveryExecutorRegistry());
const reobservationWorker = new NystReobservationWorker(repository, product.runtime);

const intervalMs = Number(process.env.NYST_WORKER_INTERVAL_MS ?? "1000");
let running = true;
let inFlight: Promise<unknown> = Promise.resolve();

async function tick(): Promise<void> {
  // Every loop is independently failure-isolated: one provider outage must not
  // stop reconciliation for everything else.
  await settle("reconciliation", async () => { await scheduler.sync(); await scheduler.runOne(); });
  await settle("recovery", () => recoveryWorker.runOne());
  await settle("reobservation", () => reobservationWorker.runOne());
  await settle("webhook", () => webhookWorker.runOne());
}

async function settle(kind: "reconciliation" | "recovery" | "reobservation" | "webhook", work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
    await repository.recordWorkerHeartbeat(kind, config.worker_instance_id);
  } catch (error) {
    metrics.increment("scheduler_errors");
    structuredLog({ type: "worker_error", component: kind, error_code: error instanceof Error ? error.name : "unknown" });
  }
}

structuredLog({ type: "service_started", component: "nyst-worker", instance: config.worker_instance_id, interval_ms: intervalMs });

const timer = setInterval(() => { if (running) inFlight = tick(); }, intervalMs);

// Graceful shutdown: stop scheduling, let the current tick finish, then exit.
// A worker killed mid-claim is safe by design — the lease expires and the
// dispatch boundary decides what a reclaiming worker may do — but finishing
// cleanly avoids a needless reclaim cycle.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    clearInterval(timer);
    structuredLog({ type: "shutdown_started", component: "nyst-worker", signal });
    void inFlight
      .catch(() => undefined)
      .then(() => Promise.all([store.close(), pool.end()]))
      .then(() => { structuredLog({ type: "shutdown_complete", component: "nyst-worker" }); process.exit(0); })
      .catch(() => process.exit(1));
  });
}
