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
import { randomUUID } from "node:crypto";
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
import { OutcomeRepository } from "../dist/src/product/outcome/outcomeRepository.js";
import { OutcomeShadow } from "../dist/src/product/outcome/outcomeShadow.js";
import { EvidenceIngest, RelayCoordinator } from "../dist/src/product/outcome/evidenceIngest.js";
import { AuthorityRepository } from "../dist/src/product/authority/authorityRepository.js";
import { EntitlementRepository } from "../dist/src/product/entitlementRepository.js";
import { TenantCredentialStore } from "../dist/src/product/tenantCredentials.js";
import { registerPublicRoutes } from "../dist/src/public/publicRoutes.js";
import { InboundRepository } from "../dist/src/public/inboundRepository.js";
import { PasswordResetService } from "../dist/src/product/auth/passwordReset.js";
import { GoogleSignupService } from "../dist/src/product/auth/googleSignup.js";
import { smtpSettingsFromEnv } from "../dist/src/product/email.js";
import { SmtpEmailProvider } from "../dist/src/product/smtpEmail.js";
import { homePage } from "../dist/src/public/site.js";
import { FederatedRepository } from "../dist/src/product/auth/federatedRepository.js";
import { GoogleAuth, googleConfigFromEnv, httpGoogleTransport } from "../dist/src/product/auth/googleAuth.js";

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

/**
 * CUSTOMER-SUPPLIED CREDENTIALS (v0.3.3), if this deployment can hold them.
 *
 * Constructed at BOOT rather than lazily on the first connect request. A
 * misconfigured key should fail while somebody is watching a deploy log, not
 * when a customer is halfway through onboarding with a token in a form field.
 *
 * A deployment without the key is single-tenant — operator-configured `env:`
 * and `vault:` references still work — and it says so once here rather than
 * failing confusingly later. What it never does is quietly store plaintext.
 */
const tenantCredentials = TenantCredentialStore.configured(process.env.NYST_CREDENTIAL_KEY)
  ? new TenantCredentialStore(pool, process.env.NYST_CREDENTIAL_KEY)
  : null;
structuredLog({
  type: "credential_store",
  // Deliberately NOT named "..._credentials": the structured logger redacts any
  // field whose name contains "credential", which is correct and which turned
  // this boolean into "[redacted]" — an operator could not read the one fact
  // the line exists to report. Whether a key EXISTS is operational; the key
  // itself is never logged and never could be from here.
  self_serve_connections_enabled: tenantCredentials !== null,
  detail: tenantCredentials
    ? "Customers can connect their own providers through the UI."
    : "NYST_CREDENTIAL_KEY is not set to 32 base64 bytes, so the connect form will refuse rather than "
      + "store a credential in plaintext. Operator-configured env:/vault: references are unaffected.",
});

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
    /**
     * A NEW DEPLOYMENT STARTS IN SHADOW (v0.3.3).
     *
     * `createBootstrap` defaults to `enforced` and this call passed no mode, so
     * a fresh deployment came up CONTROLLING a production environment that
     * nobody had reviewed a single finding in. Every piece of copy in the
     * product says Nyst starts by evaluating and prevents nothing until you
     * decide otherwise; the deployment path did the opposite.
     *
     * Shadow is also the only honest default for a posture the operator has
     * not chosen yet. Moving out of it is now a deliberate act with a reason,
     * a commercial check and a readiness check behind it — see the control
     * posture panel in Settings.
     */
    mode: "shadow",
  });
  structuredLog({ type: "bootstrap_created", organization_id: bootstrapScope.organization_id });
}

/**
 * OPERATOR ENTITLEMENT GRANT (v0.3.3).
 *
 * Entitlement is deliberately NOT self-service — `setEntitlement` says so in
 * its own comment, because an organization upgrading itself is a billing
 * decision rather than a product setting. That is right, and it left the
 * operator of a deployment with no way to grant a plan at all: the method
 * exists, nothing calls it, and a free hosting tier has no shell to run a
 * script from. So every organization was permanently a trial and nobody could
 * ever leave Shadow.
 *
 * This is the OPERATOR's door, not the customer's. It requires two environment
 * variables that only somebody who controls the deployment can set, it names
 * one organization by slug rather than granting to everyone, and it goes
 * through the same `setEntitlement` path as any other change — so it writes
 * the same immutable audit row, with a reason saying where it came from.
 *
 * It is idempotent: setting the same plan twice changes nothing but the audit
 * trail, which is the correct record of an operator asserting it twice.
 */
