import {
  STRIPE_API_ORIGIN,
  STRIPE_API_VERSION,
  StripeContractError,
  StripeCredentialError,
  StripeTransportError,
  requireTestStripeKey,
  type StripeAccount,
  type StripeApiResponse,
  type StripeCharge,
  type StripeClientOptions,
  type StripeCredentialSource,
  type StripeHttpRequest,
  type StripeHttpResponse,
  type StripePaymentIntent,
  type StripeRefund,
  type StripeRefundStatus,
  type StripeSafeHeaders,
  type StripeTransport,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const OBJECT_ID = /^(?:acct|pi|ch|re)_[A-Za-z0-9_]{3,252}$/;

export class FetchStripeTransport implements StripeTransport {
  constructor(private readonly maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES) {}
  async send(request: StripeHttpRequest): Promise<StripeHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout_ms);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: request.body }),
        redirect: "error",
        signal: controller.signal,
      });
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > this.maxResponseBytes) {
        throw new StripeContractError("Stripe response exceeded the configured size limit");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxResponseBytes) {
        throw new StripeContractError("Stripe response exceeded the configured size limit");
      }
      let body: unknown = null;
      if (bytes.byteLength > 0) {
        try { body = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
        catch { throw new StripeContractError("Stripe returned malformed JSON"); }
      }
      const headers: Record<string, string> = {};
      for (const name of ["request-id", "retry-after", "stripe-rate-limited-reason"]) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return { status: response.status, headers, body };
    } catch (error) {
      if (error instanceof StripeContractError || error instanceof StripeTransportError) throw error;
      throw new StripeTransportError("Stripe transport failed", "may_have_been_sent");
    } finally { clearTimeout(timer); }
  }
}

