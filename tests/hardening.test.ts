/**
 * Hardening-pass (v2) regression tests: the signed receipt is DERIVED FROM
 * EVIDENCE BY THE CORE — the spec's self-description of its own evidence is
 * untrusted input.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, runScenario, sampleInput, uniqueKey } from "./helpers.js";
import {
  createFakeSpec,
  createRogueAbsenceSpec,
  observeFakeProvider,
} from "../src/fake/fakeSpec.js";
import { applySafetyFloors } from "../src/engine/safetyFloors.js";
import { CONTROL_DECISION_VERSION, type ControlDecision } from "../src/model/controlDecision.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { Ed25519Signer } from "../src/core/signing.js";
import { verifyResolution } from "../src/engine/resolver.js";
import type { EffectAssessment, EffectSpec } from "../src/spec/effectSpec.js";

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

describe("V4: receipt strength is derived from cited evidence, never claimed", () => {
  it("a spec claiming 'authoritative' over corroborative citations is overruled", async () => {
    const h0 = makeHarness();
    const { action } = await h0.engine.beginAction(h0.spec, uniqueKey("v4"), sampleInput(), EMPTY_CONTEXT);
    const a = await h0.engine.markDispatched(h0.spec, action);
    const evidence = await observeFakeProvider(h0.store.evidence, h0.clock, a, "eventually_consistent");
    const corroborativeOnly = evidence.filter((e) => e.strength === "corroborative");

    const inflated: EffectAssessment = {
      proposed_state: "pending",
      provider_object_refs: [],
      evidence_refs: corroborativeOnly.map((e) => e.evidence_id),
      verification_methods: ["response_inspection"],
      claimed_strength: "authoritative", // lie
      attribution_established: false,
    };
    const out = applySafetyFloors(h0.spec, inflated, permissive, evidence);
    assert.equal(out.derived_strength, "corroborative");
    assert.ok(out.adjustments.includes("CORE.V4_STRENGTH_DERIVED_FROM_EVIDENCE"));
  });

  it("end-to-end: resolution.effect.evidence_strength equals what the ledger supports", async () => {
    // The honest spec claims corroborative for pending — derived agrees, and
    // the receipt reports the derived value.
    const h = makeHarness();
    const { resolution } = await runScenario(h, "eventually_consistent");
    assert.equal(resolution.effect.evidence_strength, "corroborative");
    const v = await runScenario(h, "happy_verified");
    assert.equal(v.resolution.effect.evidence_strength, "authoritative");
    const t = await runScenario(h, "transport_timeout");
    assert.equal(t.resolution.effect.evidence_strength, "transport_only");
    const n = await runScenario(h, "no_evidence");
    assert.equal(n.resolution.effect.evidence_strength, "none");
  });
});

describe("V1–V3: spec self-description is validated against the ledger", () => {
  function lyingSpec(): EffectSpec {
    const honest = createFakeSpec();
    return {
      ...honest,
      schema_version: "fake.repository_permission_change/lying-refs",
      assess(action, evidence): EffectAssessment {
        const real = honest.assess(action, evidence);
        return {
          ...real,
          evidence_refs: [...real.evidence_refs, "00000000-0000-4000-8000-00000000beef"],
          verification_methods: [...real.verification_methods, "manual_review"], // never used
          provider_object_refs: [...real.provider_object_refs, "obj_i_made_up"],
        };
      },
    };
  }

  it("nonexistent evidence ids, unused methods, unbacked provider refs never reach the receipt", async () => {
    const h = makeHarness(lyingSpec());
    const { resolution } = await runScenario(h, "happy_verified");
    assert.equal(resolution.effect.evidence_refs.includes("00000000-0000-4000-8000-00000000beef"), false);
    assert.equal(resolution.effect.verification_methods.includes("manual_review"), false);
    assert.equal(resolution.effect.provider_object_refs.includes("obj_i_made_up"), false);
    // …and every surviving ref actually exists in this action's ledger.
    const ledger = await h.store.evidence.listForAction(resolution.action_id);
    const ids = new Set(ledger.map((e) => e.evidence_id));
    for (const ref of resolution.effect.evidence_refs) assert.ok(ids.has(ref));
    const clamped = resolution.control.explanation;
    assert.match(clamped, /CORE\.V1_UNKNOWN_EVIDENCE_REF_DROPPED/);
    assert.match(clamped, /CORE\.V2_UNSUPPORTED_VERIFICATION_METHOD_DROPPED/);
    assert.match(clamped, /CORE\.V3_UNBACKED_PROVIDER_REF_DROPPED/);
    // The signature covers the SANITIZED description.
    assert.equal(verifyResolution(h.signer, resolution), true);
  });

  it("a verified claim resting ONLY on nonexistent refs collapses to unprovable", () => {
    const spec = createFakeSpec();
    const assessment: EffectAssessment = {
      proposed_state: "verified",
      provider_object_refs: ["obj_ghost"],
      evidence_refs: ["00000000-0000-4000-8000-00000000dead"],
      verification_methods: ["provider_read_back"],
      claimed_strength: "authoritative",
      attribution_established: true,
    };
    const out = applySafetyFloors(spec, assessment, permissive, [] /* empty ledger */);
    assert.equal(out.state, "unprovable");
    assert.equal(out.derived_strength, "none");
    assert.deepEqual(out.assessment.evidence_refs, []);
    assert.equal(out.decision.continuation, "blocked");
  });
});

