import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { FetchOktaTransport, OktaRestClient } from "../src/providers/okta/oktaClient.js";
import { EnvironmentOktaCredentialSource, OKTA_CREDENTIAL_REF, OktaContractError, OktaTransportError, type OktaHttpRequest, type OktaTransport } from "../src/providers/okta/types.js";
import { MutableClock } from "./githubHelpers.js";

const request = (method: "GET" | "POST"): OktaHttpRequest => ({
  method,
  url: "https://integrator-1234567.okta.com/api/v1/users/00u1234567890ABCDEF0" + (method === "POST" ? "/lifecycle/suspend" : ""),
  headers: { Authorization: "Bearer TEST" },
  body: null,
  timeout_ms: 1000,
});

describe("Gate 5 Okta fetch consequence-boundary classification", () => {
  it("malformed POST response is may-have-been-sent, never definitely-not-sent", async () => {
    const prior = globalThis.fetch;
    globalThis.fetch = async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(() => new FetchOktaTransport().send(request("POST")), (error: unknown) =>
        error instanceof OktaTransportError && error.send_certainty === "may_have_been_sent");
    } finally { globalThis.fetch = prior; }
  });

  it("oversized POST response is may-have-been-sent", async () => {
    const prior = globalThis.fetch;
    globalThis.fetch = async () => new Response("x".repeat(100), { status: 200, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(() => new FetchOktaTransport(10).send(request("POST")), (error: unknown) =>
        error instanceof OktaTransportError && error.send_certainty === "may_have_been_sent");
    } finally { globalThis.fetch = prior; }
  });

  it("malformed GET response remains a read-contract error, not effect truth", async () => {
    const prior = globalThis.fetch;
    globalThis.fetch = async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    try { await assert.rejects(() => new FetchOktaTransport().send(request("GET")), OktaContractError); }
    finally { globalThis.fetch = prior; }
  });
});

