import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, runScenario, sampleInput, uniqueKey } from "./helpers.js";
import { createFakeSpec, createRogueSpec, observeFakeProvider } from "../src/fake/fakeSpec.js";
import { applySafetyFloors } from "../src/engine/safetyFloors.js";
import { CONTROL_DECISION_VERSION, type ControlDecision } from "../src/model/controlDecision.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import type { EffectAssessment } from "../src/spec/effectSpec.js";

const permissive: ControlDecision = {
  decision_version: CONTROL_DECISION_VERSION,
  primary: "retry",
  retry: "allowed",
  continuation: "allowed",
  recovery: "none",
  reason_code: "TEST.PERMISSIVE",
  explanation: "spec attempting to allow everything",
  policy_version: "t/1",
  spec_version: "t/1",
};

describe("Test 15: missing evidence alone cannot produce not_applied", () => {
  it("no evidence at all resolves to unprovable, never not_applied", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "no_evidence");
    assert.equal(resolution.effect.state, "unprovable");
  });

  it("even a spec that CLAIMS not_applied without absence proof is clamped", () => {
    const spec = createFakeSpec();
    const assessment: EffectAssessment = {
      proposed_state: "not_applied",
      provider_object_refs: [],
      evidence_refs: [],
      verification_methods: ["none"],
      claimed_strength: "none",
      attribution_established: false,
    };
    const out = applySafetyFloors(spec, assessment, permissive, []);
    assert.equal(out.state, "unprovable");
    assert.ok(out.adjustments.includes("CORE.E2_ABSENCE_REQUIRES_AUTHORITATIVE_ABSENCE_ASSERTION"));
  });
});

describe("Test 16: transport ambiguity cannot produce automatic retry authorization", () => {
  it("timeout-only evidence yields retry != allowed and no primary=retry", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "transport_timeout");
    assert.notEqual(resolution.control.retry, "allowed");
    assert.notEqual(resolution.control.primary, "retry");
    // and, per invariant, a timeout is NOT proof of failure:
    assert.notEqual(resolution.effect.state, "not_applied");
  });
});

describe("Test 17: pending cannot silently authorize dependent continuation", () => {
  it("floors force continuation=blocked even when a spec proposes allowed", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("pend"), sampleInput(), EMPTY_CONTEXT);
    const a = await h.engine.markDispatched(h.spec, action);
    const evidence = await observeFakeProvider(h.store.evidence, h.clock, a, "eventually_consistent");

    const assessment: EffectAssessment = {
      proposed_state: "pending",
      provider_object_refs: [],
      evidence_refs: evidence.map((e) => e.evidence_id),
      verification_methods: ["response_inspection"],
      claimed_strength: "corroborative",
      attribution_established: false,
    };
    const out = applySafetyFloors(h.spec, assessment, permissive, evidence);
    assert.equal(out.state, "pending");
    assert.equal(out.decision.continuation, "blocked");
    assert.equal(out.decision.retry, "forbidden");
    assert.ok(out.adjustments.includes("CORE.C2_PENDING_BLOCKS_CONTINUATION"));
  });
});

describe("Test 18: unprovable cannot silently authorize dependent continuation", () => {
  it("floors force continuation=blocked and retry not allowed", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("unp"), sampleInput(), EMPTY_CONTEXT);
    const a = await h.engine.markDispatched(h.spec, action);
    const evidence = await observeFakeProvider(h.store.evidence, h.clock, a, "transport_timeout");

    const assessment: EffectAssessment = {
      proposed_state: "unprovable",
      provider_object_refs: [],
      evidence_refs: evidence.map((e) => e.evidence_id),
      verification_methods: ["response_inspection"],
      claimed_strength: "transport_only",
      attribution_established: false,
    };
    const out = applySafetyFloors(h.spec, assessment, permissive, evidence);
    assert.equal(out.state, "unprovable");
    assert.equal(out.decision.continuation, "blocked");
    assert.notEqual(out.decision.retry, "allowed");
  });
});

