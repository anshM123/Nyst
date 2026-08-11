import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { actionPage, actionsPage, loginPage, offboardingPage, receiptPage } from "../src/product/dashboard.js";
import { sanitizeForProduct } from "../src/product/sanitize.js";
import { NystApiError, NystClient } from "../src/product/sdk.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";

describe("Gate 8 product security and SDK contracts", () => {
  it("recursively redacts credential-shaped keys and values while retaining references", () => {
    const value = sanitizeForProduct({ credential_ref: "env:NYST_STRIPE_CREDENTIAL", token: "never", nested: { authorization: "Bearer abcdefgh", harmless: "ok", raw: "sk_live_FORBIDDEN123" } });
    assert.deepEqual(value, { credential_ref: "env:NYST_STRIPE_CREDENTIAL", token: "[REDACTED]", nested: { authorization: "[REDACTED]", harmless: "ok", raw: "[REDACTED]" } });
  });
  it("escapes persisted values in the signature action view and uses no inline script", () => {
    const html = actionPage({ action_id: "id", effect_name: "fake", business_key: `<img src=x onerror=alert(1)>`, input_hash: "hash", input: { value: "<script>bad()</script>" }, dispatch_plan: null }, [], []);
    assert.doesNotMatch(html, /<img src=x|<script>bad/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<[^>]+\s(?:onclick|onerror)=/);
    assert.match(loginPage(), /<script src="\/assets\/login\.js" defer><\/script>/); assert.doesNotMatch(loginPage(), /<script>[^<]/);
    const receipt=receiptPage({action_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",effect_name:"fake"},{effect:{state:"verified"},control:{primary:"continue"},payload:"<script>bad()</script>"},true);assert.match(receipt,/Signature verification/);assert.match(receipt,/VALID/);assert.match(receipt,/Export JSON/);assert.doesNotMatch(receipt,/<script>bad/);
    assert.match(actionsPage([],"Actions",{state:`"><img src=x onerror=bad>`}),/Filter actions/);assert.doesNotMatch(actionsPage([],"Actions",{state:`"><img src=x onerror=bad>`}),/<img src=x/);
    const demo=offboardingPage([]);for(const text of ["Narrow integrated recovery","No offboarding runs","Nothing is fabricated for this environment"])assert.match(demo,new RegExp(text));
  });
  it("SDK sends the API key only in authorization and supports commit/retrieval", async () => {
    const seen: Array<{ url: string; auth: string | null; body: string | null }> = [];
    const fakeFetch: typeof fetch = async (input, init) => { const headers = new Headers(init?.headers); seen.push({ url: String(input), auth: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : null }); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); };
    const client = new NystClient({ baseUrl: "https://nyst.test", apiKey: "nyst_abcdefgh.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", fetch: fakeFetch });
    await client.commit({ effect: "fake.repository_permission_change", businessKey: "x", input: {} }); await client.receipt("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(seen.length, 2); assert.ok(seen.every((item) => item.auth?.startsWith("Nyst nyst_"))); assert.ok(seen.every((item) => !item.url.includes("nyst_"))); assert.equal(seen[0]?.body?.includes("businessKey"), true);
  });
  it("SDK exposes bounded provider errors without retrying", async () => {
    let calls = 0; const client = new NystClient({ baseUrl: "https://nyst.test", apiKey: "nyst_abcdefgh.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", fetch: async () => { calls++; return new Response(JSON.stringify({ error: "unprovable" }), { status: 409, headers: { "content-type": "application/json" } }); } });
    await assert.rejects(() => client.action("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), NystApiError); assert.equal(calls, 1);
  });
  it("refuses to register the deterministic fake in production", () => {
    assert.throws(() => createProductProviderRuntime({} as never, {} as never, {} as never, {} as never, { production: true, enable_development_fake: true }), /cannot be enabled in production/);
  });
});