const grantState = process.env.NYST_GRANT_ENTITLEMENT?.trim();
const grantOrg = process.env.NYST_GRANT_ENTITLEMENT_ORG?.trim();
if (grantState || grantOrg) {
  const states = ["trial", "protect", "scale", "enterprise"] as const;
  if (!grantState || !grantOrg) {
    structuredLog({
      type: "entitlement_grant_skipped",
      detail: "NYST_GRANT_ENTITLEMENT and NYST_GRANT_ENTITLEMENT_ORG must BOTH be set. Naming the "
        + "organization is required so a grant cannot silently apply to every tenant on the deployment.",
    });
  } else if (!(states as readonly string[]).includes(grantState)) {
    structuredLog({
      type: "entitlement_grant_refused",
      detail: `NYST_GRANT_ENTITLEMENT must be one of ${states.join(", ")}; received something else. `
        + "Refusing rather than guessing which plan was meant.",
    });
  } else {
    /**
     * SLUG **OR** NAME, case-insensitively.
     *
     * The slug is what somebody types in the Organization field at sign-in —
     * and a customer who signed up with Google never typed it at all, so
     * requiring it exactly meant guessing at your own identifier. Matching the
     * display name too costs nothing and removes the guess.
     */
    const org = (await pool.query(
      `SELECT organization_id,slug FROM nyst_organizations WHERE lower(slug)=lower($1) OR lower(name)=lower($1)`,
      [grantOrg])).rows[0];
    if (!org) {
      /**
       * NAME THE CANDIDATES.
       *
       * "No organization has that slug" is true and useless: it leaves the
       * operator guessing at an identifier they may never have typed. This is
       * the operator's OWN deployment log, where they can already see
       * everything, so listing what does exist is the difference between one
       * redeploy and several.
       */
      const existing = (await pool.query(
        `SELECT slug,name FROM nyst_organizations ORDER BY created_at LIMIT 20`)).rows
        .map((row) => `${String(row.slug)} (${String(row.name)})`);
      structuredLog({
        type: "entitlement_grant_refused",
        detail: `No organization matches "${grantOrg}" by slug or name, so nothing was changed.`,
        organizations_on_this_deployment: existing.length > 0 ? existing : ["none"],
      });
    } else {
      await new EntitlementRepository(pool).setEntitlement({
        organization_id: String(org.organization_id),
        state: grantState as "trial" | "protect" | "scale" | "enterprise",
        changed_by: null,
        reason: "Granted by the deployment operator through NYST_GRANT_ENTITLEMENT at startup.",
        note: "Operator grant. Not a customer self-service upgrade.",
      });
      structuredLog({
        type: "entitlement_granted", organization_slug: String(org.slug), state: grantState,
        detail: "This permits the organization to ASK for Canary or Enforced. Whether either is SAFE is "
          + "still decided independently by readiness, policy, the Autonomy Line, Freeze and Authority.",
      });
    }
  }
}

/**
 * THE RUNTIME NEEDS A SECRET PROVIDER, and never had one (v0.3.3).
 *
 * `createProductProviderRuntime` was called with no `secrets`, so every
 * provider client fell back to `EnvironmentGitHubCredentialSource` and friends
 * — which resolve exactly one hardcoded reference and refuse every other:
 *
 *     if (reference !== "env:NYST_GITHUB_TOKEN") throw "Unsupported ..."
 *
 * So a customer's connected credential passed the store, the resolver, the
 * admission gate, the input schema and two database constraints, and was then
 * refused by the credential source the action actually uses. Eleventh
 * appearance of this shape in one release, and the last one in the chain.
 *
 * `tenant:` references resolve by id here, which is safe ONLY because
 * `configureIntegration` refuses to store a reference that does not belong to
 * the configuring scope — so an integration cannot name another tenant's
 * credential, and an id reached through a tenant's own integration row is
 * always that tenant's.
 */
const runtimeSecrets = {
  async resolve(reference: string): Promise<string> {
    if (reference.startsWith("tenant:")) {
      if (!tenantCredentials) {
        throw new Error(
          "This deployment has no credential encryption key, so a customer-supplied credential cannot be "
          + "resolved. Set NYST_CREDENTIAL_KEY.");
      }
      return tenantCredentials.unscopedResolverForConfiguredReferences().resolve(reference);
    }
    return secrets.resolve(reference);
  },
};

const product = createProductProviderRuntime(store, repository, signer, clock, {
  production: config.production, enable_development_fake: config.enable_development_fake,
  secrets: runtimeSecrets,
});
if (bootstrapScope && config.enable_development_fake) {
  const fake = product.descriptors.find((item) => item.provider === "fake");
  if (fake) await repository.configureEffectSpec(bootstrapScope, fake, true);
}

