/**
 * Phase 25 — the published SDK.
 *
 * `packages/sdk` is a standalone publishable package. It deliberately does not
 * import server code, because a consumer of `@nyst-ai/sdk` must not end up
 * depending on Fastify, `pg`, or anything else that lives behind the API.
 *
 * The price of that independence is duplication: the SDK declares the public
 * vocabulary itself. Duplication that nothing checks becomes drift, and drift
 * in THIS vocabulary is dangerous — an SDK that believes in a seventh effect
 * state, or that signs webhooks a byte differently, fails in ways a consumer
 * would experience as Nyst lying to them. So the duplication is checked here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { EFFECT_STATES as SERVER_EFFECT_STATES } from "../src/model/effectState.js";
import {
  PRIMARY_DIRECTIVES as SERVER_PRIMARY_DIRECTIVES,
  RETRY_DISPOSITIONS as SERVER_RETRY_DISPOSITIONS,
  CONTINUATION_DISPOSITIONS as SERVER_CONTINUATION_DISPOSITIONS,
  RECOVERY_DISPOSITIONS as SERVER_RECOVERY_DISPOSITIONS,
} from "../src/model/controlDecision.js";
import { signWebhook as serverSign, verifyWebhook as serverVerify } from "../src/product/controlPlane.js";

import {
  EFFECT_STATES, PRIMARY_DIRECTIVES, RETRY_DISPOSITIONS,
  CONTINUATION_DISPOSITIONS, RECOVERY_DISPOSITIONS,
  mayContinue, mayRetry, needsHuman,
  NystClient, NystApiError,
  signWebhook, verifyWebhook, WEBHOOK_TOLERANCE_MS,
} from "@nyst-ai/sdk";

// Tests run from the repository root (`npm test`), so the package is located
// relative to the working directory rather than to the compiled test file.
const packageRoot = resolve(process.cwd(), "packages/sdk");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
const rootManifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as Record<string, unknown>;
const sdkSources = ["src/index.ts", "src/client.ts", "src/types.ts", "src/webhook.ts"]
  .map((name) => [name, readFileSync(resolve(packageRoot, name), "utf8")] as const);

describe("Phase 25 — package identity", () => {
  it("the SDK is the publishable package and the server is not", () => {
    assert.equal(manifest.name, "@nyst-ai/sdk");
    // Version truth is asserted centrally in tests/v030ProductionPackaging.test.ts;
    // here we only require that the SDK and the server agree.
    assert.equal(manifest.version, rootManifest.version,
      "the SDK and the server must ship as the same release");
    assert.equal(manifest.private, false);
    assert.equal(rootManifest.private, true, "the server and dashboard must never be publishable");
    assert.notEqual(rootManifest.name, "@nyst-ai/sdk", "the root must not claim the SDK's published name");
  });

  it("ships types, an ESM entry point, and a files whitelist", () => {
    assert.equal(manifest.type, "module");
    assert.equal(manifest.types, "./dist/index.d.ts");
    assert.deepEqual(manifest.exports, {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./package.json": "./package.json",
    });
    // A whitelist, not an ignore list: anything not named here cannot escape.
    assert.deepEqual(manifest.files, ["dist", "examples", "README.md"]);
  });

  it("has no runtime dependencies", () => {
    // Every dependency of an SDK becomes a dependency of every consumer.
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.peerDependencies, undefined);
    assert.equal(manifest.optionalDependencies, undefined);
  });

  it("reaches into no server internals and no workspace-only paths", () => {
    let total = 0;
    for (const [name, source] of sdkSources) {
      // Real module specifiers only — imports and re-exports. Prose in a doc
      // comment that happens to contain the word "from" is not a dependency.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const imports = [...code.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s+"([^"]+)";/g)].map((match) => match[1]!);
      total += imports.length;
      for (const specifier of imports) {
        assert.ok(!specifier.includes(".."), `${name} escapes the package: ${specifier}`);
        assert.ok(!specifier.startsWith("@nyst-ai/"), `${name} depends on a sibling workspace: ${specifier}`);
        const bare = !specifier.startsWith(".");
        if (bare) {
          assert.ok(specifier.startsWith("node:"),
            `${name} imports a third-party package: ${specifier}. The SDK must have no runtime dependencies.`);
        }
      }
    }
    assert.ok(total >= 5, "the scanner found almost no module specifiers; it is probably broken");
  });

  it("contains nothing that looks like a credential", () => {
    for (const [name, source] of sdkSources) {
      for (const pattern of [
        /ghp_[A-Za-z0-9]{16,}/, /sk_live_[A-Za-z0-9]{8,}/, /sk_test_[A-Za-z0-9]{8,}/,
        /00[A-Za-z0-9_-]{35,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /nyst_[a-f0-9]{12}\./,
      ]) {
        assert.doesNotMatch(source, pattern, `${name} contains something credential-shaped`);
      }
    }
  });
});

describe("Phase 25 — the public vocabulary cannot drift from the server", () => {
  it("declares exactly the server's six effect states, in the same order", () => {
    assert.deepEqual([...EFFECT_STATES], [...SERVER_EFFECT_STATES]);
    assert.equal(EFFECT_STATES.length, 6, "the set is closed; there is no seventh state");
  });

  it("declares exactly the server's control-decision vocabulary", () => {
    assert.deepEqual([...PRIMARY_DIRECTIVES], [...SERVER_PRIMARY_DIRECTIVES]);
    assert.deepEqual([...RETRY_DISPOSITIONS], [...SERVER_RETRY_DISPOSITIONS]);
    assert.deepEqual([...CONTINUATION_DISPOSITIONS], [...SERVER_CONTINUATION_DISPOSITIONS]);
    assert.deepEqual([...RECOVERY_DISPOSITIONS], [...SERVER_RECOVERY_DISPOSITIONS]);
  });

  it("keeps EffectState and ControlDecision as two separate axes", () => {
    const source = sdkSources.find(([name]) => name === "src/types.ts")![1];
    // A single flattened enum would be the collapse this product exists to avoid.
    assert.doesNotMatch(source, /EFFECT_STATES\s*=\s*\[[^\]]*"continue"/s);
    assert.doesNotMatch(source, /PRIMARY_DIRECTIVES\s*=\s*\[[^\]]*"verified"/s);
  });

  it("exposes no force-continue and no way to overrule a decision", () => {
    for (const [name, source] of sdkSources) {
      // Strip comments: the prohibition is on the API surface, not on prose.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(code, /force[_ ]?continue/i, `${name} must not offer a force-continue`);
      assert.doesNotMatch(code, /\boverrule|override(Decision|Control|Safety)/i,
        `${name} must not offer a way to overrule a control decision`);
      // No local re-derivation of an EffectState from anything.
      assert.doesNotMatch(code, /effect_state\s*=\s*["']/, `${name} must not assign an effect state`);
    }
  });
});

describe("Phase 25 — the helpers read dispositions rather than guessing", () => {
  const decision = (over: Partial<Record<string, string>> = {}) => ({
    decision_version: 1, primary: "do_not_retry", retry: "forbidden", continuation: "allowed",
    recovery: "none", reason_code: "T", explanation: "T", policy_version: "v", spec_version: "v",
    ...over,
  } as Parameters<typeof mayContinue>[0] & Parameters<typeof mayRetry>[0] & Parameters<typeof needsHuman>[0]);

  it("satisfied_unattributed continues but never retries", () => {
    const control = decision();
    assert.equal(mayContinue(control), true);
    assert.equal(mayRetry(control), false);
    assert.equal(needsHuman(control), false);
  });

  it('treats retry "unknown" as a refusal, not as permission', () => {
    // The whole product thesis: absence of proof is not proof of absence.
    assert.equal(mayRetry(decision({ retry: "unknown" })), false);
  });

  it("treats conditional continuation as not-yet-allowed", () => {
    assert.equal(mayContinue(decision({ continuation: "conditional" })), false);
    assert.equal(mayContinue(decision({ continuation: "blocked" })), false);
  });

  it("routes both hold and escalate to a person", () => {
    assert.equal(needsHuman(decision({ primary: "hold" })), true);
    assert.equal(needsHuman(decision({ primary: "escalate" })), true);
    assert.equal(needsHuman(decision({ primary: "continue" })), false);
  });
});

describe("Phase 25 — webhook verification is byte-identical to the server's", () => {
  const secret = randomBytes(32).toString("hex");
  const timestamp = "2026-08-11T12:00:00.000Z";
  const now = Date.parse(timestamp);
  const body = JSON.stringify({ action_id: "a", resolution_version: 1 });

  it("produces the same signature the server produces", () => {
    assert.equal(signWebhook(secret, timestamp, body), serverSign(secret, timestamp, body));
    assert.equal(signWebhook(secret, timestamp, body, "evt-1"), serverSign(secret, timestamp, body, "evt-1"));
  });

  it("accepts what the server signed and the server accepts what it signed", () => {
    assert.equal(verifyWebhook(secret, timestamp, body, serverSign(secret, timestamp, body), now), true);
    assert.equal(serverVerify(secret, timestamp, body, signWebhook(secret, timestamp, body), now), true);
  });

  it("rejects a tampered body, a wrong secret, and a stale delivery", () => {
    const signature = signWebhook(secret, timestamp, body);
    assert.equal(verifyWebhook(secret, timestamp, `${body} `, signature, now), false);
    assert.equal(verifyWebhook(`${secret}0`, timestamp, body, signature, now), false);
    assert.equal(verifyWebhook(secret, timestamp, body, signature, now + WEBHOOK_TOLERANCE_MS + 1), false);
    assert.equal(verifyWebhook(secret, timestamp, body, signature, now - WEBHOOK_TOLERANCE_MS - 1), false);
    assert.equal(verifyWebhook(secret, "not-a-timestamp", body, signature, now), false);
  });

  it("rejects a truncated signature without throwing on the length mismatch", () => {
    const signature = signWebhook(secret, timestamp, body);
    assert.equal(verifyWebhook(secret, timestamp, body, signature.slice(0, -2), now), false);
    assert.equal(verifyWebhook(secret, timestamp, body, "", now), false);
  });
});

describe("Phase 25 — the client refuses unusable configuration", () => {
  it("requires an HTTP(S) base URL and an API key", () => {
    assert.throws(() => new NystClient({ baseUrl: "nyst.example.com", apiKey: "k" }), /HTTP\(S\)/);
    assert.throws(() => new NystClient({ baseUrl: "file:///etc/passwd", apiKey: "k" }), /HTTP\(S\)/);
    assert.throws(() => new NystClient({ baseUrl: "https://n.example.com", apiKey: "" }), /API key/);
  });

  it("rejects a malformed action ID before it reaches the wire", async () => {
    let called = false;
    const client = new NystClient({
      baseUrl: "https://n.example.com", apiKey: "k",
      fetch: (async () => { called = true; throw new Error("must not be reached"); }) as typeof globalThis.fetch,
    });
    for (const bad of ["../../admin", "not-a-uuid", "", "00000000-0000-4000-8000-00000000000"]) {
      await assert.rejects(async () => client.getAction(bad), /Invalid action ID/);
    }
    assert.equal(called, false, "a malformed ID must never produce a request");
  });

  it("sends the Nyst authorization scheme and refuses to follow redirects", async () => {
    let seen: RequestInit | undefined;
    let url = "";
    const client = new NystClient({
      baseUrl: "https://n.example.com", apiKey: "secret-key-value",
      fetch: (async (input: URL, init: RequestInit) => {
        url = String(input); seen = init;
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof globalThis.fetch,
    });
    await client.listActions({ limit: "1" });
    assert.equal(url, "https://n.example.com/v1/actions?limit=1");
    assert.equal((seen!.headers as Record<string, string>).Authorization, "Nyst secret-key-value");
    // Following a redirect would forward the API key to wherever it points.
    assert.equal(seen!.redirect, "error");
  });

  it("surfaces a refusal as NystApiError carrying the status and request id", async () => {
    const client = new NystClient({
      baseUrl: "https://n.example.com", apiKey: "k",
      fetch: (async () => new Response(JSON.stringify({ error: "scope_denied", request_id: "req-7" }),
        { status: 403, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch,
    });
    await assert.rejects(() => client.overview(), (error: unknown) => {
      assert.ok(error instanceof NystApiError);
      assert.equal(error.status, 403);
      assert.equal(error.requestId, "req-7");
      return true;
    });
  });
});
