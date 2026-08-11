import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyResolution } from "../src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import type { SignatureEnvelope, Signer } from "../src/core/signing.js";
import { OktaUserSuspensionService } from "../src/providers/okta/oktaService.js";
import { createOktaUserSuspensionSpec } from "../src/providers/okta/oktaSpec.js";
import { NystRuntime } from "../src/runtime/nystRuntime.js";
import { ProcessCrashError, type RuntimeFaultPoint } from "../src/runtime/provider.js";
import { EffectRegistry } from "../src/runtime/registry.js";
import { makeOktaHarness, oktaInput } from "./oktaHelpers.js";

describe("Gate 5 crash/restart and post-effect failures", () => {
  const points: RuntimeFaultPoint[] = [
    "after_intent_persistence", "after_dispatch_plan_persistence", "before_dispatch_claim", "after_dispatch_claim",
    "after_provider_mutation", "before_provider_response_delivery", "after_provider_response", "before_evidence_persistence",
    "after_evidence_persistence", "before_reconciliation", "after_state_derivation", "after_control_derivation",
    "before_resolution_signing", "after_resolution_signing", "before_resolution_persistence", "after_resolution_persistence",
  ];
  for (const point of points) {
    it(`recovers after ${point} without a duplicate lifecycle write`, async () => {
      let fired = false;
      const h = makeOktaHarness({ status: "ACTIVE" }, undefined, { fault_injector(at) {
        if (!fired && at === point) { fired = true; throw new ProcessCrashError(point); }
      }});
      await assert.rejects(() => h.service.commit(`crash:${point}`, oktaInput(), EMPTY_CONTEXT), ProcessCrashError);
      const action = await h.store.actions.findByIdentity(h.spec.effect_name, `crash:${point}`);
      assert.ok(action);
      const plan = action.dispatch_plan ? structuredClone(action.dispatch_plan) : null;
      const restarted = new NystRuntime(h.store, h.registry, [h.provider], h.signer, h.clock);
      const result = await restarted.recover(action.action_id);
      assert.equal(verifyResolution(h.signer, result), true);
      if (plan) assert.deepEqual((await h.store.actions.getAction(action.action_id))?.dispatch_plan, plan);
      assert.ok(h.transport.mutationCount <= 1);
      assert.notEqual(result.effect.state, "verified");
    });
  }

  it("DB evidence failure after effect recovers by read-back without redispatch", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const append = h.store.evidence.append.bind(h.store.evidence);
    let failed = false;
    h.store.evidence.append = async (record) => {
      if (!failed && h.transport.mutationCount === 1) { failed = true; throw new ProcessCrashError("db_after_effect"); }
      return append(record);
    };
    await assert.rejects(() => h.service.commit("db-after-effect", oktaInput(), EMPTY_CONTEXT), ProcessCrashError);
    const action = await h.store.actions.findByIdentity(h.spec.effect_name, "db-after-effect");
    assert.ok(action);
    const result = await new NystRuntime(h.store, h.registry, [h.provider], h.signer, h.clock).recover(action.action_id);
    assert.equal(result.effect.state, "satisfied_unattributed");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("signer failure after effect recovers with a valid signature and no redispatch", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const badSigner: Signer = { keyId: "bad", publicKeyB64: () => "none", sign(): SignatureEnvelope { throw new Error("signer failed"); }, verify: () => false };
    const failing = new NystRuntime(h.store, h.registry, [h.provider], badSigner, h.clock);
    await assert.rejects(() => new OktaUserSuspensionService(failing, h.client, h.clock).commit("signer", oktaInput(), EMPTY_CONTEXT), /signer failed/);
    const action = await h.store.actions.findByIdentity(h.spec.effect_name, "signer");
    assert.ok(action);
    const result = await new NystRuntime(h.store, h.registry, [h.provider], h.signer, h.clock).recover(action.action_id);
    assert.equal(verifyResolution(h.signer, result), true);
    assert.equal(h.transport.mutationCount, 1);
  });
});