const metrics = new InMemoryOperationalMetrics();
const outcomeRepository = new OutcomeRepository(pool);
const evidenceIngest = new EvidenceIngest(pool, outcomeRepository, secrets);

/**
 * Adapt the provider read-only preflight to the readiness probe contract.
 *
 * THE SECRET IS THE POINT (corrected in v0.3.3).
 *
 * This comment used to read "the resolved secret handed in here is
 * intentionally unused", because the clients resolved their own reference
 * internally — and the reference they resolved was a hardcoded operator
 * environment variable. So a customer's own credential was passed to this
 * function and thrown away, and no customer-supplied credential could ever be
 * verified. The rationalisation was written down and believed for two
 * releases.
 *
 * The secret is now forwarded, and the probe signature requires it, so a
 * version of this that forgets again does not compile.
 *
 * `provider_mutation_performed` is surfaced verbatim so a probe that ever
 * reported a mutation would be rejected rather than recorded (I20).
 */
const preflight = async (provider: "github" | "okta" | "stripe", secret: string) => {
  try {
    const result = await product.preflight(provider, secret) as Record<string, unknown>;
    // Optional fields are OMITTED rather than set to undefined: with
    // exactOptionalPropertyTypes an explicit undefined is a different thing
    // from an absent key, and the probe contract means "not observed".
    const identity = identityOf(result);
    const resource = typeof result.repository === "object" && result.repository
      ? String((result.repository as Record<string, unknown>).name ?? "") : undefined;
    return {
      ok: true as const,
      ...(identity === undefined ? {} : { account_identity: identity }),
      ...(resource === undefined ? {} : { resource }),
      // Only capabilities the probe actually proved by reading. Never a write.
      verified_capabilities: Array.isArray(result.verified_capabilities)
        ? result.verified_capabilities.filter((item): item is string => typeof item === "string") : [],
      /**
       * THE PROVIDER'S OWN SCOPE METADATA, forwarded (v0.3.3).
       *
       * This adapter dropped it. `observedCapabilities` maps native scope
       * strings to Nyst capability tokens and is the ONLY route to the
       * AUTHORIZED state — so with scopes never forwarded, no capability could
       * ever be authorized, and a write capability (which can never be
       * verified read-only) was permanently stuck at AVAILABLE: "the provider
       * supports this, but nothing has observed that this credential holds it".
       *
       * Readiness was therefore unsatisfiable for any workload requiring a
       * write, regardless of what the customer's token could actually do.
       */
      ...(Array.isArray(result.scopes_stated_by_provider) && result.scopes_stated_by_provider.length > 0
        ? { scopes: result.scopes_stated_by_provider.filter((item): item is string => typeof item === "string") }
        : {}),
      mutated: result.provider_mutation_performed === true,
    };
  } catch (error) {
    return { ok: false as const, failure_category: classify(error), detail: safeDetail(error) };
  }
};

/**
 * GOOGLE SIGN-IN.
 *
 * Absent unless a Google project is actually configured. When it is absent the
 * routes still exist and return a 503 explaining what is missing, rather than
 * a 404 on a button the login page rendered.
 *
 * The client secret is a REFERENCE resolved through the same SecretProvider as
 * every other credential, so the secret itself never appears in configuration
 * or in a log line.
 *
 * NOT VERIFIED AGAINST A LIVE GOOGLE PROJECT.
 * LIVE GOOGLE PROJECT CONFIGURATION REQUIRED.
 */
const federated = new FederatedRepository(pool);

/**
 * Google SIGNUP, as distinct from Google LOGIN.
 *
 * A brand-new Google identity used to hit a 404 telling it to go and sign up --
 * from the signup page. This carries the verified identity across the
 * workspace-name form and creates the workspace atomically.
 */
const googleSignups = new GoogleSignupService(pool);

const googleConfig = googleConfigFromEnv();
const google = googleConfig
  ? new GoogleAuth(googleConfig, federated, httpGoogleTransport(), secrets)
  : undefined;
if (!google) {
  structuredLog({
    type: "google_signin_unconfigured",
    detail: "Set NYST_GOOGLE_CLIENT_ID, NYST_GOOGLE_CLIENT_SECRET_REF and NYST_GOOGLE_REDIRECT_URI to enable Sign in with Google.",
  });
}

