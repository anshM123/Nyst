import type { ClockAttestor } from "../../core/clock.js";
import type { SendCertainty } from "../../runtime/provider.js";

export const OKTA_EFFECT_NAME = "okta.user_suspension_change";
export const OKTA_SPEC_VERSION = `${OKTA_EFFECT_NAME}/1.0.0`;
export const OKTA_API_VERSION = "v1";
export const OKTA_CREDENTIAL_REF = "env:NYST_OKTA_ACCESS_TOKEN";

export const OKTA_DESIRED_STATUSES = ["active", "suspended"] as const;
export type OktaDesiredStatus = (typeof OKTA_DESIRED_STATUSES)[number];
export type OktaOperation = "observe_only" | "suspend" | "unsuspend";

export const OKTA_DOCUMENTED_USER_STATUSES = [
  "STAGED", "PROVISIONED", "ACTIVE", "RECOVERY", "PASSWORD_EXPIRED",
  "LOCKED_OUT", "SUSPENDED", "DEPROVISIONED",
] as const;
export type OktaDocumentedUserStatus = (typeof OKTA_DOCUMENTED_USER_STATUSES)[number];

export interface OktaPublicSuspensionInput {
  org: string;
  user_id: string;
  desired_status: OktaDesiredStatus;
  credential_ref: typeof OKTA_CREDENTIAL_REF;
}

export interface OktaResolvedSuspensionInput {
  org_origin: string;
  tenant_host: string;
  user_id: string;
  desired_status: OktaDesiredStatus;
  operation: OktaOperation;
  preflight_status: string;
  preflight_login: string;
  user_source: "OKTA";
  no_admin_roles: true;
  credential_ref: typeof OKTA_CREDENTIAL_REF;
  consistency_deadline: string;
}

export interface OktaUserIdentity {
  id: string;
  status: string;
  transitioning_to_status: string | null;
  login: string;
  email: string | null;
  source_type: string;
  last_updated: string;
  status_changed: string | null;
}

export interface OktaSafeHeaders {
  request_id: string | null;
  retry_after: string | null;
  rate_limit_remaining: string | null;
  rate_limit_reset: string | null;
}

export interface OktaApiResponse<T> {
  status: number;
  data: T | null;
  headers: OktaSafeHeaders;
}

export interface OktaHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body: null;
  timeout_ms: number;
}

export interface OktaHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

export interface OktaTransport {
  send(request: OktaHttpRequest): Promise<OktaHttpResponse>;
}

export interface OktaCredentialSource {
  resolve(reference: string): Promise<string>;
  authorization_headers?(
    reference: string,
    request: Pick<OktaHttpRequest, "method" | "url">
  ): Promise<Readonly<Record<string, string>>>;
  remember_dpop_nonce?(url: string, nonce: string): void;
}

export class EnvironmentOktaCredentialSource implements OktaCredentialSource {
  private readonly dpopNonces = new Map<string, string>();
  async resolve(reference: string): Promise<string> {
    if (reference !== OKTA_CREDENTIAL_REF) throw new OktaCredentialError("Unsupported Okta credential reference");
    const token = process.env.NYST_OKTA_ACCESS_TOKEN;
    if (!token) throw new OktaCredentialError("Okta credential is unavailable");
    return token;
  }

  async authorization_headers(
    reference: string,
    request: Pick<OktaHttpRequest, "method" | "url">
  ): Promise<Readonly<Record<string, string>>> {
    const token = await this.resolve(reference);
    const tokenType = process.env.NYST_OKTA_TOKEN_TYPE ?? "Bearer";
    if (tokenType === "Bearer") return { Authorization: `Bearer ${token}` };
    if (tokenType !== "DPoP") throw new OktaCredentialError("Unsupported Okta token type");
    const privateJwk = process.env.NYST_OKTA_DPOP_PRIVATE_JWK;
    if (!privateJwk) throw new OktaCredentialError("Okta DPoP signing key is unavailable");
    const { createOktaDpopProof } = await import("./oktaDpop.js");
    const nonce = this.dpopNonces.get(new URL(request.url).origin);
    return {
      Authorization: `DPoP ${token}`,
      DPoP: createOktaDpopProof(privateJwk, request, token, undefined, nonce),
    };
  }

  remember_dpop_nonce(url: string, nonce: string): void {
    if (!nonce || /[\r\n]/.test(nonce)) throw new OktaCredentialError("Okta DPoP nonce is malformed");
    this.dpopNonces.set(new URL(url).origin, nonce);
  }
}

export class OktaCredentialError extends Error { override name = "OktaCredentialError"; }
export class OktaContractError extends Error { override name = "OktaContractError"; }
export class OktaPreconditionError extends Error { override name = "OktaPreconditionError"; }

export class OktaTransportError extends Error {
  override name = "OktaTransportError";
  constructor(message: string, public readonly send_certainty: SendCertainty) { super(message); }
}

export class OktaObservationError extends OktaPreconditionError {
  override name = "OktaObservationError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers: OktaSafeHeaders,
    public readonly category: "rate_limited" | "authentication_authorization_or_identity" | "provider_unavailable"
  ) { super(message); }
}

export interface OktaClientOptions {
  transport?: OktaTransport;
  timeout_ms?: number;
  max_response_bytes?: number;
  clock: ClockAttestor;
}

export function desiredProviderStatus(value: OktaDesiredStatus): "ACTIVE" | "SUSPENDED" {
  return value === "active" ? "ACTIVE" : "SUSPENDED";
}

export function isSupportedOktaStatus(value: string): value is "ACTIVE" | "SUSPENDED" {
  return value === "ACTIVE" || value === "SUSPENDED";
}
