import {
  OKTA_CREDENTIAL_REF,
  OktaContractError,
  OktaCredentialError,
  OktaTransportError,
  type OktaApiResponse,
  type OktaClientOptions,
  type OktaCredentialSource,
  type OktaHttpRequest,
  type OktaHttpResponse,
  type OktaSafeHeaders,
  type OktaTransport,
  type OktaUserIdentity,
} from "./types.js";
import { normalizeOktaOrigin } from "./oktaInput.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const USER_ID = /^[A-Za-z0-9]{10,64}$/;

export class FetchOktaTransport implements OktaTransport {
  constructor(private readonly maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES) {}
  async send(request: OktaHttpRequest): Promise<OktaHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout_ms);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        redirect: "error",
        signal: controller.signal,
      });
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > this.maxResponseBytes) {
        throw responseContractFailure(request, "Okta response exceeded the configured size limit");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxResponseBytes) {
        throw responseContractFailure(request, "Okta response exceeded the configured size limit");
      }
      let body: unknown = null;
      if (bytes.byteLength > 0) {
        try { body = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
        catch { throw responseContractFailure(request, "Okta returned malformed JSON"); }
      }
      const headers: Record<string, string> = {};
      for (const name of ["x-okta-request-id", "retry-after", "x-rate-limit-remaining", "x-rate-limit-reset", "dpop-nonce", "www-authenticate"]) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return { status: response.status, headers, body };
    } catch (error) {
      if (error instanceof OktaContractError || error instanceof OktaTransportError) throw error;
      throw new OktaTransportError("Okta transport failed", "may_have_been_sent");
    } finally { clearTimeout(timer); }
  }
}

