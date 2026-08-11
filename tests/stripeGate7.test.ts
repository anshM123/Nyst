import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyResolution } from "../src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { EnvironmentStripeCredentialSource, STRIPE_API_VERSION, STRIPE_CAPTURE_SPEC_VERSION, STRIPE_REFUND_SPEC_VERSION, StripeCredentialError, StripePreconditionError } from "../src/providers/stripe/types.js";
import { STRIPE_CAPTURE_EFFECT, STRIPE_REFUND_EFFECT } from "../src/providers/stripe/types.js";
import { StripeEffectProvider } from "../src/providers/stripe/stripeProvider.js";
import { stripeCaptureService, stripeRefundService } from "../src/providers/stripe/stripeService.js";
import { createStripePaymentCaptureSpec, createStripeRefundSpec } from "../src/providers/stripe/stripeSpec.js";
import { NystRuntime } from "../src/runtime/nystRuntime.js";
import { EffectRegistry } from "../src/runtime/registry.js";
import { ProcessCrashError } from "../src/runtime/provider.js";
import { STRIPE_INPUT, makeStripeHarness } from "./stripeHelpers.js";

describe("Gate 7 Stripe contracts and sandbox boundaries", () => {
  it("pins both EffectSpecs and the researched API version", () => {
    assert.equal(STRIPE_API_VERSION, "2026-02-25.clover"); assert.equal(STRIPE_REFUND_SPEC_VERSION, "stripe.refund/1.0.0"); assert.equal(STRIPE_CAPTURE_SPEC_VERSION, "stripe.payment_capture/1.0.0");
  });
  it("rejects live, malformed, missing, and wrong-reference credentials", async () => {
    const source = new EnvironmentStripeCredentialSource(); const prior = process.env.NYST_STRIPE_API_KEY;
    try {
      for (const value of [undefined, "sk_live_REAL_MONEY_FORBIDDEN", "rk_live_FORBIDDEN", "bad", "sk_test_bad\nvalue"]) {
        if (value === undefined) delete process.env.NYST_STRIPE_API_KEY; else process.env.NYST_STRIPE_API_KEY = value;
        await assert.rejects(() => source.resolve("env:NYST_STRIPE_CREDENTIAL"), StripeCredentialError);
      }
      process.env.NYST_STRIPE_API_KEY = "sk_test_VALID_FAKE_ONLY";
      await assert.rejects(() => source.resolve("env:OTHER"), StripeCredentialError);
    } finally { if (prior === undefined) delete process.env.NYST_STRIPE_API_KEY; else process.env.NYST_STRIPE_API_KEY = prior; }
  });
  it("persists action-derived idempotency and credential reference, never a key", async () => {
    const h = makeStripeHarness("refund"); const result = await h.service.commit("refund-plan", STRIPE_INPUT, EMPTY_CONTEXT);
    assert.match(result.action.dispatch_plan?.idempotency_key ?? "", new RegExp(result.action.action_id));
    assert.equal(result.action.dispatch_plan?.credential_ref, "env:NYST_STRIPE_CREDENTIAL");
    assert.equal(result.action.context.value_minor_units, STRIPE_INPUT.amount_minor);
    assert.equal(result.action.context.value_currency, STRIPE_INPUT.currency);
    assert.equal(JSON.stringify(result).includes("sk_test_"), false);
  });
  it("uses Stripe's default final full capture without the multicapture-only final_capture parameter", async () => {
    const h = makeStripeHarness("capture");
    const result = await h.service.commit("capture-request-contract", STRIPE_INPUT, EMPTY_CONTEXT);
    const request = h.transport.requests.find((item) => item.method === "POST" && item.path.endsWith("/capture"));
    assert(request?.body);
    const form = new URLSearchParams(request.body);
    assert.equal(form.get("amount_to_capture"), String(STRIPE_INPUT.amount_minor));
    assert.equal(form.get("metadata[nyst_action_id]"), result.action.action_id);
    assert.equal(form.has("final_capture"), false);
  });
});

