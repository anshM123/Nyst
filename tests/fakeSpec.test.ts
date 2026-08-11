import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, runScenario } from "./helpers.js";
import type { FakeScenario } from "../src/fake/fakeSpec.js";
import type { EffectState } from "../src/model/effectState.js";

describe("Test 14: fake EffectSpec legitimately produces all six states", () => {
  const cases: Array<[FakeScenario, EffectState]> = [
    ["happy_verified", "verified"],
    ["confirmed_absent", "not_applied"],
    ["eventually_consistent", "pending"],
    ["wrong_then_compensated", "compensated"],
    ["goal_state_preexisting", "satisfied_unattributed"],
    ["transport_timeout", "unprovable"],
  ];

  for (const [scenario, expected] of cases) {
    it(`${scenario} -> ${expected}`, async () => {
      const h = makeHarness();
      const { resolution } = await runScenario(h, scenario);
      assert.equal(resolution.effect.state, expected);
    });
  }

  it("all six states were exercised", async () => {
    const h = makeHarness();
    const seen = new Set<EffectState>();
    for (const [scenario] of cases) {
      const { resolution } = await runScenario(h, scenario);
      seen.add(resolution.effect.state);
    }
    assert.equal(seen.size, 6);
  });
});

describe("Control-decision examples per state (spec examples, not a global mapping)", () => {
  it("verified: continue / retry forbidden / continuation allowed", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "happy_verified");
    assert.equal(resolution.control.primary, "continue");
    assert.equal(resolution.control.retry, "forbidden");
    assert.equal(resolution.control.continuation, "allowed");
  });

  it("not_applied (retry-safe effect): retry / retry allowed / continuation blocked", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "confirmed_absent");
    assert.equal(resolution.effect.state, "not_applied");
    assert.equal(resolution.control.primary, "retry");
    assert.equal(resolution.control.retry, "allowed");
    assert.equal(resolution.control.continuation, "blocked");
  });

  it("pending: hold / retry forbidden / continuation blocked / next_check_at present", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "eventually_consistent");
    assert.equal(resolution.control.primary, "hold");
    assert.equal(resolution.control.retry, "forbidden");
    assert.equal(resolution.control.continuation, "blocked");
    assert.ok(resolution.control.next_check_at);
  });

  it("Test 19 — satisfied_unattributed: do_not_retry / retry FORBIDDEN / continuation ALLOWED", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "goal_state_preexisting");
    assert.equal(resolution.effect.state, "satisfied_unattributed");
    assert.equal(resolution.control.primary, "do_not_retry");
    assert.equal(resolution.control.retry, "forbidden");
    assert.equal(resolution.control.continuation, "allowed");
  });

  it("unprovable: escalate / retry not allowed / continuation blocked", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "transport_timeout");
    assert.equal(resolution.control.primary, "escalate");
    assert.notEqual(resolution.control.retry, "allowed");
    assert.equal(resolution.control.continuation, "blocked");
  });

  it("compensated: reasonable compensation policy (escalate for review, no retry)", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "wrong_then_compensated");
    assert.equal(resolution.effect.state, "compensated");
    assert.equal(resolution.control.retry, "forbidden");
    assert.equal(resolution.control.recovery, "escalate");
  });

  it("satisfied_unattributed is NOT treated the same as verified", async () => {
    const h = makeHarness();
    const v = await runScenario(h, "happy_verified");
    const s = await runScenario(h, "goal_state_preexisting");
    assert.notEqual(v.resolution.effect.state, s.resolution.effect.state);
    assert.notEqual(v.resolution.control.primary, s.resolution.control.primary);
    assert.equal(s.resolution.effect.evidence_strength, "authoritative");
  });

  it("provider object existing with WRONG parameters is not verified", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "wrong_permission_observed");
    assert.notEqual(resolution.effect.state, "verified");
    assert.equal(resolution.control.continuation, "blocked");
  });
});