const app = await buildProductServer({
  repository, effect_specs: product.descriptors, runtime: product.runtime, metrics,
  production: config.production, secrets, trust_proxy: config.trust_proxy,
  verify_receipt: (value) => verifyResolution(signer, value as never),
  commit: product.commit, integration_preflight: preflight, structured_log: structuredLog,
  // The OUTCOME and AUTHORITY layers. Both read and write through the same
  // pool, so a single deployment answers all three questions: what may this
  // Agent do, what happened to the operation, and what became true.
  outcomes: outcomeRepository,
  authority: new AuthorityRepository(pool),
  /**
   * COMMERCIAL ENTITLEMENT (v0.3.3).
   *
   * `buildProductServer` constructs one when this is absent, so this is belt
   * and braces rather than the enforcement itself. Written out anyway, because
   * the defect being repaired here was a safety layer that existed everywhere
   * except the place it was needed.
   */
  entitlements: new EntitlementRepository(pool),
  /**
   * Present only when NYST_CREDENTIAL_KEY is configured. Absent, the connect
   * form answers 503 with the exact reason and operator-configured references
   * keep working — a single-tenant deployment is a coherent thing to be.
   */
  ...(tenantCredentials ? { tenant_credentials: tenantCredentials } : {}),
  shadow: new OutcomeShadow(pool, outcomeRepository),
  evidence: evidenceIngest,
  relay: new RelayCoordinator(pool, evidenceIngest),
  // Anonymous visitors get the marketing site at "/" rather than a redirect to
  // a sign-in page they have no account for.
  public_home: homePage,
  signer,
  federated,
  google_signup: googleSignups,
  ...(google ? { google } : {}),
});

// The public site shares the origin. It owns everything except "/", which the
// product server handles so a signed-in operator lands on their dashboard.
/**
 * Contact and quote submissions go to the database, not to nowhere.
 *
 * Before v0.3.1 neither sink was supplied anywhere in the repository, so every
 * message a visitor sent was validated, discarded, and answered with a
 * thank-you page.
 */
const inbound = new InboundRepository(pool);

/**
 * Outbound mail, and password recovery.
 *
 * Unconfigured is a legitimate state and every caller handles it: the reset
 * page says plainly that this deployment cannot send email rather than
 * pretending a link is on its way.
 */
const smtp = smtpSettingsFromEnv();
const emailProvider = smtp ? new SmtpEmailProvider(smtp, secrets) : null;
if (!smtp) {
  structuredLog({
    type: "email_transport_unconfigured",
    detail: "Set NYST_SMTP_HOST and NYST_EMAIL_FROM to enable password reset and lead notification.",
  });
}
const passwordResets = new PasswordResetService(
  pool, emailProvider, process.env.NYST_PUBLIC_ORIGIN ?? `http://${config.host}:${config.port}`);

