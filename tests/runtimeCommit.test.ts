import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { InputCollisionError } from "../src/model/action.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { makeRuntimeHarness, runtimeInput } from "./runtimeHelpers.js";

describe("Gate 2 public commit and logical identity", () => {
  it("persists intent and DispatchPlan before one provider mutation", async () => {
    const h = makeRuntimeHarness();
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "offboard:alice:repo_prod",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    assert.equal(result.created, true);
    assert.ok(result.action.dispatch_plan);
    assert.equal(result.resolution.effect.state, "verified");
    assert.equal(h.provider.mutationCount(result.action.business_key), 1);
    assert.equal(verifyResolution(h.signer, result.resolution), true);
  });

  it("repeated identical commit retrieves the same action without redispatch", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "repeat:alice:repo_prod",
      runtimeInput("response_lost_after_effect"),
      EMPTY_CONTEXT
    );
    const second = await h.runtime.commit(
      h.spec.effect_name,
      "repeat:alice:repo_prod",
      runtimeInput("only_transport"),
      EMPTY_CONTEXT
    );
    assert.equal(second.created, false);
    assert.equal(second.action.action_id, first.action.action_id);
    assert.equal(second.resolution.effect.state, "verified");
    assert.equal(h.provider.mutationCount(first.action.business_key), 1);
  });

  it("material semantic input drift is a collision", async () => {
    const h = makeRuntimeHarness();
    const key = "collision:alice:repo_prod";
    await h.runtime.commit(h.spec.effect_name, key, runtimeInput("definitely_applied"), EMPTY_CONTEXT);
    await assert.rejects(
      () => h.runtime.commit(
        h.spec.effect_name,
        key,
        runtimeInput("definitely_applied", { desired_permission: "admin" }),
        EMPTY_CONTEXT
      ),
      InputCollisionError
    );
    assert.equal(h.provider.mutationCount(key), 1);
  });

  for (const callers of [2, 10, 100]) {
    it(`${callers} concurrent identical commits converge on one action and one mutation`, async () => {
      const h = makeRuntimeHarness();
      const key = `concurrent:${callers}:alice:repo_prod`;
      const results = await Promise.all(
        Array.from({ length: callers }, () =>
          h.runtime.commit(h.spec.effect_name, key, runtimeInput("definitely_applied"), EMPTY_CONTEXT)
        )
      );
      assert.equal(new Set(results.map((result) => result.action.action_id)).size, 1);
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(h.provider.mutationCount(key), 1);
    });
  }
});

describe("Gate 2 baseline effect states and controls", () => {
  const cases = [
    ["definitely_applied", "verified"],
    ["definitely_not_applied", "not_applied"],
    ["eventual_consistency", "pending"],
    ["goal_state_preexisting", "satisfied_unattributed"],
    ["only_transport", "unprovable"],
  ] as const;

  for (const [scenario, state] of cases) {
    it(`${scenario} -> ${state}`, async () => {
      const h = makeRuntimeHarness();
      const result = await h.runtime.commit(
        h.spec.effect_name,
        `state:${scenario}`,
        runtimeInput(scenario),
        EMPTY_CONTEXT
      );
      assert.equal(result.resolution.effect.state, state);
      if (state === "pending" || state === "unprovable") {
        assert.equal(result.resolution.control.continuation, "blocked");
        assert.notEqual(result.resolution.control.retry, "allowed");
      }
    });
  }

  it("wrong attributed permission can be compensated as a distinct mutation", async () => {
    const h = makeRuntimeHarness();
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "compensate:alice:repo_prod",
      runtimeInput("wrong_permission"),
      EMPTY_CONTEXT
    );
    assert.equal(result.resolution.effect.state, "unprovable");
    const compensated = await h.runtime.compensate(result.action.action_id);
    assert.equal(compensated.effect.state, "compensated");
    assert.equal(h.provider.mutationCount(result.action.business_key), 1);
    assert.equal(h.provider.compensationMutationCount(result.action.business_key), 1);
    await assert.rejects(() => h.runtime.compensate(result.action.action_id), /already attempted/);
  });
});
