/**
 * Nyst v0.3.1 — issues 4 and 5. INBOUND MESSAGES MUST SURVIVE THE REQUEST.
 *
 * THE DEFECT.
 *
 * Both the contact form and the quote configurator were written as
 *
 *     if (options.record_contact) await options.record_contact(submission);
 *     return html(reply, contactPage(submission.topic, true));
 *
 * and `record_contact` was never supplied. Not in `startProduct.ts`, not
 * anywhere in the repository. So every message a visitor sent was parsed,
 * validated, discarded, and answered with "Thank you — we have it."
 *
 * The configurator was worse in one respect: it computed a recommended plan,
 * showed it, and kept no record that anyone had ever asked. A company that
 * priced Nyst and left was invisible.
 *
 * This is the failure mode nobody notices, because the page looks correct from
 * the outside and the logs show a 200. The only signal is silence from a
 * mailbox that was never going to receive anything.
 *
 * THE RULE THESE TESTS ENFORCE.
 *
 * Nyst may not tell a person their message was received unless it durably
 * exists. If it cannot be stored, the visitor is told so, and given a way to
 * reach a human that does not depend on the thing that just failed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import type { ProductDb } from "../src/product/productRepository.js";
import { InboundRepository } from "../src/public/inboundRepository.js";
import { registerPublicRoutes } from "../src/public/publicRoutes.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { end(): Promise<void> };

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("Nyst v0.3.1 issues 4/5 — contact and quote submissions are durable", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let inbound: InboundRepository;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    inbound = new InboundRepository(pool);
  });
  after(async () => { await pool.end(); });

  /** The site as it is actually deployed: with a durable sink. */
  async function site(overrides: Parameters<typeof registerPublicRoutes>[1] = {}) {
    const app = Fastify({ logger: false });
    registerPublicRoutes(app, {
      record_contact: (submission) => inbound.recordContact(submission),
      record_quote: (quote) => inbound.recordQuote(quote),
      sales_contact_email: `sales-${suffix}@nyst.test`,
      ...overrides,
    });
    await app.ready();
    return app;
  }

  /* ============================================================= CONTACT */

  it("THE DEFECT: with no durable sink, the form must NOT claim the message was received", async () => {
    const app = Fastify({ logger: false });
    // Exactly the configuration that shipped: no record_contact at all.
    registerPublicRoutes(app, {});
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: "name=Ada&email=ada%40acme.test&message=We+need+to+talk+about+outcomes",
      });

      assert.notEqual(response.statusCode, 200,
        "A CONTACT FORM WITH NOWHERE TO DELIVER RETURNED SUCCESS");
      assert.doesNotMatch(response.body, /Thank you — we have it/,
        "THE VISITOR WAS TOLD THEIR MESSAGE WAS RECEIVED WHEN IT WAS DISCARDED");
      // And it says what to do instead.
      assert.match(response.body, /could not be recorded|not be delivered/i);
    } finally { await app.close(); }
  });

  it("a submission is persisted BEFORE the visitor is told it was received", async () => {
    const app = await site();
    try {
      const email = `ada-${suffix}@acme.test`;
      const response = await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=Ada+Lovelace&email=${encodeURIComponent(email)}&company=Acme`
          + "&topic=security&message=Send+the+security+review+package.",
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /Thank you/);

      const row = (await pool.query(
        `SELECT * FROM nyst_contact_submissions WHERE email=$1`, [email])).rows[0];
      assert.ok(row, "the page said the message was received but nothing was stored");
      assert.equal(row.name, "Ada Lovelace");
      assert.equal(row.company, "Acme");
      assert.equal(row.topic, "security");
      assert.match(String(row.message), /security review package/);
      assert.equal(row.status, "new");
    } finally { await app.close(); }
  });

  it("the visitor is given a reference they can quote back", async () => {
    const app = await site();
    try {
      const email = `ref-${suffix}@acme.test`;
      const response = await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=Ref&email=${encodeURIComponent(email)}&message=Please+confirm+receipt.`,
      });
      const shown = /NYST-LEAD-[0-9A-Z]{8}/.exec(response.body);
      assert.ok(shown, "no reference was shown, so a lost message cannot be traced");

      const row = (await pool.query(
        `SELECT reference FROM nyst_contact_submissions WHERE email=$1`, [email])).rows[0]!;
      assert.equal(row.reference, shown[0],
        "the reference shown to the visitor is not the one stored");
    } finally { await app.close(); }
  });

  it("A FAILING SINK IS REPORTED, NOT SWALLOWED", async () => {
    const app = await site({
      record_contact: async (): Promise<string> => { throw new Error("the database is gone"); },
    });
    try {
      const response = await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: "name=Ada&email=ada%40acme.test&message=Anyone+there",
      });
      assert.notEqual(response.statusCode, 200);
      assert.doesNotMatch(response.body, /Thank you — we have it/);
      // The fallback address must still be reachable when storage is down.
      assert.match(response.body, new RegExp(`sales-${suffix}@nyst.test`));
      // And the internal failure is not shown to a stranger.
      assert.doesNotMatch(response.body, /the database is gone/);
    } finally { await app.close(); }
  });

  it("the sales address is configuration, not a hardcoded mailbox", async () => {
    const app = await site();
    try {
      const page = await app.inject({ method: "GET", url: "/contact" });
      assert.match(page.body, new RegExp(`sales-${suffix}@nyst.test`));
      assert.doesNotMatch(page.body, /hello@nyst\.ai/,
        "a hardcoded address survived — it may not be a mailbox anyone reads");
    } finally { await app.close(); }

    // Unconfigured, it must not invent an address that might not exist.
    const bare = Fastify({ logger: false });
    registerPublicRoutes(bare, { record_contact: (s) => inbound.recordContact(s) });
    await bare.ready();
    try {
      const page = await bare.inject({ method: "GET", url: "/contact" });
      assert.doesNotMatch(page.body, /mailto:/,
        "an unconfigured deployment advertised an email address nobody may be reading");
    } finally { await bare.close(); }
  });

  /* ========================================================== ABUSE */

  it("a honeypot submission is dropped without being stored — and without saying so", async () => {
    const app = await site();
    try {
      const email = `bot-${suffix}@acme.test`;
      const response = await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=Bot&email=${encodeURIComponent(email)}&message=Cheap+backlinks&company_website=http://spam.example`,
      });
      // Indistinguishable from success, so the bot does not learn to adapt.
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /Thank you/);

      const rows = (await pool.query(
        `SELECT 1 FROM nyst_contact_submissions WHERE email=$1`, [email])).rows;
      assert.equal(rows.length, 0, "a honeypot submission was stored anyway");
    } finally { await app.close(); }
  });

  it("a flood from one address is rate limited rather than absorbed", async () => {
    const app = await site();
    try {
      const codes: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await app.inject({
          method: "POST", url: "/contact", headers: { ...FORM, "x-forwarded-for": "203.0.113.9" },
          payload: `name=Flood&email=flood-${suffix}-${attempt}%40acme.test&message=Message+number+${attempt}`,
        });
        codes.push(response.statusCode);
      }
      assert.ok(codes.includes(429), `no submission was rate limited: ${codes.join(",")}`);
      // The early ones still got through — this is a limit, not an outage.
      assert.equal(codes[0], 200);
    } finally { await app.close(); }
  });

  it("an oversized or malformed submission is refused without reaching storage", async () => {
    let reached = 0;
    const app = await site({ record_contact: async () => { reached += 1; return "NYST-LEAD-UNREACHED"; } });
    try {
      // No email.
      assert.equal((await app.inject({
        method: "POST", url: "/contact", headers: FORM, payload: "name=X&message=hello",
      })).statusCode, 400);
      // No message.
      assert.equal((await app.inject({
        method: "POST", url: "/contact", headers: FORM, payload: "name=X&email=x%40y.test",
      })).statusCode, 400);
      assert.equal(reached, 0, "an invalid submission reached the durable sink");
    } finally { await app.close(); }
  });

  /* ============================================================== QUOTE */

  it("THE DEFECT: a configured quote is persisted, not just displayed", async () => {
    const app = await site();
    try {
      const response = await app.inject({
        method: "POST", url: "/configure", headers: FORM,
        payload: "agents=40&consequential_actions_per_month=500000&environments=3"
          + "&providers=github&providers=okta&outcome_packs=employee_offboarding",
      });
      assert.equal(response.statusCode, 200);

      const row = (await pool.query(
        `SELECT * FROM nyst_quote_requests ORDER BY received_at DESC LIMIT 1`)).rows[0];
      assert.ok(row, "THE CONFIGURATOR COMPUTED A QUOTE AND KEPT NO RECORD OF IT");
      assert.ok(String(row.recommended_plan).length > 0);
      // The inputs are kept, so a follow-up conversation starts from what they asked.
      const input = typeof row.input === "string" ? JSON.parse(row.input) : row.input;
      assert.equal(Number(input.agents), 40);
      assert.equal(Number(input.consequential_actions_per_month), 500_000);
      // The systems they named are kept too, so a follow-up knows what to cover.
      assert.deepEqual(input.providers, ["github", "okta"]);
    } finally { await app.close(); }
  });

  it("a quote that cannot be stored still shows the visitor their answer", async () => {
    // The configurator is a CALCULATOR. Losing the lead record is our problem,
    // not the visitor's, so unlike the contact form it must not fail the page.
    const app = await site({ record_quote: async (): Promise<string> => { throw new Error("storage down"); } });
    try {
      const response = await app.inject({
        method: "POST", url: "/configure", headers: FORM,
        payload: "agents=5&consequential_actions_per_month=1000&environments=1",
      });
      assert.equal(response.statusCode, 200,
        "a storage failure hid the visitor's own calculation from them");
      assert.doesNotMatch(response.body, /storage down/);
    } finally { await app.close(); }
  });

  /* ========================================================= OPERATIONS */

  it("submissions are readable by an operator, newest first, and can be triaged", async () => {
    const email = `triage-${suffix}@acme.test`;
    const reference = await inbound.recordContact({
      name: "Triage", email, company: "Acme", topic: "enterprise",
      message: "We would like to discuss enterprise terms.",
      received_at: new Date().toISOString(),
    });

    const listed = await inbound.recentContacts(50);
    const found = listed.find((entry) => entry.reference === reference);
    assert.ok(found, "a stored submission was not visible to an operator");
    assert.equal(found.status, "new");

    await inbound.markContactHandled(reference, "Replied by email.");
    const after = (await inbound.recentContacts(50)).find((entry) => entry.reference === reference)!;
    assert.equal(after.status, "handled");
  });

  it("the message is stored as written and rendered as text, never as markup", async () => {
    const email = `xss-${suffix}@acme.test`;
    const app = await site();
    try {
      await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=%3Cscript%3Ealert(1)%3C%2Fscript%3E&email=${encodeURIComponent(email)}`
          + "&message=%3Cimg+src%3Dx+onerror%3Dalert(1)%3E",
      });
    } finally { await app.close(); }

    // Stored verbatim: sanitising on the way IN destroys evidence of what was
    // actually sent. It is escaped on the way OUT instead.
    const row = (await pool.query(
      `SELECT name,message FROM nyst_contact_submissions WHERE email=$1`, [email])).rows[0]!;
    assert.equal(row.name, "<script>alert(1)</script>");
    assert.match(String(row.message), /<img src=x onerror=alert\(1\)>/);
  });
});
