/**
 * Nyst web/API host.
 *
 * Portable: this is an ordinary Node process that needs PostgreSQL, a port,
 * and environment variables. It does not depend on any development host,
 * an open browser, or hidden state.
 *
 *   node --experimental-strip-types scripts/startProduct.ts
 *
 * Production startup FAILS CLOSED on unsafe configuration — see
 * src/product/config.ts for the exact rules.
 */
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { verifyResolution } from "../dist/src/engine/resolver.js";
import { ProductRepository } from "../dist/src/product/productRepository.js";
import { createProductProviderRuntime } from "../dist/src/product/providerRuntimeFactory.js";
import { InMemoryOperationalMetrics, NystReconciliationScheduler } from "../dist/src/product/scheduler.js";
import { buildProductServer } from "../dist/src/product/server.js";
import { NystDecisionWebhookWorker } from "../dist/src/product/webhookWorker.js";
import { NystRecoveryWorker, RecoveryExecutorRegistry } from "../dist/src/product/recoveryWorker.js";
import { NystReobservationWorker } from "../dist/src/product/reobservationWorker.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";
import { EnvSecretProvider } from "../dist/src/product/secretProvider.js";
import { loadConfig, structuredLog } from "../dist/src/product/config.js";

const config = loadConfig();

const signer = config.signing.source === "ephemeral_development"
  ? Ed25519Signer.ephemeral("local-preview-software-key")
  : Ed25519Signer.fromEnv();
const clock = new LocalSystemClock();
const secrets = new EnvSecretProvider();

const store = await createPostgresStore(config.database_url);
const pg = await import("pg");
const pool = new pg.default.Pool({
  connectionString: config.database_url,
  ...(config.database_ssl.enabled ? { ssl: { rejectUnauthorized: config.database_ssl.reject_unauthorized } } : {}),
});
const repository = new ProductRepository(pool);

// First boot only: create the initial organization from explicit environment.
const count = await pool.query(`SELECT count(*)::int count FROM nyst_organizations`);
let bootstrapScope: Awaited<ReturnType<ProductRepository["createBootstrap"]>> | undefined;
if (Number(count.rows[0]?.count ?? 0) === 0 && process.env.NYST_BOOTSTRAP_ORGANIZATION) {
  bootstrapScope = await repository.createBootstrap({
    organization: required("NYST_BOOTSTRAP_ORGANIZATION"), organization_slug: required("NYST_BOOTSTRAP_ORG_SLUG"),
    project: required("NYST_BOOTSTRAP_PROJECT"), project_slug: required("NYST_BOOTSTRAP_PROJECT_SLUG"),
    environment: required("NYST_BOOTSTRAP_ENVIRONMENT"), environment_slug: required("NYST_BOOTSTRAP_ENV_SLUG"),
    email: required("NYST_BOOTSTRAP_EMAIL"), display_name: required("NYST_BOOTSTRAP_DISPLAY_NAME"),
    password: required("NYST_BOOTSTRAP_PASSWORD"),
  });
  structuredLog({ type: "bootstrap_created", organization_id: bootstrapScope.organization_id });
}

const product = createProductProviderRuntime(store, repository, signer, clock, {
  production: config.production, enable_development_fake: config.enable_development_fake,
});
if (bootstrapScope && config.enable_development_fake) {
  const fake = product.descriptors.find((item) => item.provider === "fake");
  if (fake) await repository.configureEffectSpec(bootstrapScope, fake, true);
}

const metrics = new InMemoryOperationalMetrics();

/**
 * Adapt the provider read-only preflight to the readiness probe contract.
 *
 * The provider clients resolve their own credential reference internally and
 * never return it, so the resolved secret handed in here is intentionally
 * unused. `provider_mutation_performed` is surfaced verbatim so a probe that
 * ever reported a mutation would be rejected rather than recorded (I20).
 */