export class StripeRestClient {
  private readonly transport: StripeTransport;
  private readonly timeoutMs: number;
  constructor(private readonly credentials: StripeCredentialSource, options: StripeClientOptions) {
    this.transport = options.transport ?? new FetchStripeTransport(options.max_response_bytes);
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  async getAccount(ref: string): Promise<StripeApiResponse<StripeAccount>> {
    const response = await this.request("GET", "/v1/account", ref, null, null);
    return { ...response, data: response.status === 200 ? parseAccount(response.data) : null };
  }
  async getPaymentIntent(id: string, ref: string): Promise<StripeApiResponse<StripePaymentIntent>> {
    const response = await this.request("GET", `/v1/payment_intents/${encodedId(id, "PaymentIntent")}`, ref, null, null);
    return { ...response, data: response.status === 200 ? parsePaymentIntent(response.data) : null };
  }
  async getCharge(id: string, ref: string): Promise<StripeApiResponse<StripeCharge>> {
    const response = await this.request("GET", `/v1/charges/${encodedId(id, "Charge")}`, ref, null, null);
    return { ...response, data: response.status === 200 ? parseCharge(response.data) : null };
  }
  async listRefunds(paymentIntentId: string, ref: string): Promise<StripeApiResponse<StripeRefund[]>> {
    const query = new URLSearchParams({ payment_intent: paymentIntentId, limit: "100" });
    const response = await this.request("GET", `/v1/refunds?${query.toString()}`, ref, null, null);
    return { ...response, data: response.status === 200 ? parseRefundList(response.data) : null };
  }
  async createRefund(
    paymentIntentId: string,
    amountMinor: number,
    actionId: string,
    idempotencyKey: string,
    ref: string
  ): Promise<StripeApiResponse<StripeRefund>> {
    const body = form({ payment_intent: paymentIntentId, amount: String(amountMinor), "metadata[nyst_action_id]": actionId });
    const response = await this.request("POST", "/v1/refunds", ref, body, idempotencyKey);
    if (response.status !== 200) return { ...response, data: null };
    try { return { ...response, data: parseRefund(response.data) }; }
    catch { throw new StripeTransportError("Stripe refund response contract failed after consequence", "may_have_been_sent"); }
  }
  async capturePaymentIntent(
    paymentIntentId: string,
    amountMinor: number,
    actionId: string,
    idempotencyKey: string,
    ref: string
  ): Promise<StripeApiResponse<StripePaymentIntent>> {
    // Full capture is already Stripe's default. Do not send final_capture:
    // Stripe only accepts that explicit parameter when multicapture is enabled,
    // which Gate 7 deliberately does not support.
    const body = form({ amount_to_capture: String(amountMinor), "metadata[nyst_action_id]": actionId });
    const response = await this.request(
      "POST", `/v1/payment_intents/${encodedId(paymentIntentId, "PaymentIntent")}/capture`, ref, body, idempotencyKey
    );
    if (response.status !== 200) return { ...response, data: null };
    try { return { ...response, data: parsePaymentIntent(response.data) }; }
    catch { throw new StripeTransportError("Stripe capture response contract failed after consequence", "may_have_been_sent"); }
  }

  private async request(
    method: StripeHttpRequest["method"], path: string, ref: string, body: string | null, idempotencyKey: string | null
  ): Promise<StripeApiResponse<unknown>> {
    let key: string;
    try { key = await this.credentials.resolve(ref); }
    catch (error) {
      if (error instanceof StripeCredentialError) throw error;
      throw new StripeCredentialError("Stripe credential resolution failed");
    }
    requireTestStripeKey(key);
    const response = await this.transport.send({
      method,
      url: `${STRIPE_API_ORIGIN}${path}`,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
        "Stripe-Version": STRIPE_API_VERSION,
        "User-Agent": "Nyst-Effect-Control/1.0",
        ...(body === null ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
        ...(idempotencyKey === null ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      body,
      timeout_ms: this.timeoutMs,
    });
    return { status: response.status, data: response.body, headers: safeHeaders(response.headers) };
  }
}

function form(values: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) params.set(key, value);
  return params.toString();
}
function encodedId(value: string, label: string): string {
  if (!OBJECT_ID.test(value) || value.includes("/")) throw new StripeContractError(`Invalid Stripe ${label} ID`);
  return encodeURIComponent(value);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StripeContractError(`Malformed Stripe ${label}`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 255): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n]/.test(value)) {
    throw new StripeContractError(`Malformed Stripe ${label}`);
  }
  return value;
}
function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new StripeContractError(`Malformed Stripe ${label}`);
  return value;
}
function metadata(value: unknown): Readonly<Record<string, string>> {
  const body = record(value ?? {}, "metadata");
  const entries = Object.entries(body);
  if (entries.length > 50) throw new StripeContractError("Stripe metadata exceeded the bounded limit");
  const out: Record<string, string> = {};
  for (const [key, item] of entries) out[text(key, "metadata key", 40)] = text(item, "metadata value", 500);
  return out;
}
function objectId(value: unknown, prefix: string, label: string): string {
  const result = text(value, label);
  if (!result.startsWith(`${prefix}_`) || !OBJECT_ID.test(result)) throw new StripeContractError(`Malformed Stripe ${label}`);
  return result;
}
function parseAccount(value: unknown): StripeAccount {
  const body = record(value, "Account");
  if (body.object !== "account") throw new StripeContractError("Stripe Account object type mismatch");
  return { id: objectId(body.id, "acct", "Account ID"), object: "account" };
}
function parsePaymentIntent(value: unknown): StripePaymentIntent {
  const body = record(value, "PaymentIntent");
  if (body.object !== "payment_intent" || typeof body.livemode !== "boolean") throw new StripeContractError("Stripe PaymentIntent identity/mode mismatch");
  const statuses = ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"];
  const status = text(body.status, "PaymentIntent status");
  if (!statuses.includes(status)) throw new StripeContractError("Unsupported Stripe PaymentIntent status");
  return {
    id: objectId(body.id, "pi", "PaymentIntent ID"), object: "payment_intent", livemode: body.livemode,
    amount: integer(body.amount, "PaymentIntent amount", 1), amount_received: integer(body.amount_received, "PaymentIntent amount_received"),
    amount_capturable: integer(body.amount_capturable, "PaymentIntent amount_capturable"), currency: currency(body.currency),
    status: status as StripePaymentIntent["status"], capture_method: text(body.capture_method, "PaymentIntent capture_method"),
    latest_charge: body.latest_charge === null ? null : objectId(body.latest_charge, "ch", "PaymentIntent latest_charge"),
    metadata: metadata(body.metadata),
  };
}
function parseCharge(value: unknown): StripeCharge {
  const body = record(value, "Charge");
  if (body.object !== "charge" || typeof body.livemode !== "boolean" || typeof body.paid !== "boolean" || typeof body.refunded !== "boolean") {
    throw new StripeContractError("Stripe Charge identity/mode mismatch");
  }
  return {
    id: objectId(body.id, "ch", "Charge ID"), object: "charge", livemode: body.livemode,
    amount: integer(body.amount, "Charge amount", 1), amount_refunded: integer(body.amount_refunded, "Charge amount_refunded"),
    currency: currency(body.currency), paid: body.paid, refunded: body.refunded,
    payment_intent: body.payment_intent === null ? null : objectId(body.payment_intent, "pi", "Charge PaymentIntent"),
  };
}
function parseRefund(value: unknown): StripeRefund {
  const body = record(value, "Refund");
  if (body.object !== "refund") throw new StripeContractError("Stripe Refund object type mismatch");
  const allowed: StripeRefundStatus[] = ["pending", "requires_action", "succeeded", "failed", "canceled"];
  const status = text(body.status, "Refund status") as StripeRefundStatus;
  if (!allowed.includes(status)) throw new StripeContractError("Unsupported Stripe Refund status");
  return {
    id: objectId(body.id, "re", "Refund ID"), object: "refund", amount: integer(body.amount, "Refund amount", 1),
    currency: currency(body.currency), status,
    payment_intent: body.payment_intent === null ? null : objectId(body.payment_intent, "pi", "Refund PaymentIntent"),
    charge: body.charge === null ? null : objectId(body.charge, "ch", "Refund Charge"), metadata: metadata(body.metadata),
  };
}
function parseRefundList(value: unknown): StripeRefund[] {
  const body = record(value, "Refund list");
  if (body.object !== "list" || body.has_more !== false || !Array.isArray(body.data) || body.data.length > 100) {
    throw new StripeContractError("Unsupported or unbounded Stripe Refund inventory");
  }
  return body.data.map(parseRefund);
}
function currency(value: unknown): string {
  const result = text(value, "currency", 3);
  if (!/^[a-z]{3}$/.test(result)) throw new StripeContractError("Malformed Stripe currency");
  return result;
}
function safeHeaders(headers: Readonly<Record<string, string>>): StripeSafeHeaders {
  const get = (name: string) => {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
    return value !== null && value.length <= 200 && !/[\r\n]/.test(value) ? value : null;
  };
  return { request_id: get("request-id"), retry_after: get("retry-after"), rate_limited_reason: get("stripe-rate-limited-reason") };
}