registerPublicRoutes(app, {
  mount_root: false,
  record_contact: (submission) => inbound.recordContact(submission),
  record_quote: (quote) => inbound.recordQuote(quote),
  // Unset means no address is advertised at all, rather than one that bounces.
  ...(process.env.NYST_SALES_CONTACT_EMAIL
    ? { sales_contact_email: process.env.NYST_SALES_CONTACT_EMAIL }
    : {}),
  on_error: structuredLog,
  /**
   * Tell a human a lead arrived (v0.3.2 Phase 9).
   *
   * Called only AFTER the durable write, and its failure never fails the
   * submission -- the lead is already stored, and telling someone to resubmit a
   * message Nyst already has is both untrue and how leads get lost.
   *
   * Absent NYST_SALES_CONTACT_EMAIL or a mail transport, this is simply not
   * wired: the submission still lands in the database, which is where it
   * durably lives regardless.
   */
  ...(emailProvider && process.env.NYST_SALES_CONTACT_EMAIL ? {
    notify_lead: async (lead) => {
      await emailProvider.send({
        to: process.env.NYST_SALES_CONTACT_EMAIL!,
        subject: `Nyst ${lead.kind}: ${lead.company || lead.name} (${lead.reference})`,
        text: [
          `Reference: ${lead.reference}`,
          `Name:      ${lead.name}`,
          `Email:     ${lead.email}`,
          `Company:   ${lead.company || "(not given)"}`,
          ``,
          lead.summary,
          ``,
          `--`,
          `This email carries only what the visitor typed. No customer evidence, no receipts, no credentials.`,
        ].join(String.fromCharCode(10)),
      });
    },
  } : {}),
  password_reset: passwordResets,
  google_signup: {
    peek: (handle) => googleSignups.peek(handle),
    /**
     * Create the workspace and bind the Google identity ATOMICALLY.
     *
     * The handoff is consumed first, so two submissions of one form cannot
     * create two workspaces. If the workspace creation then fails, the handoff
     * is already spent -- deliberately: a failed signup should start again from
     * Google rather than replay a half-used identity.
     */
    complete: async (handle, input) => {
      const identity = await googleSignups.consume(handle);
      if (!identity) return { ok: false, reason: "That Google sign-in has expired. Start again." };
      try {
        const created = await repository.createBootstrap({
          organization: input.organization,
          organization_slug: input.organization_slug,
          project: "Platform", project_slug: "platform",
          environment: "Shadow", environment_slug: "shadow", mode: "shadow",
          email: identity.email, display_name: input.display_name,
          // A Google account signs in with Google. A random password exists
          // only because the column requires one, and nobody is ever told it;
          // password reset is the supported route to adding a local credential.
          password: randomUUID() + randomUUID(),
          initial_agent: {
            name: "First Agent", slug: "first-agent", owner: input.display_name,
            description: "Created with your workspace. Rename or replace it — nothing is bound to this name.",
            framework: "unspecified", tags: [],
          },
          federated_identity: {
            provider: "google", provider_subject: identity.provider_subject,
            email_at_link: identity.email, email_verified_at_link: identity.email_verified,
          },
        });

        const session = await federated.createSession(created.user_id);
        if (!session) return { ok: false, reason: "The workspace was created but the session could not be started. Sign in with Google again." };
        structuredLog({ type: "google_signup_created", organization_slug: input.organization_slug });
        return { ok: true, session: session.session };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/duplicate key|unique/i.test(message)) {
          return { ok: false, reason: `The short name "${input.organization_slug}" is already taken. Pick another.` };
        }
        structuredLog({ type: "google_signup_failed", detail: message });
        return { ok: false, reason: "The workspace could not be created. Nothing was created, and you can try again." };
      }
    },
  },
  /**
   * A real Shadow trial.
   *
   * The environment starts in SHADOW, which is what the plan says it is:
   * Nyst observes and evaluates, and controls nothing. Moving to Canary or
   * Enforced stays a deliberate, separate decision.
   *
   * A duplicate short name is reported as a duplicate short name. It is a
   * public identifier — you type it to sign in — so saying it is taken leaks
   * nothing, and pretending otherwise would just make people guess.
   */
  create_account: async (input) => {
    try {
      const created = await repository.createBootstrap({
        organization: input.organization,
        organization_slug: input.organization_slug,
        project: "Platform",
        project_slug: "platform",
        environment: "Shadow",
        environment_slug: "shadow",
        // SHADOW, explicitly. The schema default is 'enforced', which would
        // put a stranger who just signed up in the path of real consequence
        // while the signup page told them otherwise.
        mode: "shadow",
        email: input.email,
        display_name: input.display_name,
        password: input.password,
        initial_agent: {
          name: "First Agent", slug: "first-agent", owner: input.display_name,
          description: "Created with your workspace. Rename or replace it — nothing is bound to this name.",
          framework: "unspecified", tags: [],
        },
      });

      structuredLog({ type: "signup_created", organization_slug: input.organization_slug, mode: "shadow" });
      return { ok: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/duplicate key|unique/i.test(message)) {
        return { ok: false as const, reason: `The short name "${input.organization_slug}" is already taken. Pick another.` };
      }
      // Anything else is ours, not theirs. Log it with detail; tell them
      // something true and useful without a stack trace.
      structuredLog({ type: "signup_failed", organization_slug: input.organization_slug, error: message.slice(0, 200) });
      return { ok: false as const, reason: "Something went wrong creating the account. Nothing was created; please try again." };
    }
  },
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
  /**
   * STATUS CODES ARE CHECKED FIRST (v0.3.3).
   *
   * The `credential` word-match used to come first, so "GitHub rejected this
   * credential (401)" was classified `credential_unavailable` — "Nyst could not
   * find a credential" — when the truth was "the provider looked at it and said
   * no". Those send an operator to two completely different places: one is a
   * configuration problem, the other is an expired token.
   *
   * A provider's own status code is the stronger evidence, so it wins.
   */
  if (/401|unauthor|authentication/i.test(message)) return "authentication_failed";
  if (/403|permission|forbidden/i.test(message)) return "insufficient_permission";
  if (/unavailable: NYST_|credential/i.test(message)) return "credential_unavailable";
  if (/404|not found/i.test(message)) return "resource_missing";
  if (/topology|unsupported/i.test(message)) return "unsupported_topology";
  return "provider_unavailable";
}
function safeDetail(error: unknown): string {
  return (error instanceof Error ? error.message : "preflight failed").replace(/[\r\n]/g, " ").slice(0, 300);
}