const preflight = async (provider: "github" | "okta" | "stripe", _secret: string) => {
  try {
    const result = await product.preflight(provider) as Record<string, unknown>;
    return {
      ok: true as const,
      account_identity: identityOf(result),
      resource: typeof result.repository === "object" && result.repository
        ? String((result.repository as Record<string, unknown>).name ?? "") : undefined,
      mutated: result.provider_mutation_performed === true,
    };
  } catch (error) {
    return { ok: false as const, failure_category: classify(error), detail: safeDetail(error) };
  }
};

const app = await buildProductServer({
  repository, effect_specs: product.descriptors, runtime: product.runtime, metrics,
  production: config.production, secrets, trust_proxy: config.trust_proxy,
  verify_receipt: (value) => verifyResolution(signer, value as never),
  commit: product.commit, integration_preflight: preflight, structured_log: structuredLog,
});

// In development a single process runs everything so `npm run start:product`
// is genuinely all you need. In production the workers are separate processes
// (scripts/startWorker.ts) unless explicitly embedded.
const scheduler = new NystReconciliationScheduler(pool, product.runtime, metrics, 30_000, repository);
const webhookWorker = new NystDecisionWebhookWorker(pool);
const recoveryWorker = new NystRecoveryWorker(repository, new RecoveryExecutorRegistry());
const reobservationWorker = new NystReobservationWorker(repository, product.runtime);
const timer = config.run_embedded_worker
  ? setInterval(() => {
      void scheduler.sync()
        .then(() => Promise.all([
          scheduler.runOne(), webhookWorker.runOne(), recoveryWorker.runOne(), reobservationWorker.runOne(),
          repository.recordWorkerHeartbeat("reconciliation", config.worker_instance_id),
          repository.recordWorkerHeartbeat("recovery", config.worker_instance_id),
          repository.recordWorkerHeartbeat("reobservation", config.worker_instance_id),
          repository.recordWorkerHeartbeat("webhook", config.worker_instance_id),
        ]))
        .catch(() => metrics.increment("scheduler_errors"));
    }, 1_000)
  : null;
timer?.unref();

await app.listen({ host: config.host, port: config.port });
structuredLog({
  type: "service_started", component: "nyst-web", host: config.host, port: config.port,
  production: config.production, embedded_worker: config.run_embedded_worker,
  signing_key_id: config.signing.key_id, signing_source: config.signing.source,
});

// Graceful shutdown: stop accepting, finish in-flight work, release the pool.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    structuredLog({ type: "shutdown_started", signal });
    if (timer) clearInterval(timer);
    void app.close()
      .then(() => Promise.all([store.close(), pool.end()]))
      .then(() => { structuredLog({ type: "shutdown_complete" }); process.exit(0); })
      .catch(() => process.exit(1));
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function identityOf(result: Record<string, unknown>): string | undefined {
  if (typeof result.tenant === "string") return result.tenant;
  const account = result.account as { id?: unknown } | undefined;
  if (account && typeof account.id === "string") return account.id;
  const repository = result.repository as { owner?: unknown } | undefined;
  if (repository && typeof repository.owner === "string") return repository.owner;
  return undefined;
}
function classify(error: unknown): "credential_unavailable" | "authentication_failed" | "insufficient_permission" | "resource_missing" | "unsupported_topology" | "provider_unavailable" {
  const message = error instanceof Error ? error.message : String(error);
  if (/unavailable: NYST_|credential/i.test(message)) return "credential_unavailable";
  if (/401|unauthor|authentication/i.test(message)) return "authentication_failed";
  if (/403|permission|forbidden/i.test(message)) return "insufficient_permission";
  if (/404|not found/i.test(message)) return "resource_missing";
  if (/topology|unsupported/i.test(message)) return "unsupported_topology";
  return "provider_unavailable";
}
function safeDetail(error: unknown): string {
  return (error instanceof Error ? error.message : "preflight failed").replace(/[\r\n]/g, " ").slice(0, 300);
}
