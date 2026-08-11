import type { ClockAttestation, ClockAttestor } from "../src/core/clock.js";
import { Ed25519Signer } from "../src/core/signing.js";
import { StripeRestClient } from "../src/providers/stripe/stripeClient.js";
import { StripeEffectProvider } from "../src/providers/stripe/stripeProvider.js";
import { stripeCaptureService, stripeRefundService } from "../src/providers/stripe/stripeService.js";
import { createStripePaymentCaptureSpec, createStripeRefundSpec } from "../src/providers/stripe/stripeSpec.js";
import {
  STRIPE_CAPTURE_EFFECT, STRIPE_CREDENTIAL_REF, STRIPE_REFUND_EFFECT,
  StripeTransportError, type StripeCredentialSource, type StripeHttpRequest, type StripeHttpResponse,
  type StripePaymentIntentStatus, type StripeRefund, type StripeTransport,
} from "../src/providers/stripe/types.js";
import { NystRuntime, type NystRuntimeOptions } from "../src/runtime/nystRuntime.js";
import { EffectRegistry } from "../src/runtime/registry.js";
import { createMemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";

export const TEST_STRIPE_KEY = "sk_test_FAKE_NYST_GATE7_SECRET";
export const STRIPE_INPUT = { payment_intent_id: "pi_gate7fixture001", charge_id: "ch_gate7fixture001", amount_minor: 1200, currency: "usd", credential_ref: STRIPE_CREDENTIAL_REF } as const;

export class StripeTestClock implements ClockAttestor {
  private tick = 0;
  constructor(private current = "2026-08-08T12:00:00.000Z") {}
  now(): ClockAttestation { return { source: "local_system_clock", timestamp: new Date(Date.parse(this.current) + this.tick++ * 1000).toISOString(), trusted: false }; }
  advance(ms: number): void { this.current = new Date(Date.parse(this.current) + ms).toISOString(); this.tick = 0; }
}
class StaticStripeCredentials implements StripeCredentialSource { async resolve(ref: string): Promise<string> { if (ref !== STRIPE_CREDENTIAL_REF) throw new Error("bad ref"); return TEST_STRIPE_KEY; } }

export class ScriptedStripeTransport implements StripeTransport {
  readonly accountId = "acct_gate7fixture001";
  status: StripePaymentIntentStatus;
  captureMethod: string;
  amountReceived: number;
  amountCapturable: number;
  chargeAmountRefunded = 0;
  chargeRefunded = false;
  refunds: StripeRefund[] = [];
  paymentMetadata: Record<string, string> = {};
  livemode = false;
  mutationCount = 0;
  responseLossAfterEffect = false;
  failDefinitelyBeforeSend = false;
  failMayHaveBeenSent = false;
  successfulResponseWithoutEffect = false;
  malformedMutationResponse = false;
  refundResult: "succeeded" | "pending" | "failed" = "succeeded";
  postMutationReadStatus: number | null = null;
  forceReadStatus: number | null = null;
  responseDelayMs = 0;
  beforeMutation: (() => void | Promise<void>) | null = null;
  readonly requests: Array<{ method: string; path: string; idempotency: string | null; authorization: boolean; body: string | null }> = [];
  private serial = 0;
  constructor(effect: "refund" | "capture") {
    this.status = effect === "refund" ? "succeeded" : "requires_capture";
    this.captureMethod = effect === "refund" ? "automatic" : "manual";
    this.amountReceived = effect === "refund" ? STRIPE_INPUT.amount_minor : 0;
    this.amountCapturable = effect === "refund" ? 0 : STRIPE_INPUT.amount_minor;
  }
  async send(request: StripeHttpRequest): Promise<StripeHttpResponse> {
    if (this.responseDelayMs) await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs));
    const url = new URL(request.url); const path = url.pathname;
    if (url.origin !== "https://api.stripe.com" || request.headers.Authorization !== `Bearer ${TEST_STRIPE_KEY}`) throw new Error("unsafe Stripe request");
    this.requests.push({ method: request.method, path, idempotency: request.headers["Idempotency-Key"] ?? null, authorization: true, body: request.body });
    const headers = { "request-id": `req_GATE7_${++this.serial}` };
    if (request.method === "GET" && (this.forceReadStatus || this.postMutationReadStatus && this.mutationCount > 0)) {
      return { status: this.forceReadStatus ?? this.postMutationReadStatus!, headers, body: { error: { type: "api_error" } } };
    }
    if (request.method === "GET" && path === "/v1/account") return { status: 200, headers, body: { id: this.accountId, object: "account" } };
    if (request.method === "GET" && path === `/v1/payment_intents/${STRIPE_INPUT.payment_intent_id}`) return { status: 200, headers, body: this.paymentIntent() };
    if (request.method === "GET" && path === `/v1/charges/${STRIPE_INPUT.charge_id}`) return { status: 200, headers, body: this.charge() };
    if (request.method === "GET" && path === "/v1/refunds") return { status: 200, headers, body: { object: "list", has_more: false, data: this.refunds } };
    if (request.method === "POST" && (path === "/v1/refunds" || path.endsWith("/capture"))) {
      if (this.failDefinitelyBeforeSend) throw new StripeTransportError("injected", "definitely_not_sent");
      if (this.failMayHaveBeenSent) throw new StripeTransportError("injected", "may_have_been_sent");
      if (!request.headers["Idempotency-Key"]) throw new Error("missing idempotency key");
      await this.beforeMutation?.(); this.mutationCount++;
      const values = new URLSearchParams(request.body ?? ""); const actionId = values.get("metadata[nyst_action_id]") ?? "";
      if (!this.successfulResponseWithoutEffect) {
        if (path === "/v1/refunds") {
          const refund: StripeRefund = { id: `re_gate7_${this.mutationCount}`, object: "refund", amount: STRIPE_INPUT.amount_minor, currency: "usd", status: this.refundResult, payment_intent: STRIPE_INPUT.payment_intent_id, charge: STRIPE_INPUT.charge_id, metadata: { nyst_action_id: actionId } };
          this.refunds = [...this.refunds, refund];
          if (this.refundResult === "succeeded") { this.chargeAmountRefunded = STRIPE_INPUT.amount_minor; this.chargeRefunded = true; }
        } else {
          this.status = "succeeded"; this.amountReceived = STRIPE_INPUT.amount_minor; this.amountCapturable = 0; this.paymentMetadata = { nyst_action_id: actionId };
        }
      }
      if (this.responseLossAfterEffect) throw new StripeTransportError("response lost", "may_have_been_sent");
      if (this.malformedMutationResponse) return { status: 200, headers, body: { object: "malformed" } };
      return { status: 200, headers, body: path === "/v1/refunds" ? this.refunds[0] : this.paymentIntent() };
    }
    return { status: 404, headers, body: { error: { type: "invalid_request_error" } } };
  }
  setPreexistingRefund(): void { this.refunds = [{ id: "re_gate7_preexisting", object: "refund", amount: STRIPE_INPUT.amount_minor, currency: "usd", status: "succeeded", payment_intent: STRIPE_INPUT.payment_intent_id, charge: STRIPE_INPUT.charge_id, metadata: {} }]; this.chargeAmountRefunded = STRIPE_INPUT.amount_minor; this.chargeRefunded = true; }
  setPreexistingCapture(): void { this.status = "succeeded"; this.amountReceived = STRIPE_INPUT.amount_minor; this.amountCapturable = 0; this.paymentMetadata = {}; }
  private paymentIntent() { return { id: STRIPE_INPUT.payment_intent_id, object: "payment_intent", livemode: this.livemode, amount: STRIPE_INPUT.amount_minor, amount_received: this.amountReceived, amount_capturable: this.amountCapturable, currency: "usd", status: this.status, capture_method: this.captureMethod, latest_charge: STRIPE_INPUT.charge_id, metadata: this.paymentMetadata }; }
  private charge() { return { id: STRIPE_INPUT.charge_id, object: "charge", livemode: this.livemode, amount: STRIPE_INPUT.amount_minor, amount_refunded: this.chargeAmountRefunded, currency: "usd", paid: true, refunded: this.chargeRefunded, payment_intent: STRIPE_INPUT.payment_intent_id }; }
}

export function makeStripeHarness(effect: "refund" | "capture", store: Store = createMemoryStore(), runtimeOptions: NystRuntimeOptions = {}) {
  const clock = new StripeTestClock(); const transport = new ScriptedStripeTransport(effect); const client = new StripeRestClient(new StaticStripeCredentials(), { clock, transport });
  const registry = new EffectRegistry(); registry.register(createStripeRefundSpec()); registry.register(createStripePaymentCaptureSpec());
  const providers = [new StripeEffectProvider(STRIPE_REFUND_EFFECT, client, clock), new StripeEffectProvider(STRIPE_CAPTURE_EFFECT, client, clock)];
  const signer = Ed25519Signer.ephemeral("stripe-gate7-test"); const runtime = new NystRuntime(store, registry, providers, signer, clock, runtimeOptions);
  const service = effect === "refund" ? stripeRefundService(runtime, client, clock) : stripeCaptureService(runtime, client, clock);
  return { clock, transport, client, registry, signer, runtime, store, service, effect: effect === "refund" ? STRIPE_REFUND_EFFECT : STRIPE_CAPTURE_EFFECT };
}