describe("E2/E2b: negative claims require an explicit absence assertion", () => {
  it("rogue spec proposing not_applied while citing PRESENCE evidence is clamped", async () => {
    // The reviewer's exact attack: cite an authoritative provider read that
    // shows the effect EXISTS, propose not_applied, request retry.
    const h = makeHarness(createRogueAbsenceSpec());
    const { resolution } = await runScenario(h, "happy_verified");
    assert.notEqual(resolution.effect.state, "not_applied");
    assert.equal(resolution.effect.state, "unprovable");
    assert.notEqual(resolution.control.retry, "allowed");
    assert.match(resolution.control.explanation, /E2/);
  });

  it("an authoritative read WITHOUT an absence assertion cannot support not_applied", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("e2"), sampleInput(), EMPTY_CONTEXT);
    const a = await h.engine.markDispatched(h.spec, action);
    const evidence = await observeFakeProvider(h.store.evidence, h.clock, a, "wrong_permission_observed");
    // The read is authoritative + kind provider_read — the OLD floor would
    // have accepted it as "absence proof". Its disposition is indeterminate.
    const assessment: EffectAssessment = {
      proposed_state: "not_applied",
      provider_object_refs: [],
      evidence_refs: evidence.map((e) => e.evidence_id),
      verification_methods: ["provider_read_back"],
      claimed_strength: "authoritative",
      attribution_established: true,
    };
    const out = applySafetyFloors(h.spec, assessment, permissive, evidence);
    assert.equal(out.state, "unprovable");
    assert.ok(out.adjustments.includes("CORE.E2_ABSENCE_REQUIRES_AUTHORITATIVE_ABSENCE_ASSERTION"));
  });

  it("E2b: absence proof contradicted by active authoritative presence evidence degrades", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("e2b"), sampleInput(), EMPTY_CONTEXT);
    const a = await h.engine.markDispatched(h.spec, action);
    // Ledger contains BOTH an absence probe and an authoritative presence read.
    const absent = await observeFakeProvider(h.store.evidence, h.clock, a, "confirmed_absent");
    const present = await observeFakeProvider(h.store.evidence, h.clock, a, "happy_verified");
    const all = [...absent, ...present];
    const assessment: EffectAssessment = {
      proposed_state: "not_applied",
      provider_object_refs: [],
      evidence_refs: absent.map((e) => e.evidence_id), // cherry-picks the absence probe
      verification_methods: ["absence_window_probe"],
      claimed_strength: "authoritative",
      attribution_established: true,
    };
    const out = applySafetyFloors(h.spec, assessment, permissive, all);
    assert.equal(out.state, "unprovable");
    assert.ok(out.adjustments.includes("CORE.E2B_NOT_APPLIED_CONTRADICTED_BY_PRESENCE_EVIDENCE"));
    assert.notEqual(out.decision.retry, "allowed");
  });
});

describe("P0-4: execution identity is persisted before dispatch", () => {
  it("markDispatched durably stores the dispatch plan at `prepared`", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("plan"), sampleInput(), EMPTY_CONTEXT);
    assert.equal(action.dispatch_plan, null);
    const dispatched = await h.engine.markDispatched(h.spec, action);
    assert.ok(dispatched.dispatch_plan);
    assert.equal(dispatched.dispatch_plan!.correlation.value, action.action_id);
    assert.equal(dispatched.dispatch_plan!.idempotency_key, action.business_key);
    // Recovery reads it back from the store, not from recomputation.
    const reloaded = await h.store.actions.getAction(action.action_id);
    assert.deepEqual(reloaded!.dispatch_plan, dispatched.dispatch_plan);
  });

  it("entering `dispatching` without a persisted plan is refused", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("noplan"), sampleInput(), EMPTY_CONTEXT);
    await h.store.actions.transition(action.action_id, "intent_recorded", "prepared");
    await assert.rejects(
      () => h.store.actions.transition(action.action_id, "prepared", "dispatching"),
      /without a persisted dispatch plan/
    );
  });
});

describe("P2: key-id binding", () => {
  it("swapping only the claimed key_id invalidates verification", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "happy_verified");
    const swapped = {
      ...resolution,
      trust: {
        ...resolution.trust,
        signature: { ...resolution.trust.signature!, key_id: "impostor-key" },
      },
    };
    // Same public key, same signature bytes — only the claimed id changed.
    assert.equal(verifyResolution(h.signer, swapped), false);
    // Sanity: a verifier constructed FOR the impostor id also rejects it,
    // because the signature bytes bind to different key material.
    const impostor = Ed25519Signer.ephemeral("impostor-key");
    assert.equal(verifyResolution(impostor, swapped), false);
  });
});
