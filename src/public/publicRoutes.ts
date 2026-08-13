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
  /** Where a contact submission goes. Omit and submissions are logged only. */
  record_contact?: (submission: {
    name: string; email: string; company: string; topic: string; message: string; received_at: string;
  }) => Promise<void>;
  /** Where a configuration submission goes. */
  record_quote?: (quote: { input: QuoteInput; recommended_plan: string; received_at: string }) => Promise<void>;
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

export function registerPublicRoutes(app: FastifyInstance, options: PublicRouteOptions = {}): void {
  const html = (reply: FastifyReply, body: string): FastifyReply =>
    reply.type("text/html; charset=utf-8").send(body);

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
    if (options.record_quote) {
      await options.record_quote({ input, recommended_plan: result.recommended_plan, received_at: new Date().toISOString() });
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

  app.get("/contact", async (request, reply) => {
    const query = request.query as { topic?: unknown };
    return html(reply, contactPage(query.topic === undefined ? null : String(query.topic), false));
  });

  app.post("/contact", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const submission = {
      name: bounded(body.name, 120), email: bounded(body.email, 320), company: bounded(body.company, 120),
      topic: bounded(body.topic, 40) || "general", message: bounded(body.message, 4000),
      received_at: new Date().toISOString(),
    };
    if (!submission.email || !submission.message) {
      return reply.code(400).type("text/html; charset=utf-8")
        .send(contactPage(submission.topic, false));
    }
    if (options.record_contact) await options.record_contact(submission);
    return html(reply, contactPage(submission.topic, true));
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
