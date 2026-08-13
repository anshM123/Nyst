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
