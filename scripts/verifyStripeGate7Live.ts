/** Stripe sandbox-only Gate 7 normal and response-loss canaries with cleanup. */
import { randomUUID } from "node:crypto";
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { verifyResolution } from "../dist/src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../dist/src/model/metadata.js";
import { FetchStripeTransport, StripeRestClient } from "../dist/src/providers/stripe/stripeClient.js";
import { StripeEffectProvider } from "../dist/src/providers/stripe/stripeProvider.js";
import { stripeCaptureService, stripeRefundService } from "../dist/src/providers/stripe/stripeService.js";
import { createStripePaymentCaptureSpec, createStripeRefundSpec } from "../dist/src/providers/stripe/stripeSpec.js";
import {
  EnvironmentStripeCredentialSource, STRIPE_API_VERSION, STRIPE_CAPTURE_EFFECT, STRIPE_CREDENTIAL_REF,
  STRIPE_REFUND_EFFECT, StripeTransportError, requireTestStripeKey,
} from "../dist/src/providers/stripe/types.js";
import { NystRuntime } from "../dist/src/runtime/nystRuntime.js";
import { EffectRegistry } from "../dist/src/runtime/registry.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";

class CountingResponseLossTransport {
  financialWrites = 0;
  private dropped = false;
  private readonly inner: FetchStripeTransport;
  private readonly effect: "refund" | "capture";
  private readonly drop: boolean;
  constructor(inner: FetchStripeTransport, effect: "refund" | "capture", drop: boolean) {
    this.inner = inner; this.effect = effect; this.drop = drop;
  }
  async send(request: Parameters<FetchStripeTransport["send"]>[0]) {
    const response = await this.inner.send(request);
    const path = new URL(request.url).pathname;
    const isTarget = request.method === "POST" && (this.effect === "refund" ? path === "/v1/refunds" : path.endsWith("/capture"));
    if (isTarget) {
      this.financialWrites++;
      if (this.drop && !this.dropped && response.status === 200) { this.dropped = true; throw new StripeTransportError("deliberately discarded successful Stripe response", "may_have_been_sent"); }
    }
    return response;
  }
}

const databaseUrl = required("DATABASE_URL");
const apiKey = required("NYST_STRIPE_CREDENTIAL");
requireTestStripeKey(apiKey);
const runId = randomUUID();
const fixtures: Array<{ id: string; amount: number; charge: string | null }> = [];
const store = await createPostgresStore(databaseUrl);

try {
  const results = [];
  for (const effect of ["refund", "capture"] as const) {
    results.push(await runCanary(effect, false));
    results.push(await runCanary(effect, true));
  }
  console.log(JSON.stringify({ gate: 7, live: true, sandbox_only: true, api_version: STRIPE_API_VERSION, canaries: results,
    unsafe_retries: 0, duplicate_financial_writes: 0, false_certainty: 0, receipts_signed: true }));
} finally {
  const cleanup = [];
  for (const fixture of fixtures) cleanup.push(await cleanFixture(fixture));
  await store.close();
  const clean = cleanup.every((item) => item.clean);
  console.log(JSON.stringify({ stripe_fixture_cleanup: clean, fixtures: cleanup }));
  if (!clean) throw new Error("Stripe Gate 7 sandbox fixture cleanup failed");
}

async function runCanary(effect: "refund" | "capture", responseLoss: boolean) {
  const amount = 1200;
  const payment = await createPaymentIntent(amount, effect === "capture");
  assert(payment.livemode === false, "Stripe fixture unexpectedly used live mode");
  assert(typeof payment.latest_charge === "string", "Stripe fixture has no stable latest Charge");
  fixtures.push({ id: payment.id, amount, charge: payment.latest_charge });
  const inner = new FetchStripeTransport();
  const transport = new CountingResponseLossTransport(inner, effect, responseLoss);
  const clock = new LocalSystemClock();
  const client = new StripeRestClient(new EnvironmentStripeCredentialSource(), { clock, transport });
  const registry = new EffectRegistry(); registry.register(createStripeRefundSpec()); registry.register(createStripePaymentCaptureSpec());
  const signer = Ed25519Signer.ephemeral(`stripe-gate7-live-${effect}`);
  const providers = [new StripeEffectProvider(STRIPE_REFUND_EFFECT, client, clock), new StripeEffectProvider(STRIPE_CAPTURE_EFFECT, client, clock)];
  const runtime = new NystRuntime(store, registry, providers, signer, clock);
  const service = effect === "refund" ? stripeRefundService(runtime, client, clock) : stripeCaptureService(runtime, client, clock);
  const input = { payment_intent_id: payment.id, charge_id: payment.latest_charge, amount_minor: amount, currency: "usd", credential_ref: STRIPE_CREDENTIAL_REF };
  const result = await service.commit(`gate7-live:${runId}:${effect}:${responseLoss ? "response-loss" : "normal"}`, input, EMPTY_CONTEXT);
  let resolution = responseLoss ? await runtime.recover(result.action.action_id) : result.resolution;
  // Stripe's independent GET can briefly trail a successful mutation. Preserve
  // the truthful pending result and reconcile by reads only; never redispatch.
  for (let attempt = 0; resolution.effect.state === "pending" && attempt < 60; attempt++) {
    await delay(1_000);
    resolution = await runtime.reconcile(result.action.action_id);
  }
  assert(resolution.effect.state === "verified", `${effect} did not produce attributed verified state`);
  assert(resolution.control.retry === "forbidden", `${effect} authorized retry`);
  assert(verifyResolution(signer, resolution), `${effect} receipt signature failed`);
  assert(transport.financialWrites === 1, `${effect} logical action did not perform exactly one financial write`);
  return { effect, response_loss: responseLoss, effect_state: resolution.effect.state, provider_writes: transport.financialWrites,
    retry: resolution.control.retry, signature_valid: true, payment_intent_id: payment.id };
}

