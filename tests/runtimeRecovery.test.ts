import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { ProcessCrashError, type RuntimeFaultPoint } from "../src/runtime/provider.js";
import { NystRuntime } from "../src/runtime/nystRuntime.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { makeRuntimeHarness, runtimeInput } from "./runtimeHelpers.js";

function crashOnce(point: RuntimeFaultPoint) {
  let fired = false;
  return {
    fault_injector(at: RuntimeFaultPoint) {
      if (!fired && at === point) {
        fired = true;
        throw new ProcessCrashError(point);
      }
    },
  };
}

describe("Gate 2 crash/restart recovery", () => {
  const points: RuntimeFaultPoint[] = [
    "after_intent_persistence",
    "after_dispatch_plan_persistence",
    "after_dispatch_claim",
    "after_provider_mutation",
    "before_provider_response_delivery",
    "after_provider_response",
    "before_evidence_persistence",
    "after_evidence_persistence",
    "before_reconciliation",
    "after_state_derivation",
    "after_control_derivation",
    "before_resolution_signing",
    "after_resolution_signing",
    "before_resolution_persistence",
    "after_resolution_persistence",
  ];

  for (const point of points) {
    it(`recovers safely after ${point}`, async () => {
      const h = makeRuntimeHarness(crashOnce(point));
      const key = `crash:${point}`;
      await assert.rejects(
        () => h.runtime.commit(
          h.spec.effect_name,
          key,
          runtimeInput("response_lost_after_effect"),
          EMPTY_CONTEXT
        ),
        ProcessCrashError
      );
      const action = await h.store.actions.findByIdentity(h.spec.effect_name, key);
      assert.ok(action);

      const restarted = new NystRuntime(
        h.store,
        h.registry,
        [h.provider],
        h.signer,
        h.clock
      );
      const resolution = await restarted.recover(action!.action_id);
      assert.equal(verifyResolution(h.signer, resolution), true);
      assert.ok(["verified", "not_applied", "unprovable"].includes(resolution.effect.state));
      assert.ok(h.provider.mutationCount(key) <= 1);
      if (point === "after_dispatch_claim") {
        assert.equal(h.provider.mutationCount(key), 0);
        assert.equal(resolution.effect.state, "not_applied");
      }
    });
  }

  it("response lost after effect reconciles to verified without redispatch", async () => {
    const h = makeRuntimeHarness();
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "response-lost",
      runtimeInput("response_lost_after_effect"),
      EMPTY_CONTEXT
    );
    assert.equal(result.resolution.effect.state, "verified");
    assert.equal(result.resolution.control.retry, "forbidden");
    assert.equal(h.provider.mutationCount(result.action.business_key), 1);
    const recovered = await h.runtime.recover(result.action.action_id);
    assert.equal(recovered.effect.state, "verified");
    assert.equal(h.provider.mutationCount(result.action.business_key), 1);
  });

  it("provider throws after mutating; runtime reconciles external truth instead of false failure", async () => {
    const h = makeRuntimeHarness();
    const dispatch = h.provider.dispatch.bind(h.provider);
    h.provider.dispatch = async (action, plan, onMutation) => {
      await dispatch(action, plan, onMutation);
      throw new Error("adapter threw after provider mutation");
    };
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "throw-after-mutation",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    assert.equal(result.resolution.effect.state, "verified");
    assert.equal(result.resolution.control.retry, "forbidden");
    assert.equal(h.provider.mutationCount(result.action.business_key), 1);
  });

  it("temporary observation exception fails closed", async () => {
    const h = makeRuntimeHarness();
    h.provider.observe = async () => { throw new Error("provider read unavailable"); };
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "observe-throws",
      runtimeInput("response_lost_after_effect"),
      EMPTY_CONTEXT
    );
    assert.equal(result.resolution.effect.state, "unprovable");
    assert.equal(result.resolution.control.continuation, "blocked");
    assert.notEqual(result.resolution.control.retry, "allowed");
    assert.equal(h.provider.mutationCount(result.action.business_key), 1);
  });
});

describe("Gate 2 temporal reconciliation", () => {
  it("pending becomes verified through observation only", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "eventual",
      runtimeInput("eventual_consistency"),
      EMPTY_CONTEXT
    );
    assert.equal(first.resolution.effect.state, "pending");
    assert.ok(first.resolution.control.next_check_at);
    const second = await h.runtime.reconcile(first.action.action_id);
    assert.equal(second.effect.state, "pending");
    const third = await h.runtime.reconcile(first.action.action_id);
    assert.equal(third.effect.state, "verified");
    assert.equal(third.control.next_check_at, undefined);
    assert.equal(h.provider.mutationCount(first.action.business_key), 1);
    const latest = await h.store.resolutions.latestForAction(first.action.action_id);
    assert.equal(latest!.resolution_id, third.resolution_id);
    assert.ok(third.runtime!.resolution_sequence > first.resolution.runtime!.resolution_sequence);
  });

  it("unprovable can later resolve when provider state becomes available", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "read-unavailable",
      runtimeInput("provider_read_unavailable"),
      EMPTY_CONTEXT
    );
    assert.equal(first.resolution.effect.state, "unprovable");
    h.provider.setExternalPermission("repo_prod", "alice", "none", first.action.business_key);
    h.provider.setScenario(first.action.action_id, "definitely_applied");
    const later = await h.runtime.reconcile(first.action.action_id);
    assert.equal(later.effect.state, "verified");
    assert.equal(h.provider.mutationCount(first.action.business_key), 0);
    assert.equal(verifyResolution(h.signer, first.resolution), true);
    assert.equal(verifyResolution(h.signer, later), true);
  });

  it("reconciliation is idempotent and never dispatches", async () => {
    const h = makeRuntimeHarness();
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "reconcile-idempotent",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    const resolutions = await Promise.all(
      Array.from({ length: 10 }, () => h.runtime.reconcile(result.action.action_id))
    );
    assert.ok(resolutions.every((resolution) => resolution.effect.state === "verified"));
    assert.equal(h.provider.mutationCount(result.action.business_key), 1);
  });

  it("current resolution ordering follows logical sequence when wall clock moves backward", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "backward-clock",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    let tick = 0;
    h.clock.now = () => ({
      source: "local_system_clock",
      timestamp: new Date(Date.UTC(2025, 0, 1) - tick++ * 1000).toISOString(),
      trusted: false,
    });
    const later = await h.runtime.reconcile(first.action.action_id);
    assert.ok(later.trust.resolved_at < first.resolution.trust.resolved_at);
    assert.ok(later.runtime!.resolution_sequence > first.resolution.runtime!.resolution_sequence);
    assert.equal(
      (await h.store.resolutions.latestForAction(first.action.action_id))!.resolution_id,
      later.resolution_id
    );
  });
});