for (const effect of ["refund", "capture"] as const) describe(`Gate 7 Stripe ${effect} semantics`, () => {
  it("clean success performs one write and produces an attributed verified receipt", async () => {
    const h = makeStripeHarness(effect); const result = await h.service.commit(`${effect}-clean`, STRIPE_INPUT, EMPTY_CONTEXT);
    assert.equal(h.transport.mutationCount, 1); assert.equal(result.resolution.effect.state, "verified");
    assert.equal(result.resolution.control.retry, "forbidden"); assert.equal(result.resolution.control.continuation, "allowed");
    assert.equal(verifyResolution(h.signer, result.resolution), true);
  });
  it("preexisting exact goal performs zero writes and remains satisfied_unattributed", async () => {
    const h = makeStripeHarness(effect); effect === "refund" ? h.transport.setPreexistingRefund() : h.transport.setPreexistingCapture();
    const result = await h.service.commit(`${effect}-preexisting`, STRIPE_INPUT, EMPTY_CONTEXT);
    assert.equal(h.transport.mutationCount, 0); assert.equal(result.resolution.effect.state, "satisfied_unattributed");
  });
  it("response loss after consequence reconciles without redispatch", async () => {
    const h = makeStripeHarness(effect); h.transport.responseLossAfterEffect = true;
    const first = await h.service.commit(`${effect}-response-loss`, STRIPE_INPUT, EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "verified"); assert.equal(h.transport.mutationCount, 1);
    await h.runtime.recover(first.action.action_id); assert.equal(h.transport.mutationCount, 1);
  });
  it("a definitely-not-sent financial action never becomes an automatic retry", async () => {
    const h = makeStripeHarness(effect); h.transport.failDefinitelyBeforeSend = true;
    const result = await h.service.commit(`${effect}-not-sent`, STRIPE_INPUT, EMPTY_CONTEXT);
    assert.equal(result.resolution.effect.state, "not_applied"); assert.equal(result.resolution.control.retry, "forbidden"); assert.equal(h.transport.mutationCount, 0);
  });
  it("malformed success response is ambiguous and reconciles from state once", async () => {
    const h = makeStripeHarness(effect); h.transport.malformedMutationResponse = true;
    const result = await h.service.commit(`${effect}-malformed-post`, STRIPE_INPUT, EMPTY_CONTEXT);
    assert.equal(result.resolution.effect.state, "verified"); assert.equal(h.transport.mutationCount, 1);
  });
  it("crash after consequence recovers with one financial write", async () => {
    let crashed = false; const h = makeStripeHarness(effect, undefined, { fault_injector(point) { if (!crashed && point === "after_provider_mutation") { crashed = true; throw new ProcessCrashError(point); } } });
    await assert.rejects(() => h.service.commit(`${effect}-crash`, STRIPE_INPUT, EMPTY_CONTEXT), ProcessCrashError);
    const action = await h.store.actions.findByIdentity(h.effect, `${effect}-crash`); assert(action);
    const resolution = await h.runtime.recover(action.action_id); assert.equal(resolution.effect.state, "verified"); assert.equal(h.transport.mutationCount, 1);
  });
  it("2/10/100 callers remain one action and one financial write", async () => {
    for (const count of [2, 10, 100]) { const h = makeStripeHarness(effect); h.transport.responseDelayMs = 2;
      const results = await Promise.all(Array.from({ length: count }, () => h.service.commit(`${effect}-concurrent-${count}`, STRIPE_INPUT, EMPTY_CONTEXT)));
      assert.equal(new Set(results.map((r) => r.action.action_id)).size, 1); assert.equal(h.transport.mutationCount, 1); }
  });
  it("semantic collision cannot create a second financial effect", async () => {
    const h = makeStripeHarness(effect); await h.service.commit(`${effect}-collision`, STRIPE_INPUT, EMPTY_CONTEXT);
    await assert.rejects(() => h.service.commit(`${effect}-collision`, { ...STRIPE_INPUT, amount_minor: 1199 }, EMPTY_CONTEXT)); assert.equal(h.transport.mutationCount, 1);
  });
  it("current authentication/visibility/provider failures fail before consequence", async () => {
    for (const status of [401, 403, 404, 409, 429, 500, 502, 503]) { const h = makeStripeHarness(effect); h.transport.forceReadStatus = status;
      await assert.rejects(() => h.service.commit(`${effect}-read-${status}`, STRIPE_INPUT, EMPTY_CONTEXT)); assert.equal(h.transport.mutationCount, 0); }
  });
  it("post-consequence observation faults never redispatch or authorize continuation", async () => {
    for (const status of [401, 403, 404, 429, 500, 502, 503]) {
      const h = makeStripeHarness(effect); h.transport.postMutationReadStatus = status;
      const result = await h.service.commit(`${effect}-post-read-${status}`, STRIPE_INPUT, EMPTY_CONTEXT);
      assert.equal(h.transport.mutationCount, 1);
      assert.equal(result.resolution.effect.state, status === 429 ? "pending" : "unprovable");
      assert.equal(result.resolution.control.retry, "forbidden"); assert.equal(result.resolution.control.continuation, "blocked");
      h.transport.postMutationReadStatus = null;
      const recovered = await h.runtime.reconcile(result.action.action_id);
      assert.equal(recovered.effect.state, "verified"); assert.equal(h.transport.mutationCount, 1);
    }
  });
  it("stale retry and continuation handles cannot cross a newer resolution", async () => {
    const h = makeStripeHarness(effect); const first = await h.service.commit(`${effect}-stale-handles`, STRIPE_INPUT, EMPTY_CONTEXT);
    const newer = await h.runtime.reconcile(first.action.action_id); assert.ok(newer.runtime!.resolution_sequence > first.resolution.runtime!.resolution_sequence);
    await assert.rejects(() => h.runtime.authorizeContinuation(first.action.action_id, first.resolution.resolution_id));
    await assert.rejects(() => h.runtime.retry(first.action.action_id, first.resolution.resolution_id));
    assert.equal(h.transport.mutationCount, 1);
  });
});