async function createPaymentIntent(amount: number, manual: boolean): Promise<{ id: string; livemode: boolean; status: string; latest_charge: string | null }> {
  const body: Record<string, string> = { amount: String(amount), currency: "usd", payment_method: "pm_card_visa", confirm: "true",
    "payment_method_types[]": "card", "metadata[nyst_gate7_fixture]": runId };
  if (manual) body.capture_method = "manual";
  const result = await stripeRequest("POST", "/v1/payment_intents", body, `nyst-gate7-fixture:${runId}:${fixtures.length}`) as Record<string, unknown>;
  const id = identifier(result.id, "PaymentIntent"); const latest = result.latest_charge === null ? null : identifier(result.latest_charge, "Charge");
  const status = text(result.status, "PaymentIntent status");
  assert(status === (manual ? "requires_capture" : "succeeded"), `Unexpected Stripe fixture status ${status}`);
  return { id, livemode: result.livemode === true, status, latest_charge: latest };
}

async function cleanFixture(fixture: { id: string; amount: number; charge: string | null }): Promise<{ payment_intent_id: string; final_status: string; fully_refunded: boolean; clean: boolean }> {
  try {
    let payment = await stripeRequest("GET", `/v1/payment_intents/${encodeURIComponent(fixture.id)}`, null, null) as Record<string, unknown>;
    let status = text(payment.status, "cleanup PaymentIntent status");
    if (status === "requires_capture") {
      payment = await stripeRequest("POST", `/v1/payment_intents/${encodeURIComponent(fixture.id)}/cancel`, {}, `nyst-gate7-cleanup-cancel:${fixture.id}`) as Record<string, unknown>;
      status = text(payment.status, "cleanup canceled status");
    }
    let fullyRefunded = status === "canceled";
    if (status === "succeeded" && fixture.charge) {
      let charge = await stripeRequest("GET", `/v1/charges/${encodeURIComponent(fixture.charge)}`, null, null) as Record<string, unknown>;
      const refunded = number(charge.amount_refunded, "charge amount_refunded");
      if (refunded < fixture.amount) {
        await stripeRequest("POST", "/v1/refunds", { payment_intent: fixture.id, amount: String(fixture.amount - refunded), "metadata[nyst_gate7_cleanup]": runId }, `nyst-gate7-cleanup-refund:${fixture.id}`);
        charge = await stripeRequest("GET", `/v1/charges/${encodeURIComponent(fixture.charge)}`, null, null) as Record<string, unknown>;
      }
      fullyRefunded = number(charge.amount_refunded, "final charge amount_refunded") === fixture.amount && charge.refunded === true;
    }
    return { payment_intent_id: fixture.id, final_status: status, fully_refunded: fullyRefunded, clean: status === "canceled" || status === "succeeded" && fullyRefunded };
  } catch { return { payment_intent_id: fixture.id, final_status: "cleanup_failed", fully_refunded: false, clean: false }; }
}

async function stripeRequest(method: "GET" | "POST", path: string, values: Record<string, string> | null, idempotency: string | null): Promise<unknown> {
  const response = await fetch(`https://api.stripe.com${path}`, { method, redirect: "error",
    headers: { Authorization: `Bearer ${apiKey}`, "Stripe-Version": STRIPE_API_VERSION, Accept: "application/json",
      ...(values === null ? {} : { "Content-Type": "application/x-www-form-urlencoded" }), ...(idempotency ? { "Idempotency-Key": idempotency } : {}) },
    ...(values === null ? {} : { body: new URLSearchParams(values).toString() }) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.byteLength <= 128 * 1024, "Stripe fixture response exceeded limit");
  let body: unknown; try { body = JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new Error("Stripe fixture returned malformed JSON"); }
  if (response.status < 200 || response.status >= 300) throw new Error(`Stripe fixture request failed with HTTP ${response.status}`);
  return body;
}
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function text(value: unknown, label: string): string { if (typeof value !== "string" || !value || /[\r\n]/.test(value)) throw new Error(`Malformed ${label}`); return value; }
function identifier(value: unknown, label: string): string { const result = text(value, label); if (!/^(?:pi|ch)_[A-Za-z0-9_]{3,252}$/.test(result)) throw new Error(`Malformed ${label}`); return result; }
function number(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Malformed ${label}`); return value; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
