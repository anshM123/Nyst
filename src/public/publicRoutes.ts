/**
 * PUBLIC ROUTES.
 *
 * The marketing site, pricing, the configurator, contact, and the legal pages.
 * Registered on the same Fastify instance as the product but kept in their own
 * module, because the public surface has different rules: no session, no
 * tenant, and a Content-Security-Policy that has to permit the site's own CSS
 * and JS files while still forbidding anything inline.
 *
 * CONTACT IS NEVER GATED. Not behind signup, not behind a cookie banner, not
 * behind an animation. It is a plain page reachable from every other page, and
 * a test asserts it answers 200 with no session and no JavaScript.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SITE_CSS, SITE_JS } from "./siteAssets.js";
import {
  homePage, pricingPage, productPage, outcomesExplainedPage, integrationsPublicPage, securityPage, publicShell,
} from "./site.js";
import { configuratorPage, contactPage, recommendPlan, type QuoteInput } from "./configurator.js";
import { forgotPasswordPage, resetPasswordPage } from "./site.js";
import { signupPage } from "./site.js";
import { escape } from "../product/dashboard.js";

export interface PublicRouteOptions {
  /**
   * Whether this module owns "/".
   *
   * Inside the product server the root is shared: a signed-in operator gets
   * their dashboard there and an anonymous visitor gets the marketing home, so
   * the product registers that route and passes `publicHome` into it.
   */
  mount_root?: boolean;
  /**
   * Where a contact submission goes, durably.
   *
   * Returns the reference shown to the visitor. OMIT IT AND THE FORM REFUSES
   * TO ACCEPT MESSAGES — it does not accept them and drop them, which is what
   * it did before v0.3.1. A form that thanks people for messages nobody will
   * ever read is worse than a form that is honestly closed.
   */
  record_contact?: (submission: {
    name: string; email: string; company: string; topic: string; message: string;
    received_at: string; source_ip?: string | null; user_agent?: string | null;
  }) => Promise<string>;
  /**
   * Where a configuration submission goes.
   *
   * Unlike contact, a failure here does NOT fail the page: the configurator is
   * a calculator, and losing the lead record is Nyst's problem rather than the
   * visitor's. The failure is logged, not shown.
   */
  record_quote?: (quote: {
    input: QuoteInput; recommended_plan: string; received_at: string; source_ip?: string | null;
  }) => Promise<string>;
  /**
   * The address a visitor can write to directly.
   *
   * Configuration, never a constant: a hardcoded address in a template is an
   * address nobody has committed to reading. Unset, no address is advertised
   * at all rather than one that may bounce.
   */
  sales_contact_email?: string;
  /** Reports a submission that could not be stored. Never shown to a visitor. */
  on_error?: (event: Record<string, unknown>) => void;
  /**
   * Password recovery.
   *
   * Omit it and /forgot-password renders and explains that this deployment
   * cannot reset passwords, rather than 404ing a link the sign-in page shows.
   */
  password_reset?: {
    requestReset(input: { email: string; source_ip?: string | null; user_agent?: string | null }):
      Promise<{ accepted: boolean; delivery_unavailable: boolean }>;
    inspect(token: string): Promise<{ valid: boolean }>;
    completeReset(token: string, password: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  /**
   * Create a real Shadow trial account.
   *
   * Omit it and /signup still RENDERS — it simply says this deployment cannot
   * create accounts and offers contact instead. That matters: the marketing
   * site can be deployed without a database, and "Start in Shadow" must not be
   * a dead link there any more than it should be anywhere else.
   */
  create_account?: (input: {
    organization: string; organization_slug: string; display_name: string; email: string; password: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * A fixed-window limit on contact submissions, per source address.
 *
 * In-process and deliberately small. It is a speed bump against a script
 * hammering one form, not a defence against a distributed flood — that belongs
 * at the edge, and claiming otherwise here would be the kind of overstatement
 * this codebase exists to avoid. A multi-instance deployment gets this limit
 * per instance.
 */
class SubmissionLimiter {
  readonly #seen = new Map<string, { count: number; window: number }>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const window = Math.floor(this.now() / this.windowMs);
    const entry = this.#seen.get(key);
    if (!entry || entry.window !== window) {
      // Bounded: a flood of distinct addresses must not become a memory leak.
      if (this.#seen.size > 10_000) this.#seen.clear();
      this.#seen.set(key, { count: 1, window });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

export function registerPublicRoutes(app: FastifyInstance, options: PublicRouteOptions = {}): void {
  const html = (reply: FastifyReply, body: string): FastifyReply =>
    reply.type("text/html; charset=utf-8").send(body);
  const limiter = new SubmissionLimiter();

  /**
   * The visitor's address, for rate limiting and spam triage.
   *
   * `x-forwarded-for` is only meaningful when Fastify is configured to trust
   * the proxy; it is read here because the limit it feeds is a speed bump, and
   * a spoofed value costs an attacker their own bucket rather than someone
   * else's. It is never used for authorization.
   */
  const clientAddress = (request: FastifyRequest): string | null => {
    const forwarded = request.headers["x-forwarded-for"];
    const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = typeof header === "string" ? header.split(",")[0]?.trim() : undefined;
    return first || request.ip || null;
  };

  /**
   * Parse HTML form submissions.
   *
   * Written here rather than pulled in as a dependency, because the whole
   * point of these two forms is that they work with no JavaScript, and a
   * marketing site should not add a runtime dependency to the product server
   * to achieve that. Bounded, and it never throws on malformed input — a
   * visitor with a mangled form gets the form back, not a 500.
   */
  try {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 64 * 1024 },
      (_request, body, done) => {
        try { done(null, parseForm(String(body))); } catch { done(null, {}); }
      });
  } catch {
    // Already registered by the host application. Its parser is fine.
  }

  /**
   * Brand assets, and a sign-in fallback.
   *
   * Both are registered defensively: inside the product server these routes
   * already exist, and Fastify refuses a duplicate. The marketing site must be
   * self-contained when deployed alone, and must not fight the product when
   * mounted alongside it.
   *
   * The sign-in fallback matters more than it looks. The header has a "Sign in"
   * link on every page; on a marketing-only deployment there is no product to
   * sign in to, and a dead Sign in button is exactly the defect this module
   * was just fixed for.
   */
  try {
    app.get("/brand/:asset", async (request, reply) => {
      const asset = String((request.params as { asset?: unknown }).asset ?? "");
      if (!BRAND_ASSETS.includes(asset)) return reply.code(404).send("not found");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      return reply.type("image/png").header("Cache-Control", "public, max-age=86400")
        .send(readFileSync(join(process.cwd(), "public", "brand", asset)));
    });
  } catch { /* The host already serves them. */ }

  try {
    app.get("/login", async (_request, reply) => html(reply, publicShell("Sign in", "/login", `
    <section class="page-head-public">
      <p class="eyebrow">Sign in</p>
      <h1>Not on this deployment</h1>
      <p class="lede">This deployment serves the public site. The Nyst dashboard needs a
        long-lived Node process and a PostgreSQL database, so it runs elsewhere.</p>
    </section>
    <section class="band">
      <p>If your organization already uses Nyst, sign in at your own Nyst address — the one your
        team deployed, not this one.</p>
      <div class="hero-cta">
        <a class="button primary" href="/contact?topic=general">Ask us where yours is</a>
        <a class="button subtle" href="/signup?plan=shadow_trial">Start in Shadow instead</a>
      </div>
    </section>`, { description: "Sign in to Nyst." })));
  } catch { /* The product owns /login. */ }

  app.get("/assets/site.css", async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(SITE_CSS));
  app.get("/assets/site.js", async (_request, reply) =>
    reply.type("application/javascript; charset=utf-8").send(SITE_JS));

  if (options.mount_root !== false) app.get("/", async (_request, reply) => html(reply, homePage()));
  app.get("/product", async (_request, reply) => html(reply, productPage()));
  app.get("/outcomes-explained", async (_request, reply) => html(reply, outcomesExplainedPage()));
  app.get("/integrations-public", async (_request, reply) => html(reply, integrationsPublicPage()));
  app.get("/security", async (_request, reply) => html(reply, securityPage()));
  app.get("/pricing", async (_request, reply) => html(reply, pricingPage()));

  app.get("/configure", async (request, reply) => {
    const query = request.query as { plan?: unknown };
    return html(reply, configuratorPage(query.plan === undefined ? null : String(query.plan), null, null));
  });

  app.post("/configure", async (request, reply) => {
    const input = parseQuote(request.body);
    const result = recommendPlan(input);
    // Recorded, but never at the cost of the visitor's own answer: this is a
    // calculator, and a storage failure is Nyst's problem, not theirs.
    if (options.record_quote) {
      try {
        await options.record_quote({
          input, recommended_plan: result.recommended_plan,
          received_at: new Date().toISOString(), source_ip: clientAddress(request),
        });
      } catch (error) {
        options.on_error?.({
          type: "quote_request_not_recorded",
          detail: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return html(reply, configuratorPage(null, result, input));
  });

  /* --------------------------------------------------------------- signup */

  app.get("/signup", async (request, reply) => {
    const query = request.query as { plan?: unknown };
    return html(reply, signupPage({
      plan: query.plan === undefined ? null : String(query.plan),
      unavailable_reason: options.create_account ? null : SIGNUP_UNAVAILABLE,
      error: null,
    }));
  });

  app.post("/signup", async (request, reply) => {
    if (!options.create_account) {
      return reply.code(503).type("text/html; charset=utf-8").send(signupPage({
        plan: null, unavailable_reason: SIGNUP_UNAVAILABLE, error: null,
      }));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const submitted = {
      organization: bounded(body.organization, 120),
      organization_slug: bounded(body.organization_slug, 63).toLowerCase(),
      display_name: bounded(body.display_name, 120),
      email: bounded(body.email, 320),
    };
    const password = typeof body.password === "string" ? body.password : "";

    // Validated here as well as in the browser, because `required` and
    // `pattern` attributes are a convenience for people, not a control.
    const problem = validateSignup({ ...submitted, password });
    if (problem) {
      return reply.code(400).type("text/html; charset=utf-8")
        .send(signupPage({ plan: null, unavailable_reason: null, error: problem, submitted }));
    }

    const created = await options.create_account({ ...submitted, password });
    if (!created.ok) {
      return reply.code(409).type("text/html; charset=utf-8")
        .send(signupPage({ plan: null, unavailable_reason: null, error: created.reason, submitted }));
    }
    // Straight to sign-in. Nyst does not silently create a session from a
    // signup form: signing in is where a session is established, and doing it
    // in two places is two places to get it wrong.
    return reply.redirect("/login?created=1");
  });

  /* ------------------------------------------------ password recovery */

  /**
   * THE RESPONSE NEVER REVEALS WHETHER AN ACCOUNT EXISTS.
   *
   * Same page, same words, same status, for a real address and an invented
   * one. A form that distinguishes them enumerates the customer list for
   * anyone who wants it, which is step one of every credential-stuffing run.
   */
  app.get("/forgot-password", async (_request, reply) =>
    html(reply, forgotPasswordPage({ submitted: false })));

  app.post("/forgot-password", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const address = bounded(body.email, 320);

    if (!options.password_reset) {
      return reply.code(503).type("text/html; charset=utf-8").send(forgotPasswordPage({
        submitted: true, delivery_unavailable: true,
        sales_email: options.sales_contact_email ?? null,
      }));
    }

    const outcome = await options.password_reset.requestReset({
      email: address,
      source_ip: clientAddress(request),
      user_agent: bounded(request.headers["user-agent"], 400) || null,
    }).catch((error: unknown) => {
      // A failure here must ALSO be indistinguishable. Reporting it would say
      // "something happened for this address", which is exactly the signal
      // being withheld.
      options.on_error?.({
        type: "password_reset_request_failed",
        detail: error instanceof Error ? error.message : "unknown",
      });
      return { accepted: true, delivery_unavailable: false };
    });

    return html(reply, forgotPasswordPage({
      submitted: true,
      delivery_unavailable: outcome.delivery_unavailable,
      sales_email: options.sales_contact_email ?? null,
    }));
  });

  /**
   * GET does NOT consume the token.
   *
   * Mail clients and link scanners prefetch URLs. A GET that consumed the
   * token would burn a person's reset before they ever saw the page, and they
   * would have no idea why.
   */
  app.get("/reset-password", async (request, reply) => {
    const query = request.query as { token?: unknown };
    const token = bounded(query.token, 128);
    if (!options.password_reset) {
      return reply.code(503).type("text/html; charset=utf-8")
        .send(resetPasswordPage({ token, valid: false }));
    }
    const { valid } = await options.password_reset.inspect(token);
    return html(reply, resetPasswordPage({ token, valid }));
  });

  app.post("/reset-password", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = bounded(body.token, 128);
    const password = typeof body.password === "string" ? body.password : "";

    if (!options.password_reset) {
      return reply.code(503).type("text/html; charset=utf-8")
        .send(resetPasswordPage({ token, valid: false }));
    }

    const result = await options.password_reset.completeReset(token, password);
    if (result.ok) {
      // Every session for this user is already gone -- the database trigger on
      // nyst_users sees to that -- so there is nothing to sign out here.
      return html(reply, resetPasswordPage({ token: "", valid: true, done: true }));
    }
    // A weak password must NOT burn the link, so the form comes back usable.
    const stillValid = (await options.password_reset.inspect(token)).valid;
    return reply.code(400).type("text/html; charset=utf-8").send(resetPasswordPage({
      token, valid: stillValid, error: result.reason,
    }));
  });

  app.get("/contact", async (request, reply) => {
    const query = request.query as { topic?: unknown };
    return html(reply, contactPage(query.topic === undefined ? null : String(query.topic), null, {
      sales_email: options.sales_contact_email ?? null,
      accepting: options.record_contact !== undefined,
    }));
  });

  /**
   * A contact submission.
   *
   * THE ORDER IS THE POINT. The message is stored first, and the visitor is
   * thanked only if that succeeded. Before v0.3.1 the sink was optional and
   * never supplied, so every message was discarded behind a thank-you page.
   */
  app.post("/contact", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const submission = {
      name: bounded(body.name, 120), email: bounded(body.email, 320), company: bounded(body.company, 120),
      topic: bounded(body.topic, 40) || "general", message: bounded(body.message, 4000),
      received_at: new Date().toISOString(),
      source_ip: clientAddress(request), user_agent: bounded(request.headers["user-agent"], 400) || null,
    };
    const context = {
      sales_email: options.sales_contact_email ?? null,
      accepting: options.record_contact !== undefined,
    };

    if (!submission.email || !submission.message || !submission.name) {
      return reply.code(400).type("text/html; charset=utf-8").send(contactPage(submission.topic, null, {
        ...context,
        error: "A name, a work email and a message are all needed before this can be sent.",
      }));
    }

    // A hidden field no person can see and no person fills in. The response is
    // indistinguishable from success, so a bot gets no signal to adapt to.
    if (bounded(body.company_website, 200) !== "") {
      return html(reply, contactPage(submission.topic, "NYST-LEAD-RECEIVED", context));
    }

    if (!limiter.allow(submission.source_ip ?? "unknown")) {
      return reply.code(429).type("text/html; charset=utf-8").send(contactPage(submission.topic, null, {
        ...context,
        error: "That is more messages than this form accepts in a short window. Wait a few minutes, or email us directly.",
      }));
    }

    // No sink means no delivery. Say so; do not accept and discard.
    if (!options.record_contact) {
      return reply.code(503).type("text/html; charset=utf-8").send(contactPage(submission.topic, null, {
        ...context,
        error: "This message could not be recorded, because this deployment has no contact inbox configured. Nothing was sent.",
      }));
    }

    let reference: string;
    try {
      reference = await options.record_contact(submission);
    } catch (error) {
      // The visitor learns their message did not land, and gets a route that
      // does not depend on the thing that just failed. The cause is ours.
      options.on_error?.({
        type: "contact_submission_failed",
        detail: error instanceof Error ? error.message : "unknown",
      });
      return reply.code(503).type("text/html; charset=utf-8").send(contactPage(submission.topic, null, {
        ...context,
        error: "This message could not be delivered right now, so it has not been sent. Please email us directly instead.",
      }));
    }
    return html(reply, contactPage(submission.topic, reference, context));
  });

  /* -------------------------------------------------------- legal pages */

  app.get("/privacy", async (_request, reply) => html(reply, publicShell("Privacy", "/privacy", `
  <section class="page-head-public">
    <p class="eyebrow">Privacy</p>
    <h1>What Nyst stores, and what it refuses to</h1>
  </section>
  <section class="band">
    <h2>Credentials</h2>
    <p>Nyst stores an opaque reference to your credential and never the credential itself. Values
      resolve through a SecretProvider at the moment of use, and are never written to a log, a
      receipt, an export, a screenshot or a screen.</p>
    <h2>What we observe</h2>
    <p>Nyst records observations about the subjects your Outcome contracts name — for example, the
      effective repository permission of a specific login. It does not crawl your estate, and it
      does not build a general inventory. A WorldFact exists because a protected outcome required it.</p>
    <h2>Retention</h2>
    <p>Evidence, resolutions and receipts are append-only: they are the record of what Nyst believed
      and why, and correcting one means writing a new record rather than editing the old one. If you
      need data removed, that is an account-level deletion and we will tell you exactly what it
      removes and what it makes unverifiable.</p>
    <h2>Sub-processors and data location</h2>
    <p>Stated in your agreement rather than here, because it depends on your deployment. Self-hosted
      deployments send us nothing.</p>
  </section>`)));

  app.get("/terms", async (_request, reply) => html(reply, publicShell("Terms", "/terms", `
  <section class="page-head-public">
    <p class="eyebrow">Terms</p>
    <h1>Terms of service</h1>
    <p class="lede">Summary first, because nobody reads the long version and the summary is what we
      actually intend.</p>
  </section>
  <section class="band">
    <h2>What Nyst promises</h2>
    <p>To establish outcomes from evidence it can name, to say clearly when it cannot, and never to
      report a conclusion it did not reach. Where Nyst is blind, it says so rather than assuming.</p>
    <h2>What Nyst does not promise</h2>
    <p>Nyst controls the systems you connect it to, through the effects it supports. It makes no claim
      about systems it is not connected to. An outcome marked SATISFIED means every <em>required and
      configured</em> invariant held on fresh authoritative evidence — not that nothing anywhere is
      wrong.</p>
    <h2>Your commercial plan and your safety</h2>
    <p>Your plan controls how much of Nyst you can turn on. It never controls how safely Nyst behaves.
      Policy, EffectSpec safety, the Autonomy Line, Emergency Freeze, Blast Radius and Outcome
      requirements are identical on every plan, including the free trial.</p>
    <h2>The full agreement</h2>
    <p>The executed agreement governs. Where this page and that document differ, that document wins,
      and we would rather you told us the page was misleading than discovered it later.</p>
  </section>`)));

  /* ------------------------------------------------------------- robots */

  app.get("/robots.txt", async (_request, reply) => reply.type("text/plain; charset=utf-8").send(
    ["User-agent: *", "Allow: /", "Disallow: /v1/", "Disallow: /outcomes", "Disallow: /actions",
      "Disallow: /settings", "", "Sitemap: /sitemap.xml", ""].join("\n")));

  app.get("/sitemap.xml", async (_request, reply) => {
    const paths = ["/", "/product", "/outcomes-explained", "/integrations-public", "/security", "/pricing", "/configure", "/contact", "/privacy", "/terms"];
    reply.type("application/xml; charset=utf-8").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      paths.map((path) => `  <url><loc>${escape(path)}</loc></url>`).join("\n") + `\n</urlset>\n`);
  });
}

/**
 * `application/x-www-form-urlencoded`, decoded.
 *
 * Repeated keys become an array, because checkbox groups depend on it and
 * silently keeping only the last one would quietly drop half a customer's
 * answer.
 */
export function parseForm(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const index = pair.indexOf("=");
    const rawKey = index === -1 ? pair : pair.slice(0, index);
    const rawValue = index === -1 ? "" : pair.slice(index + 1);
    const key = decodeComponent(rawKey);
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const value = decodeComponent(rawValue);
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing as string, value];
  }
  return out;
}

function decodeComponent(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, " ")); }
  catch { return value.replace(/\+/g, " "); }
}

/**
 * Why /signup cannot create an account on a given deployment.
 *
 * Stated as a sentence rather than a 404, because the button that brought them
 * here is a real button and the trial is a real thing — it just needs a
 * deployment with a database behind it.
 */
const BRAND_ASSETS = ["nyst-mark.png", "nyst-wordmark.png", "nyst-domain-wordmark.png", "favicon.png"];

const SIGNUP_UNAVAILABLE =
  "This deployment serves the public site only, so it has no database to create an account in. " +
  "Nyst runs as a normal Node service next to PostgreSQL — talk to us and we will point you at one, " +
  "or run it yourself from the repository in about fifteen minutes.";

/** The first problem with a signup, or null. Returns one at a time, in order. */
function validateSignup(input: {
  organization: string; organization_slug: string; display_name: string; email: string; password: string;
}): string | null {
  if (!input.organization) return "An organization name is required.";
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(input.organization_slug)) {
    return "The short name must start with a letter and contain only lowercase letters, digits and hyphens.";
  }
  if (!input.display_name) return "Your name is required.";
  // Deliberately permissive: an address either delivers or it does not, and a
  // clever pattern mostly rejects people with unusual but valid addresses.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) return "That does not look like an email address.";
  if (input.password.length < 8) return "The password must be at least 8 characters.";
  if (input.password.length > 1024) return "That password is too long.";
  return null;
}

function bounded(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\0]+/g, " ").trim().slice(0, max);
}

function parseQuote(body: unknown): QuoteInput {
  const record = (body ?? {}) as Record<string, unknown>;
  const integer = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.round(parsed), min), max);
  };
  const list = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((item) => bounded(item, 60)).filter(Boolean);
    const single = bounded(value, 60);
    return single ? [single] : [];
  };
  const deployment = bounded(record.deployment, 30);
  const identity = bounded(record.identity, 30);
  return {
    agents: integer(record.agents, 3, 1, 500),
    consequential_actions_per_month: integer(record.consequential_actions_per_month, 50_000, 0, 100_000_000),
    environments: integer(record.environments, 1, 1, 50),
    providers: list(record.providers),
    outcome_packs: list(record.outcome_packs),
    deployment: deployment === "self_hosted" || deployment === "relay" ? deployment : "nyst_cloud",
    identity: identity === "enterprise_oidc" || identity === "local" ? identity : "google",
    needs_security_review: record.needs_security_review !== undefined && record.needs_security_review !== "",
    company: bounded(record.company, 120),
    email: bounded(record.email, 320),
    notes: bounded(record.notes, 2000),
  };
}