describe("Test 20: provider-specific policy cannot bypass core safety constraints", () => {
  it("rogue spec claiming verified off transport evidence is clamped end-to-end", async () => {
    const rogue = createRogueSpec();
    const h = makeHarness(rogue);
    const { resolution } = await runScenario(h, "transport_timeout");
    // Rogue proposed: verified + retry allowed + continuation allowed.
    assert.notEqual(resolution.effect.state, "verified");
    assert.equal(resolution.effect.state, "unprovable");
    assert.notEqual(resolution.control.retry, "allowed");
    assert.equal(resolution.control.continuation, "blocked");
    assert.match(resolution.control.explanation, /core safety adjusted/);
  });

  it("rogue spec with NO evidence cannot manufacture verified", async () => {
    const rogue = createRogueSpec();
    const h = makeHarness(rogue);
    const { resolution } = await runScenario(h, "no_evidence");
    assert.notEqual(resolution.effect.state, "verified");
    assert.notEqual(resolution.effect.state, "not_applied");
    assert.equal(resolution.control.continuation, "blocked");
  });

  it("retry stays forbidden for not_applied when a spec is NOT retry-safe", () => {
    const spec = { ...createFakeSpec(), retry_safe_when_not_applied: false };
    const assessment: EffectAssessment = {
      proposed_state: "not_applied",
      provider_object_refs: [],
      evidence_refs: [],
      verification_methods: ["absence_window_probe"],
      claimed_strength: "authoritative",
      attribution_established: true,
    };
    // Give it a real absence proof so the epistemic floor passes…
    const out = applySafetyFloors(spec, assessment, permissive, []);
    // …but with no cited evidence the state still degrades; either way retry must not survive.
    assert.notEqual(out.decision.retry, "allowed");
  });

  it("satisfied_unattributed continuation is clamped when goal state is NOT declared sufficient", async () => {
    const strictSpec = { ...createFakeSpec(), goal_state_sufficient_for_continuation: false };
    const h = makeHarness(strictSpec);
    const { resolution } = await runScenario(h, "goal_state_preexisting");
    assert.equal(resolution.effect.state, "satisfied_unattributed");
    assert.equal(resolution.control.retry, "forbidden");
    assert.notEqual(resolution.control.continuation, "allowed"); // conditional, not silently allowed
  });

  it("unsupported compensation directives and contradictory primary axes are clamped", () => {
    const spec = {
      ...createFakeSpec(),
      compensation: { supported: false, method: null, confirming_evidence: [] },
    };
    const assessment: EffectAssessment = {
      proposed_state: "unprovable",
      provider_object_refs: [],
      evidence_refs: [],
      verification_methods: [],
      claimed_strength: "none",
      attribution_established: false,
    };
    const out = applySafetyFloors(spec, assessment, {
      ...permissive,
      primary: "compensate",
      retry: "forbidden",
      continuation: "blocked",
      recovery: "compensate",
    }, []);
    assert.equal(out.decision.primary, "escalate");
    assert.equal(out.decision.recovery, "escalate");
    assert.ok(out.adjustments.includes("CORE.C7_UNSUPPORTED_COMPENSATION_REJECTED"));
  });

  it("compensation confirmation alone cannot erase the missing original-effect proof", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(
      h.spec,
      uniqueKey("comp-only"),
      sampleInput(),
      EMPTY_CONTEXT
    );
    const dispatched = await h.engine.markDispatched(h.spec, action);
    const evidence = await observeFakeProvider(
      h.store.evidence,
      h.clock,
      dispatched,
      "wrong_then_compensated"
    );
    const confirmation = evidence.find((item) => item.kind === "compensation_confirmation")!;
    const assessment: EffectAssessment = {
      proposed_state: "compensated",
      provider_object_refs: confirmation.provider_object_id ? [confirmation.provider_object_id] : [],
      evidence_refs: [confirmation.evidence_id],
      verification_methods: [confirmation.verification_method],
      claimed_strength: confirmation.strength,
      attribution_established: true,
    };
    const out = applySafetyFloors(h.spec, assessment, permissive, evidence);
    assert.equal(out.state, "unprovable");
    assert.equal(out.decision.continuation, "blocked");
  });
});
