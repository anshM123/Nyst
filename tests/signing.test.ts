import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ed25519Signer } from "../src/core/signing.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { signablePortion, type OutcomeResolution } from "../src/model/resolution.js";
import { makeHarness, runScenario } from "./helpers.js";
import { makeRuntimeHarness, runtimeInput } from "./runtimeHelpers.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";

describe("Test 12: signed OutcomeResolution verifies", () => {
  it("engine-produced resolutions carry a valid Ed25519 signature", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "happy_verified");
    assert.ok(resolution.trust.signature);
    assert.equal(resolution.trust.signature!.algorithm, "ed25519");
    assert.equal(verifyResolution(h.signer, resolution), true);

    // A verify-only signer (public key only) can also verify.
    const verifier = Ed25519Signer.fromConfig({
      keyId: h.signer.keyId,
      publicKeyB64: h.signer.publicKeyB64(),
    });
    assert.equal(verifyResolution(verifier, resolution), true);
  });

  it("signature is stable across key re-ordering of the same content", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "happy_verified");
    const shuffled = JSON.parse(JSON.stringify(signablePortion(resolution))) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(shuffled).reverse());
    assert.equal(h.signer.verify(reordered, resolution.trust.signature!), true);
  });
});

describe("Test 13: mutating signed resolution data invalidates the signature", () => {
  const mutate = (r: OutcomeResolution, fn: (copy: OutcomeResolution) => void): OutcomeResolution => {
    const copy = JSON.parse(JSON.stringify(r)) as OutcomeResolution;
    fn(copy);
    return copy;
  };

  it("any tampering with effect state, control, context, or identity breaks verification", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "happy_verified");
    assert.equal(verifyResolution(h.signer, resolution), true);

    const tampered: OutcomeResolution[] = [
      mutate(resolution, (c) => { c.effect.state = "not_applied"; }),
      mutate(resolution, (c) => { c.control.retry = "allowed"; }),
      mutate(resolution, (c) => { c.control.continuation = "blocked"; }),
      mutate(resolution, (c) => { c.context.value_minor_units = 1; }),
      mutate(resolution, (c) => { c.business_key = "someone_elses_order"; }),
      mutate(resolution, (c) => { c.trust.resolved_at = "2031-01-01T00:00:00.000Z"; }),
      mutate(resolution, (c) => { c.effect.evidence_refs = []; }),
    ];
    for (const t of tampered) {
      assert.equal(verifyResolution(h.signer, t), false, "tampered resolution must not verify");
    }
  });

  it("a wrong key does not verify", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "happy_verified");
    const other = Ed25519Signer.ephemeral("other-key");
    assert.equal(verifyResolution(other, resolution), false);
  });

  it("Gate 2 receipt binds action, policy/spec versions, evidence, and logical sequence", async () => {
    const h = makeRuntimeHarness();
    const { resolution } = await h.runtime.commit(
      h.spec.effect_name,
      "signed-runtime",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    const changed: OutcomeResolution[] = [
      mutate(resolution, (copy) => { copy.action_id = "00000000-0000-4000-8000-000000000099"; }),
      mutate(resolution, (copy) => { copy.control.spec_version = "forged-spec/9"; }),
      mutate(resolution, (copy) => { copy.control.policy_version = "forged-policy/9"; }),
      mutate(resolution, (copy) => { copy.effect.evidence_refs = []; }),
      mutate(resolution, (copy) => { copy.runtime!.resolution_sequence += 1; }),
      mutate(resolution, (copy) => { copy.trust.clock.trusted = true; }),
    ];
    for (const copy of changed) assert.equal(verifyResolution(h.signer, copy), false);
  });
});