describe("Gate 7 provider-specific unsupported topology", () => {
  it("malicious Stripe EffectSpecs cannot promote unattributed state or authorize retry", async () => {
    for (const effect of ["refund", "capture"] as const) {
      const h = makeStripeHarness(effect); effect === "refund" ? h.transport.setPreexistingRefund() : h.transport.setPreexistingCapture();
      const legitimate = effect === "refund" ? createStripeRefundSpec() : createStripePaymentCaptureSpec();
      const malicious = { ...legitimate,
        assess(_action: Parameters<typeof legitimate.assess>[0], evidence: Parameters<typeof legitimate.assess>[1]) { return { proposed_state: "verified" as const, provider_object_refs: [], evidence_refs: evidence.map((e) => e.evidence_id), verification_methods: ["provider_read_back" as const], claimed_strength: "authoritative" as const, attribution_established: true }; },
        decide() { return { decision_version: 1, primary: "continue" as const, retry: "allowed" as const, continuation: "allowed" as const, recovery: "none" as const, reason_code: "MALICIOUS", explanation: "bypass", policy_version: "evil", spec_version: legitimate.schema_version }; },
      };
      const registry = new EffectRegistry(); registry.register(malicious);
      const name = effect === "refund" ? STRIPE_REFUND_EFFECT : STRIPE_CAPTURE_EFFECT;
      const runtime = new NystRuntime(h.store, registry, [new StripeEffectProvider(name, h.client, h.clock)], h.signer, h.clock);
      const service = effect === "refund" ? stripeRefundService(runtime, h.client, h.clock) : stripeCaptureService(runtime, h.client, h.clock);
      const result = await service.commit(`${effect}-malicious`, STRIPE_INPUT, EMPTY_CONTEXT);
      assert.notEqual(result.resolution.effect.state, "verified"); assert.notEqual(result.resolution.control.retry, "allowed");
    }
  });
  it("rejects caller-conflicting monetary context before a write", async () => {
    const h = makeStripeHarness("refund");
    await assert.rejects(() => h.service.commit("bad-money-context", STRIPE_INPUT, { ...EMPTY_CONTEXT, value_minor_units: 1, value_currency: "eur" }), StripePreconditionError);
    assert.equal(h.transport.mutationCount, 0);
  });
  it("rejects partial/multiple refund topology before a write", async () => {
    const h = makeStripeHarness("refund"); h.transport.refunds = [{ id: "re_partial001", object: "refund", amount: 400, currency: "usd", status: "succeeded", payment_intent: STRIPE_INPUT.payment_intent_id, charge: STRIPE_INPUT.charge_id, metadata: {} }]; h.transport.chargeAmountRefunded = 400;
    await assert.rejects(() => h.service.commit("partial-refund", STRIPE_INPUT, EMPTY_CONTEXT), StripePreconditionError); assert.equal(h.transport.mutationCount, 0);
  });
  it("refund pending holds; refund failure proves absence but never retries", async () => {
    const pending = makeStripeHarness("refund"); pending.transport.refundResult = "pending"; const p = await pending.service.commit("refund-pending", STRIPE_INPUT, EMPTY_CONTEXT);
    assert.equal(p.resolution.effect.state, "pending"); assert.equal(p.resolution.control.retry, "forbidden");
    const failed = makeStripeHarness("refund"); failed.transport.refundResult = "failed"; const f = await failed.service.commit("refund-failed", STRIPE_INPUT, EMPTY_CONTEXT);
    assert.equal(f.resolution.effect.state, "not_applied"); assert.equal(f.resolution.control.retry, "forbidden");
  });
  it("detects a concurrent duplicate refund inventory and never reports completion", async () => {
    const h = makeStripeHarness("refund");
    h.transport.beforeMutation = () => h.transport.setPreexistingRefund();
    const result = await h.service.commit("refund-external-race", STRIPE_INPUT, EMPTY_CONTEXT);
    assert.equal(h.transport.refunds.length, 2); assert.equal(h.transport.mutationCount, 1);
    assert.equal(result.resolution.effect.state, "unprovable"); assert.equal(result.resolution.control.continuation, "blocked");
  });
  it("rejects automatic, partial, expired, canceled, and wrong capture states", async () => {
    const cases: Array<(h: ReturnType<typeof makeStripeHarness>) => void> = [
      (h) => { h.transport.captureMethod = "automatic"; }, (h) => { h.transport.amountCapturable = 700; },
      (h) => { h.transport.status = "canceled"; }, (h) => { h.transport.status = "requires_payment_method"; },
      (h) => { h.transport.amountReceived = 100; },
    ];
    for (let i = 0; i < cases.length; i++) { const h = makeStripeHarness("capture"); cases[i]!(h); await assert.rejects(() => h.service.commit(`capture-unsupported-${i}`, STRIPE_INPUT, EMPTY_CONTEXT), StripePreconditionError); assert.equal(h.transport.mutationCount, 0); }
  });
  it("rejects live-mode objects before every financial write", async () => {
    for (const effect of ["refund", "capture"] as const) { const h = makeStripeHarness(effect); h.transport.livemode = true;
      await assert.rejects(() => h.service.commit(`${effect}-live-forbidden`, STRIPE_INPUT, EMPTY_CONTEXT), StripePreconditionError); assert.equal(h.transport.mutationCount, 0); }
  });
  it("deterministic property sequences preserve financial safety", async () => {
    for (const seed of [7, 71, 701, 7001, 65537]) {
      let state = seed >>> 0; const next = () => (state = (state * 1664525 + 1013904223) >>> 0);
      for (let iteration = 0; iteration < 20; iteration++) for (const effect of ["refund", "capture"] as const) {
        const h = makeStripeHarness(effect); const mode = next() % 4;
        if (mode === 0) h.transport.responseLossAfterEffect = true;
        if (mode === 1) h.transport.successfulResponseWithoutEffect = true;
        if (mode === 2) h.transport.failMayHaveBeenSent = true;
        if (mode === 3) h.transport.postMutationReadStatus = 429;
        const result = await h.service.commit(`${effect}-property-${seed}-${iteration}`, STRIPE_INPUT, EMPTY_CONTEXT);
        assert.ok(h.transport.mutationCount <= 1); assert.equal(result.resolution.control.retry, "forbidden");
        if (result.resolution.effect.state !== "verified") assert.equal(result.resolution.control.continuation, "blocked");
      }
    }
  });
  it("repeated response-loss stress never exceeds one write", async () => {
    for (const effect of ["refund", "capture"] as const) for (let i = 0; i < 25; i++) { const h = makeStripeHarness(effect); h.transport.responseLossAfterEffect = true; const r = await h.service.commit(`${effect}-stress-${i}`, STRIPE_INPUT, EMPTY_CONTEXT); assert.equal(r.resolution.effect.state, "verified"); await Promise.all(Array.from({ length: 10 }, () => h.runtime.reconcile(r.action.action_id))); assert.equal(h.transport.mutationCount, 1); }
  });
});
