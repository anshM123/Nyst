/** Local/design-partner Nyst control-plane host. Provider secrets stay in process environment. */
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { verifyResolution } from "../dist/src/engine/resolver.js";
import { ProductRepository } from "../dist/src/product/productRepository.js";
import { createProductProviderRuntime } from "../dist/src/product/providerRuntimeFactory.js";
import { InMemoryOperationalMetrics, NystReconciliationScheduler } from "../dist/src/product/scheduler.js";
import { buildProductServer } from "../dist/src/product/server.js";
import { NystDecisionWebhookWorker } from "../dist/src/product/webhookWorker.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";

const databaseUrl = required("DATABASE_URL");
const signer = process.env.NYST_LOCAL_EPHEMERAL_SIGNING === "true" && process.env.NODE_ENV !== "production"
  ? Ed25519Signer.ephemeral("local-preview-software-key") : Ed25519Signer.fromEnv();
const clock = new LocalSystemClock();
const store = await createPostgresStore(databaseUrl); const pg = await import("pg"); const pool = new pg.default.Pool({ connectionString: databaseUrl });
const repository = new ProductRepository(pool); const count = await pool.query(`SELECT count(*)::int count FROM nyst_organizations`); let bootstrapScope: Awaited<ReturnType<ProductRepository["createBootstrap"]>> | undefined;
if (Number(count.rows[0]?.count ?? 0) === 0) {
  bootstrapScope = await repository.createBootstrap({ organization: required("NYST_BOOTSTRAP_ORGANIZATION"), organization_slug: required("NYST_BOOTSTRAP_ORG_SLUG"), project: required("NYST_BOOTSTRAP_PROJECT"), project_slug: required("NYST_BOOTSTRAP_PROJECT_SLUG"), environment: required("NYST_BOOTSTRAP_ENVIRONMENT"), environment_slug: required("NYST_BOOTSTRAP_ENV_SLUG"), email: required("NYST_BOOTSTRAP_EMAIL"), display_name: required("NYST_BOOTSTRAP_DISPLAY_NAME"), password: required("NYST_BOOTSTRAP_PASSWORD") });
}
const production = process.env.NODE_ENV === "production"; const enableDevelopmentFake = process.env.NYST_ENABLE_DEVELOPMENT_FAKE === "true";
const product = createProductProviderRuntime(store, repository, signer, clock, { production, enable_development_fake: enableDevelopmentFake });
if (bootstrapScope && enableDevelopmentFake) {
  const fake = product.descriptors.find((item) => item.provider === "fake");
  if (fake) await repository.configureEffectSpec(bootstrapScope, fake, true);
}
const runtime = product.runtime;
const metrics = new InMemoryOperationalMetrics(); const scheduler = new NystReconciliationScheduler(pool, runtime, metrics,30_000,repository);
const app = await buildProductServer({ repository, effect_specs: product.descriptors, runtime, metrics, production, verify_receipt: (value) => verifyResolution(signer, value as never), commit: product.commit, integration_preflight:product.preflight, structured_log: event=>console.log(JSON.stringify({...event,service:"nyst-web",at:new Date().toISOString()})) });
const embeddedWorker=process.env.NYST_RUN_EMBEDDED_WORKER==="true"||!production;const webhookWorker=new NystDecisionWebhookWorker(pool);const timer=embeddedWorker?setInterval(() => { void scheduler.sync().then(() => Promise.all([scheduler.runOne(),webhookWorker.runOne()])).catch(() => metrics.increment("scheduler_errors")); }, 1_000):null;timer?.unref();
const port = Number(process.env.NYST_PORT ?? "4080");const host=process.env.NYST_HOST??(production?"0.0.0.0":"127.0.0.1"); await app.listen({ host, port }); console.log(JSON.stringify({type:"service_started",service:"nyst-web",host,port,embedded_worker:embeddedWorker}));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { if(timer)clearInterval(timer);void app.close().then(() => Promise.all([store.close(), pool.end()])).then(() => process.exit(0)); });
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
