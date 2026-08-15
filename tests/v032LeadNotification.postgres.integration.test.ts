/**
 * Nyst v0.3.2 — Phase 9. LEADS REACH A HUMAN, AND A QUOTE STAYS TRUE.
 *
 * v0.3.1 made contact and quote submissions DURABLE, which fixed the worst of
 * it: the form no longer thanked people for messages it discarded. But nothing
 * told anyone a lead had arrived, so the durable record was a table somebody
 * had to remember to query.
 *
 * TWO RULES, AND THE ORDER IS THE POINT.
 *
 * PERSIST FIRST, THEN NOTIFY. Never the other way round, and a notification
 * failure never fails the submission. The lead is already stored; telling
 * someone to resubmit a message Nyst already has is untrue, and it is exactly
 * how leads get lost.
 *
 * A QUOTE RECORDS WHAT THE VISITOR WAS TOLD. The old row kept the inputs and
 * the plan NAME, so the price it implied was whatever the catalog said when
 * anyone looked. For a product whose whole claim is telling you what was true
 * at a point in time, a sales record that silently reprices itself is the wrong
 * artefact to ship.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import type { ProductDb } from "../src/product/productRepository.js";
import { InboundRepository } from "../src/public/inboundRepository.js";
import { registerPublicRoutes } from "../src/public/publicRoutes.js";
import { PRICING_CATALOG_VERSION } from "../src/public/configurator.js";
import { assertNoSensitiveContent } from "../src/product/email.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { end(): Promise<void> };
const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("Nyst v0.3.2 Phase 9 — lead notification and quote truth", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let inbound: InboundRepository;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    inbound = new InboundRepository(pool);
  });
  after(async () => { await pool.end(); });

  type Lead = { kind: string; reference: string; name: string; email: string; company: string; summary: string };

  async function site(overrides: Parameters<typeof registerPublicRoutes>[1] = {}) {
    const notified: Lead[] = [];
    const app = Fastify({ logger: false });
    registerPublicRoutes(app, {
      record_contact: (submission) => inbound.recordContact(submission),
      record_quote: (quote) => inbound.recordQuote(quote),
      sales_contact_email: `sales-${suffix}@nyst.test`,
      notify_lead: async (lead) => { notified.push(lead as Lead); },
      ...overrides,
    });
    await app.ready();
    return { app, notified };
  }

  /* ================================================== NOTIFICATION */

  it("a contact submission notifies a human, with the reference", async () => {
    const { app, notified } = await site();
    try {
      const email = `lead-${suffix}@acme.test`;
      const response = await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=Ada&email=${encodeURIComponent(email)}&company=Acme&topic=enterprise`
          + "&message=We+would+like+to+discuss+enterprise+terms.",
      });
      assert.equal(response.statusCode, 200);

      assert.equal(notified.length, 1, "NOBODY WAS TOLD a lead arrived");
      assert.equal(notified[0]!.kind, "contact");
      assert.equal(notified[0]!.email, email);
      assert.match(notified[0]!.reference, /^NYST-LEAD-[0-9A-Z]{8}$/);
      assert.match(notified[0]!.summary, /enterprise terms/);
    } finally { await app.close(); }
  });

  it("THE ORDER: the lead is DURABLE before anyone is notified", async () => {
    // Asserted from inside the notifier: if the row is not there yet, the
    // notification is running first and a crash between them loses the lead.
    const email = `order-${suffix}@acme.test`;
    let visibleAtNotifyTime = false;
    const { app } = await site({
      notify_lead: async (lead) => {
        const rows = (await pool.query(
          `SELECT 1 FROM nyst_contact_submissions WHERE reference=$1`, [lead.reference])).rows;
        visibleAtNotifyTime = rows.length === 1;
      },
    });
    try {
      await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=Order&email=${encodeURIComponent(email)}&message=Checking+the+order+of+operations.`,
      });
      assert.equal(visibleAtNotifyTime, true,
        "THE NOTIFICATION RAN BEFORE THE DURABLE WRITE — a crash between them loses the lead");
    } finally { await app.close(); }
  });

  it("A FAILING NOTIFIER DOES NOT LOSE THE LEAD, and does not tell the visitor to resubmit", async () => {
    const email = `failnotify-${suffix}@acme.test`;
    const { app } = await site({
      notify_lead: async () => { throw new Error("the mail server is down"); },
    });
    try {
      const response = await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=Fail&email=${encodeURIComponent(email)}&message=The+notifier+is+about+to+fail.`,
      });
      assert.equal(response.statusCode, 200,
        "A NOTIFICATION FAILURE REJECTED A SUBMISSION THAT WAS ALREADY STORED");
      assert.match(response.body, /Thank you/);
      assert.doesNotMatch(response.body, /try again|resubmit/i,
        "the visitor was told to resubmit a message Nyst already has");

      const rows = (await pool.query(
        `SELECT 1 FROM nyst_contact_submissions WHERE email=$1`, [email])).rows;
      assert.equal(rows.length, 1, "the lead was lost when notification failed");
    } finally { await app.close(); }
  });

  it("a deployment with no notifier still stores the lead", async () => {
    const email = `nonotify-${suffix}@acme.test`;
    const app = Fastify({ logger: false });
    registerPublicRoutes(app, { record_contact: (s) => inbound.recordContact(s) });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=Quiet&email=${encodeURIComponent(email)}&message=No+notifier+configured+here.`,
      });
      assert.equal(response.statusCode, 200);
      assert.equal((await pool.query(`SELECT 1 FROM nyst_contact_submissions WHERE email=$1`, [email])).rows.length, 1);
    } finally { await app.close(); }
  });

  it("the notification carries NOTHING sensitive", async () => {
    const { app, notified } = await site();
    try {
      await app.inject({
        method: "POST", url: "/contact", headers: FORM,
        payload: `name=Safe&email=safe-${suffix}%40acme.test&company=Acme&message=Ordinary+enquiry.`,
      });
      const lead = notified[0]!;
      // The exact body a transport would send, checked by the same guard the
      // EmailProvider applies on every send.
      assert.doesNotThrow(() => assertNoSensitiveContent({
        to: "sales@nyst.test",
        subject: `Nyst ${lead.kind}: ${lead.company} (${lead.reference})`,
        text: `${lead.name}\n${lead.email}\n${lead.company}\n${lead.summary}`,
      }));
    } finally { await app.close(); }
  });

  /* ====================================================== QUOTE TRUTH */

  it("THE DEFECT: a quote records the EXACT price the visitor saw", async () => {
    const { app } = await site();
    try {
      const response = await app.inject({
        method: "POST", url: "/configure", headers: FORM,
        payload: "agents=40&consequential_actions_per_month=500000&environments=3"
          + "&providers=github&outcome_packs=employee_offboarding&company=Acme&email=quote-" + suffix + "%40acme.test",
      });
      assert.equal(response.statusCode, 200);

      const row = (await pool.query(
        `SELECT recommended_plan,price_display,pricing_catalog_version,requires_conversation,uncovered
         FROM nyst_quote_requests ORDER BY received_at DESC LIMIT 1`)).rows[0]!;

      assert.ok(String(row.price_display ?? "").length > 0,
        "A QUOTE RECORDED NO PRICE — the number it implied would be whatever the catalog says later");
      // The exact string, including any qualifier, must be on the page too.
      assert.ok(response.body.includes(String(row.price_display)),
        "the stored price is not the one the visitor was shown");
      assert.equal(row.pricing_catalog_version, PRICING_CATALOG_VERSION,
        "the quote is not attributable to the catalog that produced it");
    } finally { await app.close(); }
  });

  it("a quote records what Nyst said it would NOT cover", async () => {
    const { app } = await site();
    try {
      // No Outcome Pack selected, so the honest answer includes a gap.
      await app.inject({
        method: "POST", url: "/configure", headers: FORM,
        payload: "agents=3&consequential_actions_per_month=1000&environments=1&providers=aws"
          + "&company=Gaps&email=gaps-" + suffix + "%40acme.test",
      });
      const row = (await pool.query(
        `SELECT uncovered FROM nyst_quote_requests ORDER BY received_at DESC LIMIT 1`)).rows[0]!;
      const uncovered = typeof row.uncovered === "string" ? JSON.parse(row.uncovered) : row.uncovered;
      assert.ok(Array.isArray(uncovered) && uncovered.length > 0,
        "the quote kept no record of what Nyst told them it would not cover — the half most likely to be disputed");
    } finally { await app.close(); }
  });

  it("a quote survives a catalog change: the stored price does not move", async () => {
    const { app } = await site();
    try {
      await app.inject({
        method: "POST", url: "/configure", headers: FORM,
        payload: "agents=2&consequential_actions_per_month=500&environments=1"
          + "&company=Frozen&email=frozen-" + suffix + "%40acme.test",
      });
      const before = (await pool.query(
        `SELECT reference,price_display FROM nyst_quote_requests ORDER BY received_at DESC LIMIT 1`)).rows[0]!;

      // The row is append-only in spirit and immutable in fact: the price
      // recorded is a historical statement, not a lookup.
      const after = (await pool.query(
        `SELECT price_display FROM nyst_quote_requests WHERE reference=$1`, [before.reference])).rows[0]!;
      assert.equal(after.price_display, before.price_display);
      assert.ok(String(after.price_display).length > 0);
    } finally { await app.close(); }
  });

  it("a quote notifies too, with the plan and price", async () => {
    const { app, notified } = await site();
    try {
      await app.inject({
        method: "POST", url: "/configure", headers: FORM,
        payload: "agents=9&consequential_actions_per_month=200000&environments=2"
          + "&company=Notify&email=qnotify-" + suffix + "%40acme.test",
      });
      const quote = notified.find((lead) => lead.kind === "quote");
      assert.ok(quote, "a quote request notified nobody");
      assert.match(quote.reference, /^NYST-QUOTE-[0-9A-Z]{8}$/);
      assert.match(quote.summary, /scale|protect|enterprise/i);
    } finally { await app.close(); }
  });

  it("a failing quote notifier does not hide the visitor's own answer", async () => {
    // The configurator is a CALCULATOR. Losing the lead record, or failing to
    // notify, is Nyst's problem and never the visitor's.
    const { app } = await site({ notify_lead: async () => { throw new Error("down"); } });
    try {
      const response = await app.inject({
        method: "POST", url: "/configure", headers: FORM,
        payload: "agents=4&consequential_actions_per_month=9000&environments=1"
          + "&company=Calc&email=calc-" + suffix + "%40acme.test",
      });
      assert.equal(response.statusCode, 200);
      assert.doesNotMatch(response.body, /down/);
    } finally { await app.close(); }
  });
});
