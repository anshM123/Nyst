import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { APP_CSS, APP_JS, LOGIN_JS, PRODUCT_ENHANCEMENT_CSS } from "./assets.js";
import { actionPage, actionsPage, agentsPage, effectRegistryPage, failureLabPage, genericPage, integrationsPage, loginPage, needsAttentionPage, offboardingPage, onboardingPage, overviewPage, policiesPage, protectionPage, receiptPage, receiptsPage, reviewsPage, settingsPage, type ShellContext } from "./dashboard.js";
import { digest, ProductRepository } from "./productRepository.js";
import type { PreflightProbeResult } from "./readiness.js";
import type { SecretProvider } from "./secretProvider.js";
import { NYST_SAFETY_FLOOR } from "./policyTemplates.js";
import { healthMetricsText } from "./operationalHealth.js";
import { LAB_EFFECT } from "./failureLabEngine.js";

/** Single source of the product version string. */
export const NYST_VERSION = "0.3.0";
import { protectionReportCsv } from "./protectionReport.js";
import { proofPackHtml, type ProofPack } from "./proofPack.js";
import { CANONICAL_OFFBOARDING_STAGES, CANONICAL_OFFBOARDING_SUMMARY } from "../offboarding/canonicalStages.js";
import { authoritativeConsequenceMetadata } from "./effectSemantics.js";
import { shellPage } from "./dashboard.js";
import { autonomyPage, failureLab2Page, outcomePage, outcomesPage, shadowReportPage } from "./outcomeViews.js";
import { OUTCOME_FAULTS, runNystBench, runOutcomeFault, type OutcomeFault } from "./outcome/failureLab2.js";
import type { OutcomeShadow } from "./outcome/outcomeShadow.js";
import type { EvidenceIngest, RelayCoordinator, RelayOperation } from "./outcome/evidenceIngest.js";
import { RELAY_OPERATIONS } from "./outcome/evidenceIngest.js";
import { subjectReferences as subjectReferencesFor } from "./outcome/outcomeRepository.js";
import type { OutcomeRepository } from "./outcome/outcomeRepository.js";
import type { AuthorityRepository } from "./authority/authorityRepository.js";
import { sanitizeForProduct } from "./sanitize.js";
import type { EffectSpecDescriptor, ProductCommitter, ProductContext, ProductPrincipal } from "./types.js";
import type { InMemoryOperationalMetrics } from "./scheduler.js";

const SESSION_COOKIE = "nyst_session";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_SCOPES = new Set(["actions:read", "actions:write", "receipts:read", "integrations:read"]);

/**
 * Read the optional `Idempotency-Key` request header.
 *
 * Idempotency is opt-in per request, but once a key is supplied the guarantee
 * is unconditional: the operation runs at most once and an exact replay returns
 * the stored response without re-running anything.
 */
