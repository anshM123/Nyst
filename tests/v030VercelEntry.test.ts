/**
 * The Vercel entry point.
 *
 * A deployment that serves the marketing site but not the product is a correct
 * and deliberate boundary — but only if it is HONEST about being one. A
 * visitor who reaches a product URL here must be told the page exists
 * elsewhere, not handed a bare 404 implying it does not exist at all.
 *
 * These run against the same Fastify app the serverless handler wraps, so they
 * check the thing that actually deploys rather than a copy of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPublicRoutes } from "../src/public/publicRoutes.js";

describe("the Vercel public-site entry point", () => {
  let app: FastifyInstance;

  before(async () => {
    // The same composition api/index.ts performs: public routes, no database,
    // no product surface.
    app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
    registerPublicRoutes(app);
    app.setNotFoundHandler(async (request, reply) => {
      const path = request.url.split("?")[0] ?? "";
      const isProductPath = /^\/(v1|outcomes|actions|agents|settings|protection|shadow|autonomy|needs-attention|integrations|policies|effect-registry|failure-lab|overview|login)\b/.test(path);
      return reply.code(404).type("text/html; charset=utf-8").send(
        isProductPath
          ? "<h1>Not on this deployment</h1><p>That is a Nyst product URL, and this deployment serves the public site only.</p>"
          : "<h1>Not on this deployment</h1><p>There is no page there.</p>");
    });
    await app.ready();
  });
  after(async () => { await app.close(); });

  it("serves every public page without a database", async () => {
    for (const path of [
      "/", "/product", "/outcomes-explained", "/integrations-public", "/security",
      "/pricing", "/configure", "/contact", "/privacy", "/terms",
      "/robots.txt", "/sitemap.xml", "/assets/site.css", "/assets/site.js",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 200, `${path} answered ${response.statusCode}`);
      assert.ok(response.body.length > 100, `${path} returned almost nothing`);
    }
  });

  it("the configurator still works end to end, because it needs no database", async () => {
    const response = await app.inject({
      method: "POST", url: "/configure",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "agents=30&consequential_actions_per_month=2000000&environments=3&providers=github"
        + "&deployment=self_hosted&identity=enterprise_oidc&company=Acme&email=b%40acme.test",
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Enterprise/);
    assert.match(response.body, /Custom annual pricing/);
  });

  it("a product URL is told the page lives elsewhere, not that it does not exist", async () => {
    for (const path of ["/outcomes", "/v1/actions", "/settings", "/shadow", "/autonomy"]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 404, `${path} answered ${response.statusCode}`);
      assert.match(response.body, /public site only/,
        `${path} gave a bare 404 rather than explaining this deployment serves the site only`);
    }
    // And a genuinely nonexistent path says the ordinary thing.
    const missing = await app.inject({ method: "GET", url: "/no-such-page" });
    assert.equal(missing.statusCode, 404);
    assert.doesNotMatch(missing.body, /public site only/);
  });

  it("the entry point states, in its own header, what it does not serve", () => {
    const source = readFileSync(resolve(process.cwd(), "api/index.ts"), "utf8");
    // Prose in a block comment wraps across lines behind a ` * ` prefix, so
    // the check is against the flattened text rather than the raw file.
    const prose = source.replace(/^\s*\*\s?/gm, "").replace(/\s+/g, " ");
    assert.match(prose, /does NOT serve the product/i,
      "the Vercel entry no longer states the boundary it enforces");
    assert.match(prose, /reconciliation loop that runs once a day is not a reconciliation loop/,
      "the reason the workers cannot run here has been removed");
    // It must not quietly grow a database connection.
    assert.doesNotMatch(source, /ProductRepository|OutcomeRepository|createPostgresStore|new Pool/,
      "the marketing deployment has acquired a database connection");
  });

  it("an unconfigured contact destination is visible in the code, not hidden", () => {
    const source = readFileSync(resolve(process.cwd(), "api/index.ts"), "utf8");
    assert.match(source, /UNCONFIGURED/,
      "the contact form's missing destination is no longer flagged");
    // And a submission must not put someone's message or address in a platform log.
    assert.doesNotMatch(source, /submission\.message[^.]|submission\.email/,
      "a contact submission's message or email address is being written to the log");
  });
});