describe("Gate 5 Okta DPoP authorization", () => {
  it("binds each management request to method, URL, and access token with a signed proof", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateJwk = privateKey.export({ format: "jwk" });
    const prior = {
      token: process.env.NYST_OKTA_ACCESS_TOKEN,
      type: process.env.NYST_OKTA_TOKEN_TYPE,
      key: process.env.NYST_OKTA_DPOP_PRIVATE_JWK,
    };
    process.env.NYST_OKTA_ACCESS_TOKEN = "dpop-test-token";
    process.env.NYST_OKTA_TOKEN_TYPE = "DPoP";
    process.env.NYST_OKTA_DPOP_PRIVATE_JWK = JSON.stringify(privateJwk);
    const capture: { request?: OktaHttpRequest } = {};
    const transport: OktaTransport = { async send(value) { capture.request = value; return { status: 404, headers: {}, body: {} }; } };
    try {
      const client = new OktaRestClient(new EnvironmentOktaCredentialSource(), { clock: new MutableClock(), transport });
      await client.getUser("https://integrator-1234567.okta.com", "00u1234567890ABCDEF0", OKTA_CREDENTIAL_REF);
      const captured = capture.request;
      assert.ok(captured);
      assert.equal(captured.headers.Authorization, "DPoP dpop-test-token");
      const proof = captured.headers.DPoP;
      assert.ok(proof);
      const [headerPart, payloadPart, signaturePart] = proof.split(".");
      const header = JSON.parse(Buffer.from(headerPart!, "base64url").toString("utf8"));
      const payload = JSON.parse(Buffer.from(payloadPart!, "base64url").toString("utf8"));
      assert.deepEqual({ typ: header.typ, alg: header.alg }, { typ: "dpop+jwt", alg: "RS256" });
      assert.equal(header.jwk.d, undefined);
      assert.equal(payload.htm, "GET");
      assert.equal(payload.htu, captured.url);
      assert.equal(payload.ath, createHash("sha256").update("dpop-test-token", "ascii").digest("base64url"));
      assert.equal(verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey(privateKey), Buffer.from(signaturePart!, "base64url")), true);
    } finally {
      setEnv("NYST_OKTA_ACCESS_TOKEN", prior.token);
      setEnv("NYST_OKTA_TOKEN_TYPE", prior.type);
      setEnv("NYST_OKTA_DPOP_PRIVATE_JWK", prior.key);
    }
  });

  it("negotiates a nonce on a read and primes the next lifecycle request without a second POST", async () => {
    await withDpopEnvironment(async () => {
      const requests: OktaHttpRequest[] = [];
      const transport: OktaTransport = { async send(value) {
        requests.push(value);
        if (requests.length === 1) {
          return { status: 401, headers: { "dpop-nonce": "nonce-read", "www-authenticate": 'DPoP error="use_dpop_nonce"' }, body: null };
        }
        if (value.method === "GET") {
          assert.equal(proofPayload(value).nonce, "nonce-read");
          return { status: 200, headers: { "dpop-nonce": "nonce-write" }, body: oktaUserBody() };
        }
        assert.equal(value.method, "POST");
        assert.equal(proofPayload(value).nonce, "nonce-write");
        return { status: 200, headers: {}, body: null };
      } };
      const client = new OktaRestClient(new EnvironmentOktaCredentialSource(), { clock: new MutableClock(), transport });
      assert.equal((await client.getUser("https://integrator-1234567.okta.com", "00u1234567890ABCDEF0", OKTA_CREDENTIAL_REF)).status, 200);
      assert.equal((await client.suspendUser("https://integrator-1234567.okta.com", "00u1234567890ABCDEF0", OKTA_CREDENTIAL_REF)).status, 200);
      assert.equal(requests.filter(({ method }) => method === "GET").length, 2);
      assert.equal(requests.filter(({ method }) => method === "POST").length, 1);
    });
  });

  it("never automatically resends a lifecycle POST when the resource server challenges its nonce", async () => {
    await withDpopEnvironment(async () => {
      const requests: OktaHttpRequest[] = [];
      const transport: OktaTransport = { async send(value) {
        requests.push(value);
        return { status: 401, headers: { "dpop-nonce": "nonce-after-rejection", "www-authenticate": 'DPoP error="use_dpop_nonce"' }, body: null };
      } };
      const client = new OktaRestClient(new EnvironmentOktaCredentialSource(), { clock: new MutableClock(), transport });
      assert.equal((await client.suspendUser("https://integrator-1234567.okta.com", "00u1234567890ABCDEF0", OKTA_CREDENTIAL_REF)).status, 401);
      assert.equal(requests.length, 1);
    });
  });
});

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

async function withDpopEnvironment(run: () => Promise<void>): Promise<void> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const prior = {
    token: process.env.NYST_OKTA_ACCESS_TOKEN,
    type: process.env.NYST_OKTA_TOKEN_TYPE,
    key: process.env.NYST_OKTA_DPOP_PRIVATE_JWK,
  };
  process.env.NYST_OKTA_ACCESS_TOKEN = "dpop-test-token";
  process.env.NYST_OKTA_TOKEN_TYPE = "DPoP";
  process.env.NYST_OKTA_DPOP_PRIVATE_JWK = JSON.stringify(privateKey.export({ format: "jwk" }));
  try { await run(); }
  finally {
    setEnv("NYST_OKTA_ACCESS_TOKEN", prior.token);
    setEnv("NYST_OKTA_TOKEN_TYPE", prior.type);
    setEnv("NYST_OKTA_DPOP_PRIVATE_JWK", prior.key);
  }
}

function proofPayload(request: OktaHttpRequest): Record<string, unknown> {
  const proof = request.headers.DPoP;
  assert.ok(proof);
  return JSON.parse(Buffer.from(proof.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

function oktaUserBody(): Record<string, unknown> {
  return {
    id: "00u1234567890ABCDEF0", status: "ACTIVE", transitioningToStatus: null,
    lastUpdated: "2026-08-08T12:00:00.000Z", statusChanged: "2026-08-08T12:00:00.000Z",
    profile: { login: "fixture.user@example.test", email: "fixture.user@example.test" },
    credentials: { provider: { type: "OKTA", name: "OKTA" } },
  };
}