/** Print-quality standalone HTML wrapper for a Proof Pack. */
function proofPackDocument(pack: ProofPack): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Nyst Proof Pack</title><link rel="stylesheet" href="/assets/app.css">` +
    `</head><body class="document">${proofPackHtml(pack)}</body></html>`;
}

function optionalInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw Object.assign(new Error("Limits must be positive integers"), { statusCode: 400 });
  return value;
}

function metricRange(value: unknown): "24h" | "7d" | "30d" | "custom" | "all" {
  const text = value === undefined ? "7d" : String(value);
  if (text !== "24h" && text !== "7d" && text !== "30d" && text !== "custom" && text !== "all") {
    throw Object.assign(new Error("range must be one of 24h, 7d, 30d, custom, all"), { statusCode: 400 });
  }
  return text;
}

function idempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

export interface ProductServerOptions {
  repository: ProductRepository;
  commit?: ProductCommitter;
  effect_specs: readonly EffectSpecDescriptor[];
  verify_receipt?: (receipt: unknown) => boolean;
  runtime?: { reconcile(actionId: string): Promise<unknown>; authorizeContinuation(actionId: string, resolutionId: string): Promise<void> };
  metrics?: InMemoryOperationalMetrics;
  production?: boolean;
  structured_log?: (event: Record<string, unknown>) => void;
  /** Resolves opaque credential references. Required for readiness/preflight. */
  secrets?: SecretProvider;
  /**
   * Bounded READ-ONLY provider probe. Receives the resolved secret directly and
   * must never mutate provider state (I20).
   */
  integration_preflight?: (provider: "github" | "okta" | "stripe", secret: string) => Promise<PreflightProbeResult>;
  /**
   * Trust X-Forwarded-* headers.
   *
   * Only enable when Nyst genuinely sits behind a proxy you control. Trusting
   * these headers from an untrusted network lets any client claim any client
   * IP, which turns the per-IP rate limiter into decoration. Leaving it off
   * behind a real proxy has the opposite failure: every request appears to
   * come from the proxy and shares one rate-limit bucket.
   */
  trust_proxy?: boolean;
  /** The OUTCOME layer. Optional so an atomic-only deployment still runs. */
  outcomes?: OutcomeRepository;
  /** The AUTHORITY layer. */
  authority?: AuthorityRepository;
  /** Outcome Shadow: independent evaluation of a customer's existing Agents. */
  shadow?: OutcomeShadow;
  /** Renders the public marketing home for an anonymous visitor at "/". */
  public_home?: () => string;
  /** Customer-pushed observations, for systems Nyst has no integration with. */
  evidence?: EvidenceIngest;
  /** Scoped signed reads performed inside the customer's own network. */
  relay?: RelayCoordinator;
  /** Signs Outcome Receipts and ContinuationGrants. */
  signer?: { sign(content: unknown): { key_id: string; signature_b64: string; algorithm: "ed25519"; canonicalization: "ojc-1" }; verify(content: unknown, sig: { key_id: string; signature_b64: string; algorithm: "ed25519"; canonicalization: "ojc-1" }): boolean };
}

export async function buildProductServer(options: ProductServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, bodyLimit: 64 * 1024, requestIdHeader: false, genReqId: () => randomUUID(),
    trustProxy: options.trust_proxy === true,
  });
  await app.register(cookie);
  const limiter = new Map<string, { count: number; reset: number }>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Nyst-Request-Id", request.id);
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header("X-Content-Type-Options", "nosniff"); reply.header("Referrer-Policy", "no-referrer"); reply.header("X-Frame-Options", "DENY");
    // Production is HTTPS-only (config.ts enforces an https public origin), so
    // a downgrade to plaintext is always an attack rather than a fallback.
    if (options.production === true) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    const key = request.ip; const now = Date.now(); const current = limiter.get(key);
    if (!current || current.reset <= now) limiter.set(key, { count: 1, reset: now + 60_000 });
    else if (++current.count > 300) { return reply.code(429).send({ error: "rate_limited", request_id: request.id }); }
  });
  app.addHook("onResponse", async(request,reply)=>options.structured_log?.({type:"http_request",request_id:request.id,method:request.method,path:request.routeOptions.url,status_code:reply.statusCode}));
  /**
   * Error shape.
   *
   * A 500 says nothing beyond a request id: an unexpected failure may carry a
   * stack, a query, or a value we have not vetted. A deliberate 4xx is the
   * opposite — it is a refusal Nyst chose to make, and the operator needs to
   * know WHY. Before this, "no webhook endpoint is configured" reached the
   * dashboard as "internal_error", which is both alarming and useless.
   *
   * Only messages from errors we threw ourselves with an explicit statusCode
   * are surfaced, and they are stripped of newlines and truncated.
   */
  app.setErrorHandler((error: unknown, request, reply) => {
    options.metrics?.increment("provider_or_request_errors");
    const candidate = error && typeof error === "object" && "statusCode" in error ? Number((error as { statusCode?: unknown }).statusCode) : 500;
    const status = candidate >= 400 && candidate < 500 ? candidate : 500;
    if (status === 500) return reply.code(500).send({ error: "internal_error", request_id: request.id });
    const message = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 200) : "";
    reply.code(status).send({ error: "invalid_request", ...(message ? { detail: message } : {}), request_id: request.id });
  });

  app.get("/assets/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(APP_CSS+PRODUCT_ENHANCEMENT_CSS));
  app.get("/assets/login.js", async (_request, reply) => reply.type("application/javascript; charset=utf-8").send(LOGIN_JS));
  app.get("/assets/app.js", async (_request, reply) => reply.type("application/javascript; charset=utf-8").send(APP_JS));
  for(const asset of ["nyst-mark.png","nyst-wordmark.png","nyst-domain-wordmark.png","favicon.png"] as const)app.get(`/brand/${asset}`,async(_request,reply)=>reply.type("image/png").send(readFileSync(join(process.cwd(),"public","brand",asset))));
  // Liveness: is this process up at all? Deliberately unauthenticated and
  // dependency-free so a load balancer can use it.
  app.get("/health",async()=>({status:"ok",service:"nyst-web",version:NYST_VERSION}));
  // Readiness: can this process actually serve? Requires the database.
  app.get("/ready",async(_request,reply)=>{try{await options.repository.health();return {status:"ready",service:"nyst-web",version:NYST_VERSION}}catch{return reply.code(503).send({status:"not_ready",reason:"database_unreachable"})}});

  /**
   * Operational health (Phase 23). PROTECTED: it reveals queue depths and
   * worker liveness, which is operational intelligence. It never reveals a
   * credential, a credential reference, or a provider payload.
   */
  app.get("/v1/operational-health", api(async (principal,request)=>{requireAnyScope(principal,["actions:read","integrations:read"]);const health=await options.repository.operationalHealth();const query=request.query as {format?:unknown};if(String(query.format??"json")==="prometheus")return healthMetricsText(health);return health;},options.repository));
  app.get("/login", async (_request, reply) => reply.type("text/html; charset=utf-8").send(loginPage()));
  app.post("/v1/auth/login", async (request, reply) => {
    const body = object(request.body); const organization = string(body.organization, 63); const email = string(body.email, 320); const password = string(body.password, 1024);
    // A malformed organization or email is not an error — it is simply not a
    // valid credential, and it must be refused exactly like a wrong password.
    // Previously the slug validator threw a bare Error, so typing an
    // organization's DISPLAY NAME ("Acme Corporation") into the login form
    // produced a 500. That is both a broken first impression and a small
    // oracle: it distinguished "malformed" from "wrong", which an attacker can
    // use to learn which organization names are even syntactically plausible.
    const wellFormed = /^[A-Za-z][A-Za-z0-9-]{1,62}$/.test(organization)
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    const result = wellFormed ? await options.repository.login(organization, email, password) : null;
    if (!result) return reply.code(401).send({ error: "invalid_credentials", request_id: request.id });
    reply.setCookie(SESSION_COOKIE, result.session, { path: "/", httpOnly: true, sameSite: "strict", secure: options.production === true, maxAge: 12 * 60 * 60 });
    return { csrf: result.csrf, expires_in: 12 * 60 * 60 };
  });
  app.post("/v1/auth/logout", async (request, reply) => { const principal = await apiPrincipal(request, reply, options.repository); if (!principal) return; requireCsrf(request, principal); const session = request.cookies[SESSION_COOKIE]; if (session) await options.repository.deleteSession(session); reply.clearCookie(SESSION_COOKIE, { path: "/" }); return { ok: true }; });


  /**
   * Shell context every page shares: where you are, what mode you are in,
   * whether anything is frozen, and how many incidents are waiting.
   *
   * Read from persisted state on every render, never cached, so the freeze
   * banner and the attention badge cannot go stale.
   */
  async function pageContext(principal: ProductPrincipal): Promise<ShellContext> {
    const [info, control, freezes, attention, tenantContext] = await Promise.all([
      options.repository.projectInfo(principal),
      options.repository.environmentControl(principal),
      options.repository.freezeState(principal),
      options.repository.needsAttention(principal),
      options.repository.context(principal),
    ]);
    const active = freezes.freezes[0];
    return {
      project: String(info?.project ?? ""),
      environment: String(info?.environment ?? ""),
      mode: control.mode,
      attention: attention.length,
      projects: tenantContext.projects,
      selected_project_id: tenantContext.selected_project_id,
      selected_environment_id: tenantContext.selected_environment_id,
      frozen: active ? {
        reason: String(active.reason ?? ""),
        actor: String(active.activated_by_name ?? "an operator"),
        since: String(active.activated_at ?? ""),
        scope: active.scope_agent_name || active.scope_effect_name
          ? [active.scope_agent_name, active.scope_effect_name].filter(Boolean).join(" · ")
          : "the whole environment",
      } : null,
    };
  }

  /**
   * The root.
   *
   * A signed-in operator gets their dashboard. Everyone else gets the public
   * site — not a redirect to /login, which is a hostile thing to do to someone
   * who arrived from a search result and wants to read about the product.
   *
   * The public home is rendered by the marketing module when it is mounted; a
   * product-only deployment falls back to the sign-in page.
   */
  app.get("/", async (request, reply) => {
    const principal = await authenticate(request, options.repository);
    if (principal?.kind === "session") {
      const context = await options.repository.context(principal);
      const page = overviewPage(await options.repository.overview(principal), await pageContext(principal));
      return reply.type("text/html; charset=utf-8").send(page.replace("<!--NYST_CONTEXT-->", contextSwitcher(context)));
    }
    // An API key presenting itself at a dashboard page is a client doing
    // something it should not; it gets a clear refusal rather than a redirect
    // to a login form it cannot complete.
    if (principal) {
      return reply.code(403).type("text/html; charset=utf-8").send(genericPage("Session required",
        "Dashboard pages require a browser session; API keys are limited to versioned API endpoints."));
    }
    if (options.public_home) return reply.type("text/html; charset=utf-8").send(options.public_home());
    return reply.redirect("/login");
  });
  /** The dashboard's own address, for an unambiguous link from anywhere. */
  app.get("/overview", pageHandler(async (principal) => overviewPage(await options.repository.overview(principal), await pageContext(principal)), options.repository));
  app.get("/needs-attention", pageHandler(async (principal) => needsAttentionPage(await options.repository.needsAttention(principal), await pageContext(principal)), options.repository));
  app.get("/agents", pageHandler(async (principal) => agentsPage(await options.repository.agents(principal), await pageContext(principal)), options.repository));
  app.get("/actions", pageHandler(async (principal, request) => { const selected = filters(request.query); return actionsPage(await options.repository.listActions(principal, selected), "Actions", selected, await pageContext(principal)); }, options.repository));
  app.get("/actions/:id", pageHandler(async (principal, request, reply) => {
    const id = routeId(request);
    const action = await options.repository.actionDetail(principal, id);
    if (!action) return reply.code(404).type("text/html").send(genericPage("Not found", "That action does not exist in this environment."));
    const [evidence, resolutions, context] = await Promise.all([
      options.repository.evidence(principal, id), options.repository.resolutions(principal, id), pageContext(principal),
    ]);
    return actionPage(action, evidence ?? [], resolutions ?? [], context);
  }, options.repository));
  app.get("/protection", pageHandler(async (principal) => {
    if (!options.secrets) return genericPage("Protection", "No SecretProvider is configured, so readiness cannot be evaluated.");
    const [report, readiness, context] = await Promise.all([
      options.repository.protectionReport(principal, options.secrets, "all"),
      options.repository.goLiveMatrix(principal, options.secrets, options.effect_specs),
      pageContext(principal),
    ]);
    return protectionPage(report, readiness, context);
  }, options.repository));
  app.get("/effect-specs", pageHandler(async (principal) => effectRegistryPage(await registryView(options.repository, principal, options.effect_specs, options.production === true, options.secrets ?? null), await pageContext(principal)), options.repository));
  app.get("/effect-registry", pageHandler(async (principal) => effectRegistryPage(await registryView(options.repository, principal, options.effect_specs, options.production === true, options.secrets ?? null), await pageContext(principal)), options.repository));
  app.get("/policies", pageHandler(async (principal) => policiesPage(await options.repository.policyHistory(principal), await pageContext(principal)), options.repository));
  app.get("/receipts", pageHandler(async (principal) => receiptsPage(await options.repository.listActions(principal), await pageContext(principal)), options.repository));
  app.get("/receipts/:id", pageHandler(async (principal, request, reply) => {
    const id = routeId(request);
    const action = await options.repository.actionDetail(principal, id);
    const receipt = await options.repository.receipt(principal, id);
    if (!action || !receipt) return reply.code(404).type("text/html").send(genericPage("Not found", "That receipt does not exist in this environment."));
    return receiptPage(action, receipt, options.verify_receipt ? options.verify_receipt(receipt) : null, await pageContext(principal));
  }, options.repository));
  app.get("/exports/:id", api(async (principal,request,reply)=>{requireScope(principal,"receipts:read");const receipt=await options.repository.receipt(principal,routeId(request));if(!receipt)return reply.code(404).send({error:"not_found",request_id:request.id});reply.header("Content-Disposition",`attachment; filename="nyst-${routeId(request)}.json"`);return {receipt:sanitizeForProduct(receipt),signature_valid:options.verify_receipt?options.verify_receipt(receipt):null};},options.repository));
  app.get("/integrations", pageHandler(async (principal) => {
    const readiness = options.secrets ? await options.repository.integrationsReadiness(principal, options.secrets) : [];
    return integrationsPage(readiness as unknown as Record<string, unknown>[], await options.repository.effectSpecStatuses(principal, options.effect_specs, options.production === true, options.secrets ?? null), await pageContext(principal));
  }, options.repository));
  /* ---------------- OUTCOMES (Phases 18-32) ---------------- */

  app.get("/outcomes", pageHandler(async (principal) => {
    if (!options.outcomes) return genericPage("Outcomes", "The Outcome layer is not enabled in this deployment.");
    return shellPage("Outcomes", "/outcomes",
      outcomesPage(
        await outcomeListView(options.outcomes, principal),
        (await options.outcomes.contracts(principal)) as unknown as Record<string, unknown>[]),
      await pageContext(principal));
  }, options.repository));

  app.get("/outcomes/:id", pageHandler(async (principal, request) => {
    if (!options.outcomes) return genericPage("Outcome", "The Outcome layer is not enabled in this deployment.");
    const view = await outcomeDetailView(options, principal, routeId(request));
    if (!view) return genericPage("Not found", "That outcome does not exist in this environment.");
    return shellPage("Outcome", "/outcomes", outcomePage(view), await pageContext(principal));
  }, options.repository));

  app.get("/autonomy", pageHandler(async (principal) => {
    if (!options.authority) return genericPage("Autonomy Line", "The Authority layer is not enabled in this deployment.");
    return shellPage("Autonomy Line", "/autonomy",
      autonomyPage(
        (await options.authority.autonomyRules(principal)) as unknown as Record<string, unknown>[],
        await options.authority.decisions(principal, 20)),
      await pageContext(principal));
  }, options.repository));

  app.get("/v1/outcomes", api(async (principal) => {
    requireScope(principal, "actions:read");
    return requireOutcomes(options).instances(principal);
  }, options.repository));

  app.get("/v1/outcomes/:id", api(async (principal, request, reply) => {
    requireScope(principal, "actions:read");
    const instance = await requireOutcomes(options).instance(principal, routeId(request));
    return instance === null ? notFound(reply, request) : instance;
  }, options.repository));

  app.get("/v1/outcomes/:id/evaluations", api(async (principal, request) => {
    requireScope(principal, "actions:read");
    return requireOutcomes(options).evaluations(principal, routeId(request));
  }, options.repository));

  app.get("/v1/outcomes/:id/receipt", api(async (principal, request, reply) => {
    requireScope(principal, "receipts:read");
    const receipt = await requireOutcomes(options).receipt(principal, routeId(request));
    return receipt === null ? notFound(reply, request) : receipt;
  }, options.repository));

  app.get("/v1/outcome-contracts", api(async (principal) => {
    requireAnyScope(principal, ["actions:read", "integrations:read"]);
    return requireOutcomes(options).contracts(principal);
  }, options.repository));

  app.post("/v1/outcome-contracts", api(async (principal, request) => {
    sessionOnly(principal); requireCsrf(request, principal);
    const body = object(request.body);
    const idempotent = await options.repository.idempotent(principal, "outcome_contract.create", idempotencyKey(request), body,
      async () => requireOutcomes(options).createContractFromPack(principal, principal.user_id!, string(body.outcome_spec, 80), {
        modules: body.modules === undefined ? [] : strings(body.modules, 10),
        agent_id: body.agent_id === undefined || body.agent_id === null ? null : string(body.agent_id, 36),
      }));
    return idempotent.value;
  }, options.repository));

  app.post("/v1/outcome-contracts/:id/activate", api(async (principal, request, reply) => {
    sessionOnly(principal); requireCsrf(request, principal);
    const activated = await requireOutcomes(options).activateContract(principal, routeId(request));
    return activated ? { activated: true } : notFound(reply, request);
  }, options.repository));

  app.post("/v1/outcomes", api(async (principal, request) => {
    requireScope(principal, "actions:write"); requireCsrf(request, principal);
    const body = object(request.body);
    const idempotent = await options.repository.idempotent(principal, "outcome.open", idempotencyKey(request), body,
      async () => requireOutcomes(options).openInstance(principal, {
        outcome_contract_id: string(body.outcome_contract_id, 36),
        agent_id: await options.repository.resolveActingAgent(principal, body.agent_id === undefined || body.agent_id === null ? null : string(body.agent_id, 36)),
        subject: object(body.subject),
        subject_key: string(body.subject_key, 400),
        mode: (await options.repository.environmentControl(principal)).mode,
      }));
    return idempotent.value;
  }, options.repository));

  app.post("/v1/outcomes/:id/evaluate", api(async (principal, request) => {
    requireScope(principal, "actions:write"); requireCsrf(request, principal);
    const capabilities = options.secrets
      ? (await options.repository.integrationsReadiness(principal, options.secrets))
          .flatMap((item) => (item.capability_manifest?.capabilities ?? [])
            .filter((capability) => capability.state === "verified" || capability.state === "authorized")
            .map((capability) => capability.capability))
      : [];
    return requireOutcomes(options).evaluate(principal, routeId(request), { held_capabilities: capabilities });
  }, options.repository));

  app.post("/v1/outcomes/:id/receipt", api(async (principal, request) => {
    requireScope(principal, "actions:write"); requireCsrf(request, principal);
    if (!options.signer) throw Object.assign(new Error("No signing identity is configured"), { statusCode: 503 });
    return requireOutcomes(options).issueReceipt(principal, routeId(request), options.signer as never);
  }, options.repository));

  /** Record an observation of the world. Never a consequence, always a read. */
  app.post("/v1/world-facts", api(async (principal, request) => {
    requireScope(principal, "actions:write"); requireCsrf(request, principal);
    const body = object(request.body);
    return requireOutcomes(options).recordFact(principal, {
      subject_ref: string(body.subject_ref, 400),
      provider: string(body.provider, 60),
      property: string(body.property, 80),
      value: object(body.value) as never,
      observed_at: string(body.observed_at, 40),
      fresh_until: string(body.fresh_until, 40),
      source_type: string(body.source_type, 40) as never,
      authoritative: body.authoritative === true,
      adapter_version: string(body.adapter_version, 80),
    });
  }, options.repository));

  /* ---------------- AUTHORITY (Phases 28-31) ---------------- */

  app.get("/v1/autonomy-rules", api(async (principal) => {
    requireAnyScope(principal, ["actions:read", "integrations:read"]);
    return requireAuthority(options).autonomyRules(principal);
  }, options.repository));

  app.post("/v1/autonomy-rules", api(async (principal, request) => {
    sessionOnly(principal); requireCsrf(request, principal);
    const body = object(request.body);
    const disposition = string(body.disposition, 20);
    if (disposition !== "autonomous" && disposition !== "human" && disposition !== "disabled") {
      throw Object.assign(new Error("An Autonomy Line disposition is autonomous, human or disabled. There is no score."), { statusCode: 400 });
    }
    const idempotent = await options.repository.idempotent(principal, "autonomy_rule.create", idempotencyKey(request), body,
      async () => requireAuthority(options).createAutonomyRule(principal, principal.user_id!, {
        agent_id: body.agent_id === undefined || body.agent_id === null ? null : string(body.agent_id, 36),
        effect_name: body.effect_name === undefined || body.effect_name === null ? null : string(body.effect_name, 200),
        outcome_spec: body.outcome_spec === undefined || body.outcome_spec === null ? null : string(body.outcome_spec, 80),
        max_amount_minor: optionalInteger(body.max_amount_minor),
        currency: body.currency === undefined || body.currency === null ? null : string(body.currency, 3),
        max_actions_per_window: optionalInteger(body.max_actions_per_window),
        max_amount_minor_per_window: optionalInteger(body.max_amount_minor_per_window),
        window_seconds: optionalInteger(body.window_seconds),
        requires_reversible: body.requires_reversible === true,
        requires_no_open_incident: body.requires_no_open_incident === true,
        requires_outcome_satisfied: body.requires_outcome_satisfied === undefined || body.requires_outcome_satisfied === null
          ? null : string(body.requires_outcome_satisfied, 80),
        disposition, rationale: string(body.rationale, 1000),
      }));
    return idempotent.value;
  }, options.repository));

  app.get("/v1/authority-exceptions", api(async (principal) => {
    requireAnyScope(principal, ["actions:read", "integrations:read"]);
    return requireAuthority(options).exceptionHistory(principal);
  }, options.repository));

  app.post("/v1/authority-exceptions", api(async (principal, request) => {
    sessionOnly(principal); requireCsrf(request, principal);
    const body = object(request.body);
    const idempotent = await options.repository.idempotent(principal, "authority_exception.create", idempotencyKey(request), body,
      async () => requireAuthority(options).createException(principal, principal.user_id!, {
        kind: string(body.kind, 40) as never,
        agent_id: body.agent_id === undefined || body.agent_id === null ? null : string(body.agent_id, 36),
        effect_name: body.effect_name === undefined || body.effect_name === null ? null : string(body.effect_name, 200),
        outcome_instance_id: body.outcome_instance_id === undefined || body.outcome_instance_id === null ? null : string(body.outcome_instance_id, 36),
        authorizes: string(body.authorizes, 60) as never,
        max_amount_minor: optionalInteger(body.max_amount_minor),
        currency: body.currency === undefined || body.currency === null ? null : string(body.currency, 3),
        actor_role: string(body.actor_role, 120),
        reason: string(body.reason, 1000),
        reference: body.reference === undefined || body.reference === null ? null : string(body.reference, 200),
        expires_in_seconds: Number(body.expires_in_seconds ?? 0),
      }));
    return idempotent.value;
  }, options.repository));

  app.post("/v1/authority-exceptions/:id/revoke", api(async (principal, request, reply) => {
    sessionOnly(principal); requireCsrf(request, principal);
    const revoked = await requireAuthority(options).revokeException(principal, principal.user_id!, routeId(request),
      string(object(request.body).reason, 500));
    return revoked ? { revoked: true } : notFound(reply, request);
  }, options.repository));

  app.post("/v1/continuation-grants", api(async (principal, request) => {
    requireScope(principal, "actions:write"); requireCsrf(request, principal);
    if (!options.signer) throw Object.assign(new Error("No signing identity is configured"), { statusCode: 503 });
    const body = object(request.body);
    const idempotent = await options.repository.idempotent(principal, "continuation_grant.issue", idempotencyKey(request), body,
      async () => requireAuthority(options).issueGrant(principal, {
        agent_id: body.agent_id === undefined || body.agent_id === null ? null : string(body.agent_id, 36),
        outcome_instance_id: string(body.outcome_instance_id, 36),
        permitted_effects: strings(body.permitted_effects, 20),
        resource_scope: strings(body.resource_scope, 50),
        expires_in_seconds: Number(body.expires_in_seconds ?? 600),
        exception_id: body.exception_id === undefined || body.exception_id === null ? null : string(body.exception_id, 36),
      }, options.signer as never));
    return idempotent.value;
  }, options.repository));

  /* ---------------- OUTCOME SHADOW (Phase 27) ---------------- */

  app.get("/shadow", pageHandler(async (principal) => {
    if (!options.shadow) return genericPage("Outcome Shadow", "Outcome Shadow is not enabled in this deployment.");
    const [metrics, findings, headline] = await Promise.all([
      options.shadow.metrics(principal), options.shadow.findings(principal), options.shadow.headline(principal),
    ]);
    return shellPage("Outcome Shadow", "/shadow", shadowReportPage(metrics, findings, headline), await pageContext(principal));
  }, options.repository));

  app.get("/v1/shadow/metrics", api(async (principal) => {
    requireScope(principal, "actions:read");
    if (!options.shadow) throw Object.assign(new Error("Outcome Shadow is not enabled"), { statusCode: 503 });
    return options.shadow.metrics(principal);
  }, options.repository));

  app.get("/v1/shadow/findings", api(async (principal) => {
    requireScope(principal, "actions:read");
    if (!options.shadow) throw Object.assign(new Error("Outcome Shadow is not enabled"), { statusCode: 503 });
    return options.shadow.findings(principal);
  }, options.repository));

  /**
   * An Agent telling Nyst it considers a workflow finished.
   *
   * Recorded as the Agent's CLAIM. It never moves a verdict — the value of the
   * feature is precisely the distance between this and what Nyst observed.
   */
  app.post("/v1/shadow/completion-signals", api(async (principal, request) => {
    requireScope(principal, "actions:write"); requireCsrf(request, principal);
    if (!options.shadow) throw Object.assign(new Error("Outcome Shadow is not enabled"), { statusCode: 503 });
    const body = object(request.body);
    const status = string(body.declared_status, 20);
    if (status !== "complete" && status !== "failed" && status !== "abandoned") {
      throw Object.assign(new Error("declared_status must be complete, failed or abandoned"), { statusCode: 400 });
    }
    return options.shadow.recordCompletionSignal(principal, {
      outcome_instance_id: string(body.outcome_instance_id, 36),
      agent_id: await options.repository.resolveActingAgent(principal, body.agent_id === undefined || body.agent_id === null ? null : string(body.agent_id, 36)),
      declared_status: status,
    });
  }, options.repository));

  /* ---------------- EVIDENCE INGEST + RELAY (Phases 8-10) ---------------- */

  app.get("/v1/evidence-sources", api(async (principal) => {
    requireAnyScope(principal, ["actions:read", "integrations:read"]);
    return requireEvidence(options).sources(principal);
  }, options.repository));

  app.post("/v1/evidence-sources", api(async (principal, request) => {
    sessionOnly(principal); requireCsrf(request, principal);
    const body = object(request.body);
    const transport = string(body.transport, 30);
    if (transport !== "evidence_ingest" && transport !== "customer_relay") {
      throw Object.assign(new Error("transport must be evidence_ingest or customer_relay"), { statusCode: 400 });
    }
    const idempotent = await options.repository.idempotent(principal, "evidence_source.register", idempotencyKey(request), body,
      async () => requireEvidence(options).registerSource(principal, principal.user_id!, {
        source_key: string(body.source_key, 60), display_name: string(body.display_name, 120), transport,
        permitted_properties: strings(body.permitted_properties, 50),
        authoritative: body.authoritative === true,
        adapter_version: string(body.adapter_version, 80),
        signing_secret_ref: body.signing_secret_ref === undefined || body.signing_secret_ref === null
          ? null : string(body.signing_secret_ref, 300),
        default_freshness_seconds: body.default_freshness_seconds === undefined
          ? 900 : Number(body.default_freshness_seconds),
      }));
    return idempotent.value;
  }, options.repository));

  app.post("/v1/evidence-sources/:key/revoke", api(async (principal, request, reply) => {
    sessionOnly(principal); requireCsrf(request, principal);
    const key = String((request.params as { key?: unknown }).key ?? "");
    const revoked = await requireEvidence(options).revokeSource(principal, key);
    return revoked ? { revoked: true } : notFound(reply, request);
  }, options.repository));

  /**
   * Push one observation.
   *
   * A customer pushes EVIDENCE. Nyst evaluates TRUTH. The handler refuses any
   * push shaped like a conclusion, and a source may only report the properties
   * it registered for.
   */
  app.post("/v1/evidence", api(async (principal, request) => {
    requireScope(principal, "actions:write");
    const body = object(request.body);
    return requireEvidence(options).push(principal, {
      source_key: string(body.source_key, 60),
      event_id: string(body.event_id, 200),
      subject_ref: string(body.subject_ref, 400),
      property: string(body.property, 80),
      value: object(body.value) as never,
      observed_at: string(body.observed_at, 40),
      provenance: body.provenance === undefined ? {} : object(body.provenance),
      ...(body.fresh_until === undefined || body.fresh_until === null ? {} : { fresh_until: string(body.fresh_until, 40) }),
      ...(body.signature === undefined || body.signature === null ? {} : { signature: string(body.signature, 200) }),
      // Forwarded deliberately so the ingest layer REFUSES them by name. A
      // caller trying to push a conclusion gets told why, rather than having
      // the field silently dropped and believing it was accepted.
      ...(body.verdict !== undefined ? { verdict: body.verdict } : {}),
      ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
      ...(body.verified !== undefined ? { verified: body.verified } : {}),
    } as never);
  }, options.repository));

  app.get("/v1/evidence", api(async (principal) => {
    requireScope(principal, "actions:read");
    return requireEvidence(options).evidence(principal);
  }, options.repository));

  app.get("/v1/relay/requests", api(async (principal) => {
    requireAnyScope(principal, ["actions:read", "integrations:read"]);
    return requireRelay(options).requests(principal);
  }, options.repository));

  app.post("/v1/relay/requests", api(async (principal, request) => {
    requireScope(principal, "actions:write"); requireCsrf(request, principal);
    if (!options.signer) throw Object.assign(new Error("No signing identity is configured"), { statusCode: 503 });
    const body = object(request.body);
    const operation = string(body.operation, 60);
    if (!(RELAY_OPERATIONS as readonly string[]).includes(operation)) {
      throw Object.assign(new Error(
        `Unsupported Relay operation. Every Relay operation in this release is a read: ${RELAY_OPERATIONS.join(", ")}`,
      ), { statusCode: 400 });
    }
    return requireRelay(options).issueRequest(principal, {
      source_key: string(body.source_key, 60), operation: operation as RelayOperation,
      subject_ref: string(body.subject_ref, 400), property: string(body.property, 80),
      operation_key: string(body.operation_key, 200),
      expires_in_seconds: body.expires_in_seconds === undefined ? 300 : Number(body.expires_in_seconds),
    }, options.signer as never);
  }, options.repository));

  /** A Relay returning the answer to a request Nyst signed. Nonce is single-use. */
  app.post("/v1/relay/responses", api(async (principal, request) => {
    requireScope(principal, "actions:write");
    const body = object(request.body);
    return requireRelay(options).fulfil(principal, {
      nonce: string(body.nonce, 128),
      push: {
        source_key: string(body.source_key, 60), event_id: string(body.event_id, 200),
        subject_ref: string(body.subject_ref, 400), property: string(body.property, 80),
        value: object(body.value) as never, observed_at: string(body.observed_at, 40),
        provenance: body.provenance === undefined ? {} : object(body.provenance),
        ...(body.fresh_until === undefined || body.fresh_until === null ? {} : { fresh_until: string(body.fresh_until, 40) }),
        ...(body.signature === undefined || body.signature === null ? {} : { signature: string(body.signature, 200) }),
      },
    });
  }, options.repository));

  /* ---------------- FAILURE LAB 2.0 / NYSTBENCH (Phases 33-34) ---------------- */

  /**
   * Failure Lab, both modes on one page.
   *
   * ATOMIC failures ask "what happened to this operation?"; OUTCOME failures
   * ask "what became true?". The flagship case is the one where every atomic
   * answer is correct and the outcome is still false, and a customer only sees
   * that if both modes are in front of them together.
   */
  app.get("/failure-lab", pageHandler(async (principal) => shellPage("Failure Lab", "/failure-lab",
    failureLab2Page(OUTCOME_FAULTS, null, runNystBench(),
      await options.repository.failureLabRuns(principal),
      await options.repository.environmentControl(principal)),
    await pageContext(principal)), options.repository));

  app.post("/v1/failure-lab/outcome-runs", api(async (principal, request) => {
    requireScope(principal, "actions:write"); requireCsrf(request, principal);
    const fault = string(object(request.body).fault, 60);
    if (!(OUTCOME_FAULTS as readonly string[]).includes(fault)) {
      throw Object.assign(new Error("Unknown outcome fault"), { statusCode: 400 });
    }
    // Computed by the production evaluator. Nothing here is scripted, and
    // nothing here contacts a provider.
    return runOutcomeFault(fault as OutcomeFault, { seed: Number(object(request.body).seed ?? 1) });
  }, options.repository));

  app.get("/v1/nystbench", api(async (principal) => {
    requireAnyScope(principal, ["actions:read", "integrations:read"]);
    return runNystBench();
  }, options.repository));

  app.get("/demo", pageHandler(async (principal) => failureLabPage(await options.repository.failureLabRuns(principal), await options.repository.environmentControl(principal), await pageContext(principal)), options.repository));
  app.get("/evidence", pageHandler(async (principal) => actionsPage(await options.repository.listActions(principal), "Evidence", {}, await pageContext(principal)), options.repository));
  app.get("/offboarding", pageHandler(async (principal) => offboardingPage(await options.repository.offboardingRuns(principal), await pageContext(principal)), options.repository));
  app.get("/reviews", pageHandler(async (principal) => reviewsPage(await options.repository.humanReviews(principal), await pageContext(principal)), options.repository));
  app.get("/onboarding", pageHandler(async (principal) => onboardingPage(await options.repository.onboardingProgress(principal), await options.repository.effectSpecStatuses(principal, options.effect_specs, options.production === true, options.secrets ?? null), await pageContext(principal)), options.repository));
  app.get("/settings", pageHandler(async (principal) => settingsPage(
    await options.repository.projectInfo(principal), await options.repository.environmentControl(principal),
    await options.repository.webhookStatus(principal), await options.repository.apiKeys(principal),
    await options.repository.freezes(principal), await pageContext(principal)), options.repository));

  app.get("/v1/overview", api(async (principal) => {requireScope(principal,"actions:read");return options.repository.overview(principal);}, options.repository));
  app.get("/v1/actions", api(async (principal, request) => {requireScope(principal,"actions:read");return options.repository.listActions(principal, filters(request.query));}, options.repository));
  /**
   * Submit a protected consequential action.
   *
   * The execution mode is resolved BEFORE dispatch from (environment, Agent,
   * EffectSpec). In a Canary environment only the explicitly scoped
   * Agent+EffectSpec slices are controlled; everything else is refused here
   * and belongs on the Shadow endpoint, because Nyst must never imply it
   * controlled an action it did not.
   */
  app.post("/v1/actions", api(async (principal, request) => { requireScope(principal, "actions:write"); requireCsrf(request, principal); if (!options.commit) throw Object.assign(new Error("Commit unavailable"), { statusCode: 503 }); const body = object(request.body); const effect = string(body.effect, 200); const businessKey = string(body.businessKey, 463); const agentId = await options.repository.resolveActingAgent(principal, body.agent_id === undefined || body.agent_id === null ? null : string(body.agent_id, 36)); const execution = await options.repository.resolveExecutionMode(principal, agentId, effect); if (execution.mode === "shadow") throw Object.assign(new Error(execution.reason), { statusCode: 409 }); const policy=await options.repository.currentPolicy(principal,effect); if(policy.execution_mode==="approval_required"&&(principal.kind!=="session"||body.approved!==true)) throw Object.assign(new Error("Human approval required before execution"),{statusCode:409}); const availability = await options.repository.requireEffectSpec(principal, effect, options.effect_specs, options.production === true); const namespacedKey = `${principal.environment_id}:${businessKey}`;
    // PURE EFFECTSPEC VALIDATION, and the authoritative consequence metadata.
    //
    // Phase 1G. This runs BEFORE admission, so an invalid request consumes no
    // budget: previously a caller could exhaust an Agent's blast radius with a
    // stream of malformed inputs that never reached a provider. It is also the
    // only place an amount may come from. Nyst does not scrape amount_minor out
    // of arbitrary caller JSON — a GitHub permission change carrying an amount
    // is refused, not silently budgeted at one cent.
    const consequence = authoritativeConsequenceMetadata(effect, body.input);
    // ADMISSION GATE: Emergency Freeze and Blast Radius are evaluated together,
    // in one linearized statement, BEFORE any provider preparation happens.
    const admission = await options.repository.admitConsequence(principal, { agent_id: agentId, effect_name: effect, business_key: businessKey, amount_minor: consequence.amount_minor, currency: consequence.currency });
    // A blocked consequence never becomes an action, so there is no action row to
    // hang a Human Review on. The durable intervention written by admitConsequence
    // IS the operator-facing artefact, and Needs Attention surfaces it beside
    // action-backed reviews. Inventing an action here would be fabricating truth.
    if (!admission.admitted) throw Object.assign(new Error(admission.reason), { statusCode: 409, nyst_blocked_by: admission.blocked_by }); const started=Date.now(); const result = await options.commit({ effect, businessKey: namespacedKey, displayBusinessKey: businessKey, input: withCredentialReference(body.input, availability.credential_ref), credential_ref: availability.credential_ref, policy_version_id: policy.policy_version_id, environment_mode: execution.mode === "canary" ? "canary" : "enforced", agent_id: agentId }, principal); options.metrics?.observe("action_commit_latency_ms",Date.now()-started); await options.repository.linkAdmission(admission.admission_id, result.action.action_id); await options.repository.recordResolutionTransition(result.action.action_id,result.resolution,"action_commit"); return sanitizeForProduct({ ...result, execution_mode: execution.mode, canary_rule_id: execution.canary_rule_id }); }, options.repository));
  app.get("/v1/actions/:id", api(async (principal, request, reply) => {requireScope(principal,"actions:read");return found(reply, request, sanitizeForProduct(await options.repository.actionDetail(principal, routeId(request))));}, options.repository));
  app.get("/v1/actions/:id/evidence", api(async (principal, request, reply) => {requireScope(principal,"actions:read");return found(reply, request, sanitizeForProduct(await options.repository.evidence(principal, routeId(request))));}, options.repository));
  app.get("/v1/actions/:id/resolutions", api(async (principal, request, reply) => {requireScope(principal,"actions:read");return found(reply, request, sanitizeForProduct(await options.repository.resolutions(principal, routeId(request))));}, options.repository));
  app.get("/v1/actions/:id/receipt", api(async (principal, request, reply) => { requireScope(principal, "receipts:read"); const receipt = await options.repository.receipt(principal, routeId(request)); if (!receipt) return reply.code(404).send({ error: "not_found", request_id: request.id }); return { receipt: sanitizeForProduct(receipt), signature_valid: options.verify_receipt ? options.verify_receipt(receipt) : null }; }, options.repository));
  app.post("/v1/actions/:id/reconcile", api(async (principal, request, reply) => { requireScope(principal, "actions:write"); requireCsrf(request, principal); const actionId=routeId(request); if (!(await options.repository.actionDetail(principal,actionId))) return reply.code(404).send({error:"not_found"}); if(!options.runtime) return reply.code(503).send({error:"runtime_unavailable"});const resolution=await options.runtime.reconcile(actionId);await options.repository.recordResolutionTransition(actionId,resolution,"manual_reconcile"); return sanitizeForProduct(resolution); }, options.repository));
  app.post("/v1/actions/:id/continuation-leases", api(async (principal, request, reply) => { requireScope(principal,"actions:write"); requireCsrf(request,principal); const actionId=routeId(request); if (!(await options.repository.actionDetail(principal,actionId))) return reply.code(404).send({error:"not_found"}); if(!options.runtime) return reply.code(503).send({error:"runtime_unavailable"}); const resolutionId=string(object(request.body).resolution_id,36); if(!UUID.test(resolutionId)) throw Object.assign(new Error("Invalid resolution ID"),{statusCode:400}); await options.runtime.authorizeContinuation(actionId,resolutionId); const receipt=await options.repository.receipt(principal,actionId); const runtime=receipt&&typeof receipt.runtime==="object"&&receipt.runtime?receipt.runtime as Record<string,unknown>:null; if(!runtime||!Number.isInteger(runtime.resolution_sequence)||!Number.isInteger(runtime.evidence_sequence)) throw new Error("Current resolution lacks durable sequence binding"); const lease=await options.repository.issueContinuationLease(principal,actionId,resolutionId,Number(runtime.resolution_sequence),Number(runtime.evidence_sequence));await options.repository.queueLifecycleWebhookByAction(actionId,"continuation.authorized");return lease; },options.repository));
  app.post("/v1/continuation-leases/consume", api(async (principal,request,reply)=>{requireScope(principal,"actions:write");requireCsrf(request,principal);const result=await options.repository.consumeContinuationLease(principal,string(object(request.body).lease,120));return result??reply.code(409).send({error:"stale_or_consumed_lease"});},options.repository));
  /* ---------------- Agent Registry (Phase 6) ---------------- */
  app.get("/v1/agents", api(async (principal)=>{requireAnyScope(principal,["actions:read","integrations:read"]);return options.repository.agents(principal);},options.repository));
  app.post("/v1/agents", api(async (principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);const idempotent=await options.repository.idempotent(principal,"agent.create",idempotencyKey(request),body,async()=>options.repository.createAgent(principal,principal.user_id!,{name:string(body.name,120),slug:string(body.slug,63),owner:string(body.owner,120),description:body.description===undefined?"":string(body.description,1000),framework:body.framework===undefined?"unspecified":string(body.framework,80),tags:body.tags===undefined?[]:strings(body.tags,12)}));return idempotent.value;},options.repository));
  app.get("/v1/agents/:id", api(async (principal,request,reply)=>{requireAnyScope(principal,["actions:read","integrations:read"]);return found(reply,request,await options.repository.agentDetail(principal,routeId(request)));},options.repository));
  app.put("/v1/agents/:id/status", api(async (principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const status=string(object(request.body).status,20);if(status!=="active"&&status!=="paused"&&status!=="retired")throw Object.assign(new Error("Unsupported Agent status"),{statusCode:400});return options.repository.setAgentStatus(principal,principal.user_id!,routeId(request),status);},options.repository));

  /* ---------------- Canary scope (Phase 8) ---------------- */
  app.get("/v1/canary-rules", api(async (principal)=>{requireAnyScope(principal,["actions:read","integrations:read"]);return options.repository.canaryRules(principal);},options.repository));
  app.post("/v1/canary-rules", api(async (principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);const agentId=string(body.agent_id,36);if(!UUID.test(agentId))throw Object.assign(new Error("Invalid Agent identifier"),{statusCode:400});const effect=string(body.effect_name,200);if(!options.effect_specs.some(item=>item.effect_name===effect))throw Object.assign(new Error("Unknown EffectSpec"),{statusCode:400});return options.repository.createCanaryRule(principal,principal.user_id!,agentId,effect,body.reason===undefined?"":string(body.reason,500));},options.repository));
  app.put("/v1/canary-rules/:id", api(async (principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);if(typeof body.enabled!=="boolean")throw Object.assign(new Error("Boolean enabled required"),{statusCode:400});return options.repository.setCanaryRuleEnabled(principal,principal.user_id!,routeId(request),body.enabled,body.reason===undefined?"":string(body.reason,500));},options.repository));

  /** What mode WOULD this Agent + EffectSpec execute under right now, and why. */
  app.get("/v1/execution-mode", api(async (principal,request)=>{requireAnyScope(principal,["actions:read","integrations:read"]);const query=request.query as {agent_id?:unknown;effect?:unknown};const agentId=query.agent_id===undefined?null:string(String(query.agent_id),36);return options.repository.resolveExecutionMode(principal,agentId,string(String(query.effect??""),200));},options.repository));

  /* ---------------- Blast Radius (Phase 10) ---------------- */
  app.get("/v1/blast-radius", api(async (principal)=>{requireAnyScope(principal,["actions:read","integrations:read"]);return {budgets:await options.repository.blastRadiusBudgets(principal),recent_decisions:await options.repository.blastRadiusDecisions(principal)};},options.repository));
  app.post("/v1/blast-radius", api(async (principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);const windowSeconds=Number(body.window_seconds);if(!Number.isInteger(windowSeconds)||windowSeconds<60||windowSeconds>86400)throw Object.assign(new Error("window_seconds must be an integer between 60 and 86400"),{statusCode:400});const idempotent=await options.repository.idempotent(principal,"blast_radius.configure",idempotencyKey(request),body,async()=>options.repository.createBlastRadiusBudget(principal,principal.user_id!,{agent_id:body.agent_id===undefined||body.agent_id===null?null:string(body.agent_id,36),effect_name:body.effect_name===undefined||body.effect_name===null?null:string(body.effect_name,200),window_seconds:windowSeconds,max_actions_per_window:optionalInteger(body.max_actions_per_window),max_amount_minor_per_action:optionalInteger(body.max_amount_minor_per_action),max_amount_minor_per_window:optionalInteger(body.max_amount_minor_per_window),currency:body.currency===undefined||body.currency===null?null:string(body.currency,3)}));return idempotent.value;},options.repository));

  /* ---------------- Emergency Freeze (Phase 11) ---------------- */
  app.get("/v1/freezes", api(async (principal)=>{requireAnyScope(principal,["actions:read","integrations:read"]);return options.repository.freezes(principal);},options.repository));
  app.post("/v1/freezes", api(async (principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);const idempotent=await options.repository.idempotent(principal,"freeze.activate",idempotencyKey(request),body,async()=>options.repository.activateFreeze(principal,principal.user_id!,{scope_agent_id:body.scope_agent_id===undefined||body.scope_agent_id===null?null:string(body.scope_agent_id,36),scope_effect_name:body.scope_effect_name===undefined||body.scope_effect_name===null?null:string(body.scope_effect_name,200),reason:body.reason===undefined?"":string(body.reason,500)}));return idempotent.value;},options.repository));
  app.post("/v1/freezes/:id/release", api(async (principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);if(body.confirm!==true)throw Object.assign(new Error("Releasing an Emergency Freeze requires explicit confirmation"),{statusCode:400});const idempotent=await options.repository.idempotent(principal,"freeze.release",idempotencyKey(request),{id:routeId(request),body},async()=>options.repository.releaseFreeze(principal,principal.user_id!,routeId(request),string(body.reason ?? "Released",500)));return idempotent.value;},options.repository));

  /* ---------------- Policy templates (Phase 12) ---------------- */
  app.get("/v1/policy-templates", api(async (principal)=>{requireAnyScope(principal,["actions:read","integrations:read"]);return {templates:await options.repository.policyTemplates(),safety_floor:NYST_SAFETY_FLOOR};},options.repository));
  app.post("/v1/policy-templates/:template", api(async (principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const template=String((request.params as {template?:unknown}).template??"");if(template!=="access_revocation"&&template!=="financial_action"&&template!=="high_risk_production")throw Object.assign(new Error("Unknown policy template"),{statusCode:400});const body=object(request.body);const effect=body.effect_name===undefined||body.effect_name===null?null:string(body.effect_name,200);const idempotent=await options.repository.idempotent(principal,"policy.create_version",idempotencyKey(request),{template,effect},async()=>options.repository.createPolicyFromTemplate(principal,principal.user_id!,template,effect));return idempotent.value;},options.repository));

  /* ---------------- Protection Report (Phase 9) ---------------- */
  app.get("/v1/protection-report", api(async (principal,request)=>{requireScope(principal,"actions:read");if(!options.secrets)throw Object.assign(new Error("No SecretProvider is configured"),{statusCode:503});const query=request.query as {range?:unknown;from?:unknown;to?:unknown;format?:unknown};const range=metricRange(query.range);const report=await options.repository.protectionReport(principal,options.secrets,range,query.from===undefined?undefined:String(query.from),query.to===undefined?undefined:String(query.to));return report;},options.repository));
  app.get("/v1/protection-report.csv", api(async (principal,request,reply)=>{requireScope(principal,"actions:read");if(!options.secrets)throw Object.assign(new Error("No SecretProvider is configured"),{statusCode:503});const query=request.query as {range?:unknown};const report=await options.repository.protectionReport(principal,options.secrets,metricRange(query.range));reply.header("Content-Type","text/csv; charset=utf-8");reply.header("Content-Disposition",`attachment; filename="nyst-protection-report.csv"`);return protectionReportCsv(report);},options.repository));

  /* ---------------- Needs Attention / Go-Live / Proof Pack (Phases 13,14,18) ---------------- */
  app.get("/v1/needs-attention", api(async (principal)=>{requireScope(principal,"actions:read");return options.repository.needsAttention(principal);},options.repository));
  // The action must be visible in THIS tenant before Nyst will describe what a
  // reviewer could do to it. Without this check the endpoint answered for an
  // action belonging to another organization — it disclosed nothing about that
  // action, but it did claim operations were permitted on something the caller
  // cannot touch, which is a lie the UI would faithfully render.
  app.get("/v1/actions/:id/review-options", api(async (principal,request,reply)=>{requireScope(principal,"actions:read");const id=routeId(request);const action=await options.repository.actionDetail(principal,id);if(!action)return notFound(reply,request);return options.repository.humanReviewOptions(principal,id);},options.repository));
  app.get("/v1/go-live", api(async (principal,request)=>{requireAnyScope(principal,["actions:read","integrations:read"]);if(!options.secrets)throw Object.assign(new Error("No SecretProvider is configured"),{statusCode:503});const query=request.query as {agent_id?:unknown;effect?:unknown};if(query.effect===undefined)return options.repository.goLiveMatrix(principal,options.secrets,options.effect_specs);return options.repository.goLiveReadiness(principal,options.secrets,query.agent_id===undefined?null:String(query.agent_id),String(query.effect),options.effect_specs);},options.repository));
  app.get("/v1/actions/:id/proof-pack", api(async (principal,request,reply)=>{requireAnyScope(principal,["actions:read","receipts:read"]);const pack=await options.repository.proofPack(principal,routeId(request),options.verify_receipt);if(!pack)return reply.code(404).send({error:"not_found",request_id:request.id});const query=request.query as {format?:unknown};if(String(query.format??"json")==="html"){reply.header("Content-Type","text/html; charset=utf-8");return proofPackDocument(pack);}return pack;},options.repository));
  app.get("/v1/offboarding/stages", api(async (principal)=>{requireAnyScope(principal,["actions:read","integrations:read"]);return {summary:CANONICAL_OFFBOARDING_SUMMARY,stages:CANONICAL_OFFBOARDING_STAGES};},options.repository));

  app.get("/v1/effect-specs", api(async (principal) => {requireAnyScope(principal,["actions:read","integrations:read"]);return options.repository.effectSpecConfiguration(principal, options.effect_specs, options.production === true);}, options.repository));
  app.put("/v1/effect-specs/:effect", api(async (principal,request)=>{if(principal.kind!=="session")throw Object.assign(new Error("Session required"),{statusCode:403});requireCsrf(request,principal);const effect=string(String((request.params as {effect?:unknown}).effect??""),200);const descriptor=options.effect_specs.find(item=>item.effect_name===effect);if(!descriptor)throw Object.assign(new Error("Unknown EffectSpec"),{statusCode:400});const body=object(request.body);if(typeof body.enabled!=="boolean")throw Object.assign(new Error("Boolean enabled required"),{statusCode:400});if(descriptor.provider==="fake"&&options.production===true&&body.enabled)throw Object.assign(new Error("Fake provider unavailable in production"),{statusCode:409});await options.repository.configureEffectSpec(principal,descriptor,body.enabled);return {effect_name:descriptor.effect_name,spec_version:descriptor.spec_version,enabled:body.enabled};},options.repository));
  app.get("/v1/integrations", api(async (principal) => { requireScope(principal, "integrations:read"); return sanitizeForProduct(await options.repository.integrations(principal)); }, options.repository));
  /**
   * "Test" is a READ-ONLY preflight (I20). It resolves the credential through
   * the SecretProvider, calls a bounded read-only probe, persists the
   * categorical outcome, and returns the six readiness dimensions. It never
   * mutates provider state and never returns the credential.
   */
  app.post("/v1/integrations/:provider/preflight",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const provider=String((request.params as {provider?:unknown}).provider??"");if(provider!=="github"&&provider!=="okta"&&provider!=="stripe")throw Object.assign(new Error("Unsupported provider"),{statusCode:400});if(!options.secrets)throw Object.assign(new Error("No SecretProvider is configured"),{statusCode:503});if(!options.integration_preflight)return {provider,status:"preflight_unavailable",read_only_preflight_performed:false,provider_mutation_performed:false,readiness:await options.repository.integrationReadiness(principal,provider,options.secrets)};const preflight=await options.repository.runIntegrationPreflight(principal,provider,options.secrets,(secret)=>options.integration_preflight!(provider,secret));return {...preflight,readiness:await options.repository.integrationReadiness(principal,provider,options.secrets)};},options.repository));
  // Retained path for existing integrations; same read-only behaviour.
  app.post("/v1/integrations/:provider/test",api(async(principal,request,reply)=>{reply.header("Deprecation","true");reply.header("Link","</v1/integrations/{provider}/preflight>; rel=\"successor-version\"");sessionOnly(principal);requireCsrf(request,principal);const provider=String((request.params as {provider?:unknown}).provider??"");if(provider!=="github"&&provider!=="okta"&&provider!=="stripe")throw Object.assign(new Error("Unsupported provider"),{statusCode:400});if(!options.secrets)throw Object.assign(new Error("No SecretProvider is configured"),{statusCode:503});const readiness=await options.repository.integrationReadiness(principal,provider,options.secrets);if(!readiness.credential_available||!options.integration_preflight)return {...readiness,read_only_preflight_performed:false,provider_mutation_performed:false};const preflight=await options.repository.runIntegrationPreflight(principal,provider,options.secrets,(secret)=>options.integration_preflight!(provider,secret));return {...preflight,readiness:await options.repository.integrationReadiness(principal,provider,options.secrets)};},options.repository));
  /**
   * The durable CapabilityManifest for one provider connection: what each
   * required capability's state is, and why. Not a `connected` boolean.
   */
  app.get("/v1/integrations/:provider/capabilities",api(async(principal,request)=>{requireAnyScope(principal,["integrations:read","actions:read"]);const provider=integrationProvider(request);return options.repository.capabilityManifest(principal,provider);},options.repository));
  /**
   * Record an operator's CLAIM that this credential holds a capability Nyst
   * cannot observe read-only. Stored with an author, a timestamp and a
   * mandatory justification, and labelled as a claim everywhere it appears.
   */
  app.post("/v1/integrations/:provider/capabilities/attest",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const provider=integrationProvider(request);const body=object(request.body);const userId=principal.user_id;if(!userId)throw Object.assign(new Error("An attestation must be made by a signed-in person"),{statusCode:403});return options.repository.attestCapability(principal,userId,provider,String(body.capability??""),String(body.justification??""));},options.repository));
  app.post("/v1/capability-attestations/:id/revoke",api(async(principal,request,reply)=>{sessionOnly(principal);requireCsrf(request,principal);const userId=principal.user_id;if(!userId)throw Object.assign(new Error("A withdrawal must be made by a signed-in person"),{statusCode:403});const revoked=await options.repository.revokeCapabilityAttestation(principal,userId,routeId(request));return revoked?{revoked:true}:notFound(reply,request);},options.repository));
  app.put("/v1/integrations/:provider", api(async (principal,request)=>{if(principal.kind!=="session")throw Object.assign(new Error("Session required"),{statusCode:403});requireCsrf(request,principal);const provider=String((request.params as {provider?:unknown}).provider??"");if(!["github","okta","stripe"].includes(provider))throw Object.assign(new Error("Unsupported provider"),{statusCode:400});const idempotent = await options.repository.idempotent(principal, "integration.configure", idempotencyKey(request), { provider, body: object(request.body) }, async () => sanitizeForProduct(await options.repository.configureIntegration(principal,provider,credentialReference(object(request.body).credential_ref)))); return idempotent.value;},options.repository));
  app.get("/v1/offboarding-runs", api(async (principal) => {requireScope(principal,"actions:read");return sanitizeForProduct(await options.repository.offboardingRuns(principal));}, options.repository));
  app.get("/v1/metrics", api(async (principal) => {requireScope(principal,"actions:read");return options.repository.impactMetrics(principal);}, options.repository));
  app.get("/v1/context", api(async (principal)=>{if(principal.kind!=="session")throw Object.assign(new Error("Session required"),{statusCode:403});return options.repository.context(principal);},options.repository));
  app.post("/v1/context", api(async (principal,request,reply)=>{if(principal.kind!=="session")throw Object.assign(new Error("Session required"),{statusCode:403});requireCsrf(request,principal);const body=object(request.body);const projectId=string(body.project_id,36);const environmentId=string(body.environment_id,36);if(!UUID.test(projectId)||!UUID.test(environmentId))throw Object.assign(new Error("Invalid context ID"),{statusCode:400});const session=request.cookies[SESSION_COOKIE];if(!session||!(await options.repository.switchSessionContext(session,principal,projectId,environmentId)))return reply.code(404).send({error:"not_found",request_id:request.id});return {project_id:projectId,environment_id:environmentId};},options.repository));
  app.get("/v1/environment",api(async principal=>options.repository.environmentControl(principal),options.repository));
  app.put("/v1/environment/mode",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);const mode=string(body.mode,8);if(mode!=="shadow"&&mode!=="canary"&&mode!=="enforced")throw Object.assign(new Error("Invalid environment mode"),{statusCode:400});const idempotent = await options.repository.idempotent(principal, "environment.set_mode", idempotencyKey(request), object(request.body), async () => options.repository.setEnvironmentMode(principal,principal.user_id!,mode,string(body.reason,500))); return idempotent.value;},options.repository));
  /**
   * Shadow evaluation. The caller must name the EXACT EffectSpec version the
   * environment has enabled; there is no implicit latest-version substitution.
   */
  app.post("/v1/shadow/evaluations",api(async(principal,request)=>{requireScope(principal,"actions:write");requireCsrf(request,principal);const body=object(request.body);const observation=object(body.observation);const transport=string(observation.transport,30);if(!["success","definitely_not_sent","ambiguous"].includes(transport)||typeof observation.attempted_retry!=="boolean"||typeof observation.attempted_continuation!=="boolean"||!(typeof observation.authoritative_goal_observed==="boolean"||observation.authoritative_goal_observed===null))throw Object.assign(new Error("Invalid Shadow observation"),{statusCode:400});const providerState=observation.provider_state===undefined?{}:{provider_state:object(observation.provider_state)};const effect=string(body.effect,200);const specVersion=string(body.spec_version,200);const agentId=body.agent_id===undefined||body.agent_id===null?null:string(body.agent_id,36);if(agentId!==null&&!UUID.test(agentId))throw Object.assign(new Error("Invalid Agent identifier"),{statusCode:400});return options.repository.recordShadowEvaluation(principal,effect,string(body.businessKey,463),{transport:transport as "success"|"definitely_not_sent"|"ambiguous",authoritative_goal_observed:observation.authoritative_goal_observed as boolean|null,attempted_retry:observation.attempted_retry,attempted_continuation:observation.attempted_continuation,...providerState},specVersion,agentId);},options.repository));
  app.get("/v1/policies",api(async principal=>{requireScope(principal,"actions:read");return options.repository.policyHistory(principal)},options.repository));
  app.post("/v1/policies",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);const effect=body.effect_name===null?null:string(body.effect_name,200);const execution=string(body.execution_mode,30);if(execution!=="automatic"&&execution!=="approval_required"||typeof body.auto_continuation!=="boolean"||typeof body.auto_compensation!=="boolean"||!Number.isInteger(body.reconcile_timeout_seconds))throw Object.assign(new Error("Invalid policy"),{statusCode:400});const autoContinuation=body.auto_continuation===true;const autoCompensation=body.auto_compensation===true;const idempotent = await options.repository.idempotent(principal, "policy.create_version", idempotencyKey(request), body, async () => options.repository.createPolicyVersion(principal,principal.user_id!,{effect_name:effect,execution_mode:execution,auto_continuation:autoContinuation,auto_compensation:autoCompensation,reconcile_timeout_seconds:Number(body.reconcile_timeout_seconds)})); return idempotent.value;},options.repository));
  app.get("/v1/webhooks",api(async principal=>{requireScope(principal,"integrations:read");return options.repository.webhookStatus(principal)},options.repository));
  app.put("/v1/webhooks/decision",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);const idempotent = await options.repository.idempotent(principal, "webhook.configure", idempotencyKey(request), object(request.body), async () => options.repository.configureWebhook(principal,principal.user_id!,string(body.target_url,2048),string(body.signing_secret_ref,104))); return idempotent.value;},options.repository));
  app.put("/v1/webhooks/decision/enabled",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const enabled=object(request.body).enabled;if(typeof enabled!=="boolean")throw Object.assign(new Error("Boolean enabled required"),{statusCode:400});return options.repository.setWebhookEnabled(principal,principal.user_id!,enabled);},options.repository));
  app.post("/v1/webhooks/decision/test",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);return options.repository.queueWebhookTest(principal);},options.repository));
  app.post("/v1/actions/:id/recovery-authorizations",api(async(principal,request)=>{requireScope(principal,"actions:write");requireCsrf(request,principal);const body=object(request.body);const operation=string(body.operation,40);if(operation!=="authorized_continuation"&&operation!=="supported_compensation")throw Object.assign(new Error("Unsupported recovery operation"),{statusCode:400});const resolutionId=string(body.resolution_id,36);if(!UUID.test(resolutionId))throw Object.assign(new Error("Invalid resolution ID"),{statusCode:400});const idempotent = await options.repository.idempotent(principal, "recovery.authorize", idempotencyKey(request), { action_id: routeId(request), body: object(request.body) }, async () => options.repository.authorizeRecovery(principal,routeId(request),resolutionId,operation)); return idempotent.value;},options.repository));
  app.get("/v1/reviews",api(async principal=>{requireScope(principal,"actions:read");return options.repository.humanReviews(principal)},options.repository));
  app.post("/v1/actions/:id/reviews",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const idempotent = await options.repository.idempotent(principal, "review.open", idempotencyKey(request), { action_id: routeId(request), body: object(request.body) }, async () => options.repository.openHumanReview(principal,routeId(request),string(object(request.body).reason,1000))); return idempotent.value;},options.repository));
  app.post("/v1/reviews/:id",api(async(principal,request)=>{requireScope(principal,"actions:write");requireCsrf(request,principal);const body=object(request.body);const operation=string(body.operation,40);if(operation!=="acknowledge"&&operation!=="request_reobservation"&&operation!=="authorize_compensation"&&operation!=="cancel")throw Object.assign(new Error("Human review supports only acknowledge, request_reobservation, authorize_compensation and cancel. There is no force-continue."),{statusCode:400});const idempotent = await options.repository.idempotent(principal, "review.command", idempotencyKey(request), { review_id: routeId(request), body }, async () => options.repository.updateHumanReview(principal,principal.user_id!,routeId(request),operation)); return idempotent.value;},options.repository));
  app.get("/v1/failure-lab/runs",api(async principal=>{requireScope(principal,"actions:read");return options.repository.failureLabRuns(principal)},options.repository));
  /**
   * Run one deterministic Failure Lab scenario.
   *
   * `effect` was a REQUIRED parameter that the engine then ignored — the lab
   * always runs against the deterministic fake provider, which is what makes
   * it structurally unable to reach a real system. The dashboard's own form
   * therefore could never succeed: it did not send a field it had no honest
   * value for. The field is now optional, and a value other than the lab
   * effect is refused with a reason rather than silently disregarded.
   */
  app.post("/v1/failure-lab/runs",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);const body=object(request.body);const scenario=string(body.scenario,40);if(!["response_lost","timeout_before_send","delayed_observation","reconcile_rate_limit","duplicate_caller","process_crash","offboarding_demo"].includes(scenario)||!Number.isInteger(body.seed))throw Object.assign(new Error("A run needs one of the listed deterministic scenarios and an integer seed."),{statusCode:400});if(body.effect!==undefined&&body.effect!==null&&String(body.effect)!==LAB_EFFECT)throw Object.assign(new Error(`The Failure Lab only simulates ${LAB_EFFECT}; it never reaches a real provider.`),{statusCode:400});const idempotent = await options.repository.idempotent(principal, "failure_lab.run", idempotencyKey(request), object(request.body), async () => options.repository.runFailureLab(principal,principal.user_id!,scenario as never,LAB_EFFECT,Number(body.seed))); return idempotent.value;},options.repository));
  app.put("/v1/onboarding",api(async(principal,request)=>{sessionOnly(principal);requireCsrf(request,principal);if(object(request.body).operation!=="attest_sdk_installed")throw Object.assign(new Error("Unsupported onboarding operation"),{statusCode:400});await options.repository.attestSdkInstalled(principal);return options.repository.onboardingProgress(principal)},options.repository));
  app.get("/v1/api-keys",api(async principal=>{sessionOnly(principal);return options.repository.apiKeys(principal)},options.repository));
  app.post("/v1/api-keys", api(async (principal, request) => { if (principal.kind !== "session") throw Object.assign(new Error("Session required"), { statusCode: 403 }); requireCsrf(request, principal); const body = object(request.body); const scopes=strings(body.scopes,16); if(scopes.some(scope=>!API_SCOPES.has(scope)))throw Object.assign(new Error("Unsupported API key scope"),{statusCode:400}); const idempotent = await options.repository.idempotent(principal, "api_key.create", idempotencyKey(request), body, async () => options.repository.createApiKey(principal, string(body.name, 120), scopes, null, body.agent_id===undefined||body.agent_id===null?null:string(body.agent_id,36))); return idempotent.value;},options.repository));
  app.delete("/v1/api-keys/:id", api(async (principal, request) => { if (principal.kind !== "session") throw Object.assign(new Error("Session required"), { statusCode: 403 }); requireCsrf(request, principal); return { revoked: await options.repository.revokeApiKey(principal, routeId(request)) }; }, options.repository));
  return app;
}

function pageHandler(handler: (principal: ProductPrincipal, request: FastifyRequest, reply: FastifyReply) => Promise<string | FastifyReply>, repository: ProductRepository) { return async (request: FastifyRequest, reply: FastifyReply) => { const principal = await authenticate(request, repository); if (!principal) return reply.redirect("/login");if(principal.kind!=="session")return reply.code(403).type("text/html; charset=utf-8").send(genericPage("Session required","Dashboard pages require a browser session; API keys are limited to versioned API endpoints.")); const value = await handler(principal, request, reply); if (typeof value === "string") { const context=await repository.context(principal); return reply.type("text/html; charset=utf-8").send(value.replace("<!--NYST_CONTEXT-->",contextSwitcher(context))); } return value; }; }
function api(handler: (principal: ProductPrincipal, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>, repository: ProductRepository) { return async (request: FastifyRequest, reply: FastifyReply) => { const principal = await apiPrincipal(request, reply, repository); if (!principal) return; return handler(principal, request, reply); }; }
async function apiPrincipal(request: FastifyRequest, reply: FastifyReply, repository: ProductRepository): Promise<ProductPrincipal | null> { const principal = await authenticate(request, repository); if (!principal) { reply.code(401).send({ error: "unauthorized", request_id: request.id }); return null; } return principal; }
async function authenticate(request: FastifyRequest, repository: ProductRepository): Promise<ProductPrincipal | null> { const auth = request.headers.authorization; if (auth?.startsWith("Nyst ")) return repository.authenticateApiKey(auth.slice(5)); const session = request.cookies[SESSION_COOKIE]; return session ? repository.authenticateSession(session) : null; }
function requireCsrf(request: FastifyRequest, principal: ProductPrincipal): void { if (principal.kind === "api_key") return; const value = request.headers["x-nyst-csrf"]; if (typeof value !== "string" || !principal.csrf_hash || digest(value) !== principal.csrf_hash) throw Object.assign(new Error("CSRF rejected"), { statusCode: 403 }); }
function requireScope(principal: ProductPrincipal, scope: string): void { if (!principal.scopes.includes("*") && !principal.scopes.includes(scope)) throw Object.assign(new Error("Scope denied"), { statusCode: 403 }); }
function requireAnyScope(principal:ProductPrincipal,scopes:readonly string[]):void{if(!principal.scopes.includes("*")&&!scopes.some(scope=>principal.scopes.includes(scope)))throw Object.assign(new Error("Scope denied"),{statusCode:403});}
function sessionOnly(principal:ProductPrincipal):asserts principal is ProductPrincipal&{kind:"session";user_id:string}{if(principal.kind!=="session"||!principal.user_id)throw Object.assign(new Error("Session required"),{statusCode:403});}
function routeId(request: FastifyRequest): string { const id = String((request.params as { id?: unknown }).id ?? ""); if (!UUID.test(id)) throw Object.assign(new Error("Invalid ID"), { statusCode: 400 }); return id; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Object required"), { statusCode: 400 }); return value as Record<string, unknown>; }
function string(value: unknown, max: number): string { if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw Object.assign(new Error("Invalid string"), { statusCode: 400 }); return value; }
function strings(value: unknown, max: number): string[] { if (!Array.isArray(value) || !value.length || value.length > max || value.some((item) => typeof item !== "string")) throw Object.assign(new Error("Invalid string list"), { statusCode: 400 }); return value as string[]; }
function credentialReference(value:unknown):string{const ref=string(value,300);if(!/^(?:env|vault|secret-manager):[A-Za-z0-9_./:-]{3,280}$/.test(ref))throw Object.assign(new Error("Invalid credential reference"),{statusCode:400});return ref;}
function filters(value: unknown) { const q = value && typeof value === "object" ? value as Record<string, unknown> : {}; const limit=typeof q.limit==="string"?Number(q.limit):undefined;if(limit!==undefined&&(!Number.isInteger(limit)||limit<1||limit>200))throw Object.assign(new Error("Invalid limit"),{statusCode:400});let since: string|undefined;if(typeof q.since==="string"){const parsed=new Date(q.since);if(!Number.isFinite(parsed.getTime()))throw Object.assign(new Error("Invalid since"),{statusCode:400});since=parsed.toISOString();}return { ...(typeof q.provider === "string" ? { provider: filterString(q.provider,60) } : {}), ...(typeof q.effect === "string" ? { effect: filterString(q.effect,200) } : {}), ...(typeof q.state === "string" ? { state: filterString(q.state,40) } : {}), ...(typeof q.decision === "string" ? { decision: filterString(q.decision,40) } : {}), ...(since ? { since } : {}), ...(limit!==undefined ? { limit } : {}) }; }
function filterString(value:string,max:number):string{if(!value||value.length>max||/[\r\n\0]/.test(value))throw Object.assign(new Error("Invalid filter"),{statusCode:400});return value;}
/**
 * A 404 carries the request id, exactly like every other error shape.
 *
 * Without it, the one class of failure a customer is most likely to report —
 * "your API says my action doesn't exist" — is the one class we cannot
 * correlate to a log line.
 */
function notFound(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  return reply.code(404).send({ error: "not_found", request_id: request.id });
}
function found(reply: FastifyReply, request: FastifyRequest, value: unknown): unknown {
  return value === null || value === undefined ? notFound(reply, request) : value;
}
function integrationProvider(request:{params:unknown}):"github"|"okta"|"stripe"{
  const provider=String((request.params as {provider?:unknown}).provider??"");
  if(provider!=="github"&&provider!=="okta"&&provider!=="stripe")throw Object.assign(new Error("Unsupported provider"),{statusCode:400});
  return provider;
}
function requireEvidence(options: ProductServerOptions): EvidenceIngest {
  if (!options.evidence) throw Object.assign(new Error("Evidence Ingest is not enabled in this deployment"), { statusCode: 503 });
  return options.evidence;
}
function requireRelay(options: ProductServerOptions): RelayCoordinator {
  if (!options.relay) throw Object.assign(new Error("The customer Relay is not enabled in this deployment"), { statusCode: 503 });
  return options.relay;
}

function requireOutcomes(options: ProductServerOptions): OutcomeRepository {
  if (!options.outcomes) throw Object.assign(new Error("The Outcome layer is not enabled in this deployment"), { statusCode: 503 });
  return options.outcomes;
}
function requireAuthority(options: ProductServerOptions): AuthorityRepository {
  if (!options.authority) throw Object.assign(new Error("The Authority layer is not enabled in this deployment"), { statusCode: 503 });
  return options.authority;
}

/** The outcome list, joined with the spec each instance's contract names. */
async function outcomeListView(outcomes: OutcomeRepository, principal: ProductPrincipal): Promise<Record<string, unknown>[]> {
  const [instances, contracts] = await Promise.all([outcomes.instances(principal), outcomes.contracts(principal)]);
  const byId = new Map(contracts.map((contract) => [contract.outcome_contract_id, contract]));
  return instances.map((instance) => ({
    ...instance,
    outcome_spec: byId.get(instance.outcome_contract_id)?.outcome_spec ?? "",
  })) as unknown as Record<string, unknown>[];
}

/** Everything one outcome page needs, gathered once. */
async function outcomeDetailView(
  options: ProductServerOptions, principal: ProductPrincipal, instanceId: string,
): Promise<Parameters<typeof outcomePage>[0] | null> {
  const outcomes = options.outcomes!;
  const instance = await outcomes.instance(principal, instanceId);
  if (!instance) return null;
  const contract = await outcomes.contract(principal, instance.outcome_contract_id);
  if (!contract) return null;
  const [evaluations, linked, receipt] = await Promise.all([
    outcomes.evaluations(principal, instanceId),
    outcomes.linkedActions(instanceId),
    outcomes.receipt(principal, instanceId),
  ]);
  const actions = await Promise.all(linked.map(async (link) => {
    const detail = await options.repository.actionDetail(principal, link.action_id);
    const resolutions = await options.repository.resolutions(principal, link.action_id);
    const latest = (resolutions ?? [])[0] as { effect_state?: unknown } | undefined;
    return { ...link, effect_state: latest?.effect_state ?? detail?.lifecycle_state ?? "unknown" };
  }));
  const subjectRefs = Object.values(subjectReferencesFor(instance.subject));
  const facts = subjectRefs.length ? await outcomes.currentFacts(principal, subjectRefs) : [];
  const exceptions = options.authority
    ? await options.authority.liveExceptions(principal, { outcome_instance_id: instanceId })
    : [];
  return {
    instance: instance as unknown as Record<string, unknown>,
    contract: contract as unknown as Record<string, unknown>,
    evaluation: (evaluations[0] ?? null) as Record<string, unknown> | null,
    actions: actions as unknown as Record<string, unknown>[],
    facts: facts as unknown as Record<string, unknown>[],
    receipt,
    exceptions: exceptions as unknown as Record<string, unknown>[],
    grants: [],
  };
}

function withCredentialReference(value: unknown, credentialRef: string | null): unknown { if (credentialRef===null) return value; const input=object(value); return { ...input, credential_ref: credentialRef }; }
function contextSwitcher(context:ProductContext):string{if(context.projects.length===1&&context.projects[0]?.environments.length===1)return "";const esc=(value:string)=>value.replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"})[c]!);const projects=context.projects.map(project=>`<option value="${esc(project.project_id)}"${project.project_id===context.selected_project_id?" selected":""}>${esc(project.project_name)}</option>`).join("");const safeJson=JSON.stringify(context).replace(/</g,"\\u003c");return `<section class="context-switcher" aria-label="Project and environment context"><label>Project<select id="nyst-project-context">${projects}</select></label><label>Environment<select id="nyst-environment-context"></select></label><script type="application/json" id="nyst-context-data">${safeJson}</script></section>`;}
async function registryView(repository:ProductRepository,principal:ProductPrincipal,descriptors:readonly EffectSpecDescriptor[],production:boolean,secrets:SecretProvider|null):Promise<Record<string,unknown>[]>{return repository.effectSpecStatuses(principal,descriptors,production,secrets)}