describe("Gate 5 malicious EffectSpec, malformed provider, and integrity attacks", () => {
  it("malicious spec cannot promote an unattributed read or mutation response to verified", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const legitimate = createOktaUserSuspensionSpec();
    const malicious = {
      ...legitimate,
      assess(_action: Parameters<typeof legitimate.assess>[0], evidence: Parameters<typeof legitimate.assess>[1]) {
        return { proposed_state: "verified" as const, provider_object_refs: [], evidence_refs: evidence.map((e) => e.evidence_id), verification_methods: ["provider_read_back" as const], claimed_strength: "authoritative" as const, attribution_established: true };
      },
      decide() { return { decision_version: 1, primary: "continue" as const, retry: "allowed" as const, continuation: "allowed" as const, recovery: "none" as const, reason_code: "MALICIOUS", explanation: "bypass", policy_version: "evil", spec_version: legitimate.schema_version }; },
    };
    const registry = new EffectRegistry(); registry.register(malicious);
    const runtime = new NystRuntime(h.store, registry, [h.provider], h.signer, h.clock);
    const result = await new OktaUserSuspensionService(runtime, h.client, h.clock).commit("malicious", oktaInput(), EMPTY_CONTEXT);
    assert.notEqual(result.resolution.effect.state, "verified");
    assert.notEqual(result.resolution.control.retry, "allowed");
  });

  for (const malformed of ["invalid_json_shape", "missing_status"] as const) {
    it(`${malformed} provider response fails closed`, async () => {
      const h = makeOktaHarness({ status: "ACTIVE" });
      const first = await h.service.commit(`malformed:${malformed}`, oktaInput(), EMPTY_CONTEXT);
      h.transport.malformedUser = malformed;
      const result = await h.runtime.reconcile(first.action.action_id);
      assert.equal(result.effect.state, "unprovable");
      assert.equal(result.control.continuation, "blocked");
    });
  }

  it("wrong user identity and transitional status cannot retain continuation", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const first = await h.service.commit("identity-transition", oktaInput(), EMPTY_CONTEXT);
    h.transport.transitioningToStatus = "SUSPENDED";
    const result = await h.runtime.reconcile(first.action.action_id);
    assert.equal(result.effect.state, "unprovable");
    assert.equal(result.control.continuation, "blocked");
  });

  it("material resolution tampering invalidates the Okta receipt signature", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const { resolution } = await h.service.commit("signature", oktaInput(), EMPTY_CONTEXT);
    const mutations = [
      (x: typeof resolution) => { x.action_id = "00000000-0000-4000-8000-000000000000"; },
      (x: typeof resolution) => { x.input_hash = "sha256:" + "0".repeat(64); },
      (x: typeof resolution) => { x.effect.state = "verified"; },
      (x: typeof resolution) => { x.control.reason_code = "FORGED"; },
      (x: typeof resolution) => { x.effect.evidence_refs = []; },
      (x: typeof resolution) => { x.runtime!.evidence_sequence++; },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(resolution); mutate(copy); assert.equal(verifyResolution(h.signer, copy), false);
    }
  });

  it("restart remains pinned to Okta 1.0.0 after a newer registry version appears", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const first = await h.service.commit("version-pinned", oktaInput(), EMPTY_CONTEXT);
    h.registry.register({ ...h.spec, schema_version: "okta.user_suspension_change/2.0.0" });
    const result = await h.runtime.recover(first.action.action_id);
    assert.equal(result.control.spec_version, "okta.user_suspension_change/1.0.0");
    assert.equal(h.transport.mutationCount, 1);
  });
});

describe("Gate 5 deterministic property and stress model", () => {
  for (const seed of [5, 17, 42, 2026, 65537]) {
    it(`seed ${seed}: ambiguity, stale reads, and reconciliation never exceed one write`, async () => {
      let state = seed >>> 0;
      const next = () => (state = (state * 1664525 + 1013904223) >>> 0);
      for (let iteration = 0; iteration < 20; iteration++) {
        const h = makeOktaHarness({ status: "ACTIVE" });
        const mode = next() % 4;
        if (mode === 0) h.transport.responseLossAfterEffect = true;
        if (mode === 1) h.transport.postMutationReads = ["ACTIVE", "SUSPENDED"];
        if (mode === 2) h.transport.successfulResponseWithoutEffect = true;
        if (mode === 3) h.transport.failMayHaveBeenSentBeforeEffect = true;
        const result = await h.service.commit(`property:${seed}:${iteration}`, oktaInput(), EMPTY_CONTEXT);
        for (let i = 0; i < 3; i++) await h.runtime.reconcile(result.action.action_id);
        assert.ok(h.transport.mutationCount <= 1, `seed=${seed} iteration=${iteration}`);
        const latest = await h.store.resolutions.latestForAction(result.action.action_id);
        assert.notEqual(latest?.effect.state, "verified", `seed=${seed} iteration=${iteration}`);
        if (latest?.effect.state !== "satisfied_unattributed") assert.equal(latest?.control.continuation, "blocked");
      }
    });
  }

  it("repeats response-loss recovery 25 times with exactly one lifecycle write", async () => {
    for (let i = 0; i < 25; i++) {
      const h = makeOktaHarness({ status: "ACTIVE" }); h.transport.responseLossAfterEffect = true;
      const result = await h.service.commit(`stress-loss:${i}`, oktaInput(), EMPTY_CONTEXT);
      await Promise.all(Array.from({ length: 10 }, () => h.runtime.reconcile(result.action.action_id)));
      assert.equal(h.transport.mutationCount, 1, `iteration=${i}`);
    }
  });
});
