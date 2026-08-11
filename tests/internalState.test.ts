import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INTERNAL_STATES,
  InternalStateSchema,
  assertTransition,
  legalNextStates,
  IllegalTransitionError,
} from "../src/model/internalState.js";
import { EFFECT_STATES, EffectStateSchema } from "../src/model/effectState.js";
import { makeHarness, runScenario, sampleInput, uniqueKey } from "./helpers.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";

describe("Test 21: internal processing state remains separate from external effect state", () => {
  it("the two enums are disjoint sets validated by different schemas", () => {
    for (const s of INTERNAL_STATES) {
      assert.equal((EFFECT_STATES as readonly string[]).includes(s), false);
      assert.throws(() => EffectStateSchema.parse(s));
    }
    for (const s of EFFECT_STATES) {
      assert.throws(() => InternalStateSchema.parse(s));
    }
  });

  it("a terminal resolution stores effect state on the resolution and lifecycle on the action", async () => {
    const h = makeHarness();
    const { action, resolution } = await runScenario(h, "happy_verified");
    const stored = await h.store.actions.getAction(action.action_id);
    assert.equal(stored!.internal_state, "resolved");        // lifecycle axis
    assert.equal(resolution.effect.state, "verified");        // epistemic axis
    assert.notEqual(stored!.internal_state as string, resolution.effect.state as string);
  });

  it("pending keeps the lifecycle open (back to observing), not resolved", async () => {
    const h = makeHarness();
    const { action, resolution } = await runScenario(h, "eventually_consistent");
    assert.equal(resolution.effect.state, "pending");
    const stored = await h.store.actions.getAction(action.action_id);
    assert.equal(stored!.internal_state, "observing");
  });
});

describe("Lifecycle transitions", () => {
  it("legal path intent_recorded -> prepared -> dispatching -> observing -> reconciling -> resolved", () => {
    const path = ["intent_recorded", "prepared", "dispatching", "observing", "reconciling", "resolved"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      assertTransition(path[i]!, path[i + 1]!);
    }
  });

  it("illegal jumps are rejected (incl. resolving without observing, abandoning after dispatch)", () => {
    assert.throws(() => assertTransition("intent_recorded", "resolved"), IllegalTransitionError);
    assert.throws(() => assertTransition("dispatching", "resolved"), IllegalTransitionError);
    assert.throws(() => assertTransition("dispatching", "abandoned_before_dispatch"), IllegalTransitionError);
    assert.throws(() => assertTransition("observing", "abandoned_before_dispatch"), IllegalTransitionError);
    assert.throws(() => assertTransition("resolved", "reconciling"), IllegalTransitionError);
    assert.deepEqual(legalNextStates("resolved"), []);
  });

  it("persist-intent-first: action exists in intent_recorded before any dispatch", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("intent"), sampleInput(), EMPTY_CONTEXT);
    assert.equal(action.internal_state, "intent_recorded");
    const found = await h.store.actions.findByIdentity(h.spec.effect_name, action.business_key);
    assert.ok(found);
  });

  it("a transport exception is an observation, never an effect-state claim", async () => {
    // markDispatched always lands in `observing` — for success AND failure —
    // and the resulting effect state for a bare timeout is unprovable.
    const h = makeHarness();
    const { resolution } = await runScenario(h, "transport_timeout");
    assert.notEqual(resolution.effect.state, "not_applied");
    assert.equal(resolution.effect.state, "unprovable");
  });

  it("resolution cannot skip the lifecycle from intent_recorded", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("skip"), sampleInput(), EMPTY_CONTEXT);
    await assert.rejects(() => h.engine.resolve(h.spec, action.action_id), /Cannot resolve/);
  });
});