export class OktaRestClient {
  private readonly transport: OktaTransport;
  private readonly timeoutMs: number;
  constructor(private readonly credentials: OktaCredentialSource, private readonly options: OktaClientOptions) {
    this.transport = options.transport ?? new FetchOktaTransport(options.max_response_bytes);
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  async getUser(origin: string, userId: string, credentialRef: string): Promise<OktaApiResponse<OktaUserIdentity>> {
    const response = await this.request(origin, "GET", `/api/v1/users/${this.userId(userId)}`, credentialRef);
    return { ...response, data: response.status === 200 ? parseUser(response.data) : null };
  }

  async listUserRoles(origin: string, userId: string, credentialRef: string): Promise<OktaApiResponse<unknown[]>> {
    const response = await this.request(origin, "GET", `/api/v1/users/${this.userId(userId)}/roles`, credentialRef);
    if (response.status !== 200) return { ...response, data: null };
    if (!Array.isArray(response.data) || response.data.length > 100) {
      throw new OktaContractError("Malformed Okta user role response");
    }
    return { ...response, data: response.data };
  }

  async suspendUser(origin: string, userId: string, credentialRef: string): Promise<OktaApiResponse<null>> {
    const response = await this.request(origin, "POST", `/api/v1/users/${this.userId(userId)}/lifecycle/suspend`, credentialRef);
    return { ...response, data: null };
  }

  async unsuspendUser(origin: string, userId: string, credentialRef: string): Promise<OktaApiResponse<null>> {
    const response = await this.request(origin, "POST", `/api/v1/users/${this.userId(userId)}/lifecycle/unsuspend`, credentialRef);
    return { ...response, data: null };
  }

  private async request(origin: string, method: OktaHttpRequest["method"], path: string, credentialRef: string): Promise<OktaApiResponse<unknown>> {
    const canonicalOrigin = normalizeOktaOrigin(origin);
    if (credentialRef !== OKTA_CREDENTIAL_REF) throw new OktaCredentialError("Unsupported Okta credential reference");
    const url = `${canonicalOrigin}${path}`;
    let authorizationHeaders: Readonly<Record<string, string>>;
    try {
      if (this.credentials.authorization_headers) {
        authorizationHeaders = await this.credentials.authorization_headers(credentialRef, { method, url });
      } else {
        const token = await this.credentials.resolve(credentialRef);
        if (!token || /[\r\n]/.test(token)) throw new OktaCredentialError("Okta credential is malformed");
        authorizationHeaders = { Authorization: `Bearer ${token}` };
      }
    }
    catch (error) {
      if (error instanceof OktaCredentialError) throw error;
      throw new OktaCredentialError("Okta credential resolution failed");
    }
    for (const [name, value] of Object.entries(authorizationHeaders)) {
      if (!name || !value || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        throw new OktaCredentialError("Okta authorization headers are malformed");
      }
    }
    const makeRequest = (headers: Readonly<Record<string, string>>): OktaHttpRequest => ({
      method,
      url,
      headers: {
        Accept: "application/json",
        ...headers,
        "Content-Type": "application/json",
        "User-Agent": "Nyst-Effect-Control/1.0",
      },
      body: null,
      timeout_ms: this.timeoutMs,
    });
    let response = await this.transport.send(makeRequest(authorizationHeaders));
    const challengeNonce = dpopChallengeNonce(response);
    if (challengeNonce !== null) {
      this.credentials.remember_dpop_nonce?.(url, challengeNonce);
      if (method === "GET" && this.credentials.authorization_headers) {
        authorizationHeaders = await this.credentials.authorization_headers(credentialRef, { method, url });
        response = await this.transport.send(makeRequest(authorizationHeaders));
      }
    }
    const nextNonce = header(response.headers, "dpop-nonce");
    if (nextNonce !== null) this.credentials.remember_dpop_nonce?.(url, nextNonce);
    return { status: response.status, data: response.body, headers: safeHeaders(response.headers) };
  }

  private userId(value: string): string {
    if (!USER_ID.test(value)) throw new OktaContractError("Invalid Okta user ID");
    return encodeURIComponent(value);
  }
}

function parseUser(value: unknown): OktaUserIdentity {
  const body = record(value, "user");
  const profile = record(body.profile, "user profile");
  const credentials = record(body.credentials, "user credentials");
  const provider = record(credentials.provider, "credential provider");
  const transitioning = body.transitioningToStatus;
  if (transitioning !== null && transitioning !== undefined && typeof transitioning !== "string") {
    throw new OktaContractError("Malformed Okta transitioning status");
  }
  const email = profile.email;
  if (email !== null && email !== undefined && typeof email !== "string") {
    throw new OktaContractError("Malformed Okta user email");
  }
  const statusChanged = body.statusChanged;
  if (statusChanged !== null && statusChanged !== undefined && typeof statusChanged !== "string") {
    throw new OktaContractError("Malformed Okta statusChanged");
  }
  return {
    id: text(body.id, "user ID", 64),
    status: text(body.status, "user status", 100),
    transitioning_to_status: transitioning ?? null,
    login: text(profile.login, "user login", 500),
    email: email ?? null,
    source_type: text(provider.type, "credential provider type", 100),
    last_updated: timestamp(body.lastUpdated, "lastUpdated"),
    status_changed: statusChanged === null || statusChanged === undefined ? null : timestamp(statusChanged, "statusChanged"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OktaContractError(`Malformed Okta ${label} response`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new OktaContractError(`Malformed Okta ${label}`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (Number.isNaN(Date.parse(result))) throw new OktaContractError(`Malformed Okta ${label}`);
  return new Date(result).toISOString();
}
function safeHeaders(headers: Readonly<Record<string, string>>): OktaSafeHeaders {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const get = (name: string) => lower.get(name) ?? null;
  return {
    request_id: get("x-okta-request-id"),
    retry_after: get("retry-after"),
    rate_limit_remaining: get("x-rate-limit-remaining"),
    rate_limit_reset: get("x-rate-limit-reset"),
  };
}

function dpopChallengeNonce(response: OktaHttpResponse): string | null {
  if (response.status !== 401) return null;
  const nonce = header(response.headers, "dpop-nonce");
  const authenticate = header(response.headers, "www-authenticate");
  if (nonce === null || authenticate === null || !/\bDPoP\b/i.test(authenticate) || !/\berror\s*=\s*"?use_dpop_nonce"?/i.test(authenticate)) {
    return null;
  }
  return nonce;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  if (!found || !found[1] || /[\r\n]/.test(found[1])) return null;
  return found[1];
}

function responseContractFailure(request: OktaHttpRequest, message: string): Error {
  // A POST has already crossed fetch's consequence boundary before response
  // bytes can be parsed or bounded. Never classify response corruption as
  // definitely-not-sent for a non-idempotent lifecycle operation.
  return request.method === "POST"
    ? new OktaTransportError(message, "may_have_been_sent")
    : new OktaContractError(message);
}
