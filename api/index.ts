/**
 * VERCEL ENTRY POINT — the public marketing site only.
 *
 * WHAT THIS DOES AND DOES NOT SERVE.
 *
 * This serves the public site: the home page and its causal story, product,
 * outcomes, integrations, security, pricing, the deployment configurator,
 * contact, and the legal pages. All of it is pure functions over static
 * content — no database, no session, no tenant.
 *
 * It deliberately does NOT serve the product. No dashboard, no API, no
 * outcomes, no workers. That is not a limitation to route around, it is the
 * correct boundary:
 *
 *   - Nyst's safety model rests on background workers that hold leases and
 *     reconcile continuously. Serverless functions do not have long-lived
 *     processes, and a reconciliation loop that runs once a day is not a
 *     reconciliation loop.
 *   - Consequence admission requires a real multi-statement transaction on a
 *     dedicated connection. Serverless invocations plus a `pg` pool exhaust a
 *     database's connection limit long before they exhaust anything else.
 *
 * Deploy the product to a platform that runs a normal long-lived Node process
 * next to PostgreSQL — Render, Railway, Fly.io — which is what it is built for.
 * See RUN.md.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import Fastify from "fastify";
import { registerPublicRoutes } from "../dist/src/public/publicRoutes.js";

const app = Fastify({
  logger: false,
  // The platform terminates TLS and forwards the client address, and this
  // instance is only ever reachable through it.
  trustProxy: true,
  bodyLimit: 64 * 1024,
});

app.addHook("onRequest", async (_request, reply) => {
  // The same policy the product serves. Every stylesheet and script on this
  // site is a real file, so nothing inline is ever needed.
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

/**
 * THE CONTACT FORM IS CLOSED ON THIS DEPLOYMENT, DELIBERATELY.
 *
 * This entry point serves the marketing site with NO DATABASE. Until v0.3.1 it
 * supplied a `record_contact` that wrote a line to the platform log and let the
 * page answer "Thank you — we have it". A platform log is not an inbox: the
 * lines roll off, nobody is subscribed to them, and the message itself was
 * deliberately not written to them. So every visitor who used that form was
 * thanked for a message that no longer existed by the time they closed the tab.
 *
 * Supplying no sink at all is the honest configuration. The form renders as
 * closed and the page offers a direct address instead, which is a route that
 * actually reaches someone.
 *
 * TO OPEN IT: give this deployment a database and pass
 * `record_contact: (s) => new InboundRepository(pool).recordContact(s)`, exactly
 * as `scripts/startProduct.ts` does.
 */
registerPublicRoutes(app, {
  // Unset means no address is advertised, rather than one that may bounce.
  ...(process.env.NYST_SALES_CONTACT_EMAIL
    ? { sales_contact_email: process.env.NYST_SALES_CONTACT_EMAIL }
    : {}),
  /**
   * The configurator is a calculator, so it still works with no database. The
   * visitor gets their own answer; only the lead record is lost, and that is
   * recorded as a known gap rather than presented as success.
   */
  record_quote: async (quote) => {
    console.log(JSON.stringify({
      type: "quote_request_not_recorded",
      recommended_plan: quote.recommended_plan,
      agents: (quote.input as { agents?: unknown }).agents,
      received_at: quote.received_at,
      destination: "UNCONFIGURED — this deployment has no database; see api/index.ts",
    }));
    return "NYST-QUOTE-NOTSTORED";
  },
});

/**
 * Anything that is not part of the public site.
 *
 * A visitor who reaches /outcomes or /v1/... here has found a product URL on a
 * marketing deployment. Say so plainly rather than serving a 404 that implies
 * the page does not exist anywhere.
 */
app.setNotFoundHandler(async (request, reply) => {
  const path = request.url.split("?")[0] ?? "";
  const isProductPath = /^\/(v1|outcomes|actions|agents|settings|protection|shadow|autonomy|needs-attention|integrations|policies|effect-registry|failure-lab|overview|login)\b/.test(path);
  return reply.code(404).type("text/html; charset=utf-8").send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Not here — Nyst</title><link rel="stylesheet" href="/assets/site.css"></head>` +
    `<body class="site"><main id="main"><section class="page-head-public">` +
    `<h1>Not on this deployment</h1>` +
    (isProductPath
      ? `<p class="lede">That is a Nyst product URL, and this deployment serves the public site only. ` +
        `The dashboard and API need a long-lived Node process and PostgreSQL — see RUN.md in the repository.</p>`
      : `<p class="lede">There is no page at <code>${path.replace(/[&<>"]/g, "")}</code>.</p>`) +
    `<p><a class="button primary" href="/">Back to the start</a> ` +
    `<a class="button subtle" href="/contact">Talk to us</a></p>` +
    `</section></main></body></html>`);
});

const ready = app.ready();

/**
 * The Vercel handler.
 *
 * Fastify owns a Node HTTP server internally; handing it the request and
 * response directly is the supported way to run it behind another dispatcher.
 */
export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await ready;
  app.server.emit("request", request, response);
}
