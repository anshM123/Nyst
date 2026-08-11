import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { OktaCredentialError, type OktaHttpRequest } from "./types.js";

interface RsaPrivateJwk {
  kty: "RSA";
  kid?: string;
  n: string;
  e: string;
  d: string;
  p: string;
  q: string;
  dp: string;
  dq: string;
  qi: string;
}

export function createOktaDpopProof(
  privateJwkJson: string,
  request: Pick<OktaHttpRequest, "method" | "url">,
  accessToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  nonce?: string,
): string {
  const jwk = parsePrivateRsaJwk(privateJwkJson);
  const target = new URL(request.url);
  target.hash = "";
  target.search = "";
  const publicJwk: Record<string, string> = { kty: "RSA", n: jwk.n, e: jwk.e };
  if (jwk.kid) publicJwk.kid = jwk.kid;
  const header = encodeJson({ typ: "dpop+jwt", alg: "RS256", jwk: publicJwk });
  const claims: Record<string, string | number> = {
    jti: randomUUID(),
    htm: request.method,
    htu: target.toString(),
    iat: nowSeconds,
    ath: base64url(createHash("sha256").update(accessToken, "ascii").digest()),
  };
  if (nonce !== undefined) {
    if (!nonce || /[\r\n]/.test(nonce)) throw new OktaCredentialError("Okta DPoP nonce is malformed");
    claims.nonce = nonce;
  }
  const payload = encodeJson(claims);
  const signingInput = `${header}.${payload}`;
  try {
    const key = createPrivateKey({ key: jwk, format: "jwk" });
    return `${signingInput}.${base64url(sign("RSA-SHA256", Buffer.from(signingInput), key))}`;
  } catch {
    throw new OktaCredentialError("Okta DPoP signing key is invalid");
  }
}

function parsePrivateRsaJwk(value: string): RsaPrivateJwk {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new OktaCredentialError("Okta DPoP signing key is malformed"); }
  if (!record(parsed) || parsed.kty !== "RSA") throw new OktaCredentialError("Okta DPoP signing key must be RSA");
  for (const field of ["n", "e", "d", "p", "q", "dp", "dq", "qi"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0 || /[\r\n]/.test(parsed[field])) {
      throw new OktaCredentialError("Okta DPoP signing key is incomplete");
    }
  }
  if (parsed.kid !== undefined && (typeof parsed.kid !== "string" || /[\r\n]/.test(parsed.kid))) {
    throw new OktaCredentialError("Okta DPoP signing key identifier is malformed");
  }
  return parsed as unknown as RsaPrivateJwk;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function encodeJson(value: unknown): string { return base64url(Buffer.from(JSON.stringify(value))); }
function base64url(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
