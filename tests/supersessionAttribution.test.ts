/**
 * v3 hardening regressions:
 *  - superseded evidence remains audit history but provides NO epistemic
 *    support for a current truth claim (V1b);
 *  - attribution is derived from normalized evidence, never from the spec's
 *    `attribution_established` boolean (E1/E1b).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, runScenario, sampleInput, uniqueKey } from "./helpers.js";
import { createFakeSpec, observeFakeProvider } from "../src/fake/fakeSpec.js";
import { applySafetyFloors } from "../src/engine/safetyFloors.js";
import { CONTROL_DECISION_VERSION, type ControlDecision } from "../src/model/controlDecision.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import type { EffectAssessment, EffectSpec } from "../src/spec/effectSpec.js";
import type { EvidenceRecord } from "../src/model/evidence.js";

const permissive: ControlDecision = {
  decision_version: CONTROL_DECISION_VERSION,
  primary: "continue",
  retry: "forbidden",
  continuation: "allowed",
  recovery: "none",
  reason_code: "TEST.PERMISSIVE",
  explanation: "test decision",
  policy_version: "t/1",
  spec_version: "t/1",
};

async function supersede(h: ReturnType<typeof makeHarness>, target: EvidenceRecord, patch: Partial<EvidenceRecord>) {
  const { evidence_id: _e, seq: _s, payload_hash: _h, ...rest } = target;
  return h.store.evidence.append({
    ...rest,
    ...patch,
    supersedes_evidence_id: target.evidence_id,
  } as Parameters<typeof h.store.evidence.append>[0]);
}

describe("V1b: superseded evidence cannot support a current truth claim", () => {
  it("authoritative effect_present A, superseded by correction B -> citing A cannot yield verified", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("sup-v"), sampleInput(), EMPTY_CONTEXT);
    const a = await h.engine.markDispatched(h.spec, action);
    const evidence = await observeFakeProvider(h.store.evidence, h.clock, a, "happy_verified");
    const A = evidence.find((e) => e.strength === "authoritative")!;

    // B corrects A: the earlier read was wrong; the object is NOT present.
    const B = await supersede(h, A, {
      observed_disposition: "effect_absent",
      payload: { correction: true, object: null, note: "earlier read-back was erroneous" },
    });
    const all = await h.store.evidence.listForAction(action.action_id);

    // The spec cherry-picks the superseded A to claim verified.
    const assessment: EffectAssessment = {
      proposed_state: "verified",
      provider_object_refs: A.provider_object_id ? [A.provider_object_id] : [],
      evidence_refs: [A.evidence_id],
      verification_methods: ["provider_read_back"],
      claimed_strength: "authoritative",
      attribution_established: true,
    };
    const out = applySafetyFloors(h.spec, assessment, permissive, all);

    assert.ok(out.adjustments.includes("CORE.V1B_SUPERSEDED_EVIDENCE_REF_DROPPED"));
    assert.equal(out.assessment.evidence_refs.includes(A.evidence_id), false);
    assert.notEqual(out.state, "verified");
    assert.equal(out.state, "unprovable"); // nothing valid remained cited
    assert.equal(out.derived_strength, "none"); // A contributes NO strength
    assert.equal(out.decision.continuation, "blocked");
    void B;
  });

  it("obsolete effect_absent evidence, once superseded, cannot support not_applied", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("sup-na"), sampleInput(), EMPTY_CONTEXT);
    const a = await h.engine.markDispatched(h.spec, action);
    const evidence = await observeFakeProvider(h.store.evidence, h.clock, a, "confirmed_absent");
    const probe = evidence.find((e) => e.kind === "absence_probe")!;

    // A later probe supersedes it: the effect HAS since appeared.
    await supersede(h, probe, {
      observed_disposition: "effect_present",
      payload: { probe: "read_repository_permission", matches: 1, consistency_window_elapsed: true },
    });
    const all = await h.store.evidence.listForAction(action.action_id);

    const assessment: EffectAssessment = {
      proposed_state: "not_applied",
      provider_object_refs: [],
      evidence_refs: [probe.evidence_id], // cites the OBSOLETE absence proof
      verification_methods: ["absence_window_probe"],
      claimed_strength: "authoritative",
      attribution_established: true,
    };
    const out = applySafetyFloors(h.spec, assessment, permissive, all);
    assert.notEqual(out.state, "not_applied");
    assert.equal(out.state, "unprovable");
    assert.ok(out.adjustments.includes("CORE.V1B_SUPERSEDED_EVIDENCE_REF_DROPPED"));
    assert.notEqual(out.decision.retry, "allowed");
  });

  it("supersession does not erase history: both records remain in the ledger", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("sup-hist"), sampleInput(), EMPTY_CONTEXT);
    const a = await h.engine.markDispatched(h.spec, action);
    const evidence = await observeFakeProvider(h.store.evidence, h.clock, a, "happy_verified");
    const A = evidence.find((e) => e.strength === "authoritative")!;
    await supersede(h, A, { observed_disposition: "effect_absent", payload: { correction: true } });
    const all = await h.store.evidence.listForAction(action.action_id);
    assert.ok(all.some((e) => e.evidence_id === A.evidence_id)); // audit history intact
    assert.ok(all.some((e) => e.supersedes_evidence_id === A.evidence_id));
  });

  it("superseded substantive history cannot defeat the current transport-only ambiguity floor", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(
      h.spec,
      uniqueKey("sup-transport"),
      sampleInput(),
      EMPTY_CONTEXT
    );
    const dispatched = await h.engine.markDispatched(h.spec, action);
    const evidence = await observeFakeProvider(
      h.store.evidence,
      h.clock,
      dispatched,
      "happy_verified"
    );
    const substantives = evidence.filter((e) => e.strength !== "transport_only");

    for (const substantive of substantives) {
      await supersede(h, substantive, {
        kind: "transport_error",
        strength: "transport_only",
        verification_method: "none",
        observed_disposition: "indeterminate",
        attribution: "indeterminate",
        provider_object_id: null,
        payload: { error: "correction: observation was invalid; transport remains ambiguous" },
      });
    }
    const all = await h.store.evidence.listForAction(action.action_id);

    const assessment: EffectAssessment = {
      proposed_state: "unprovable",
      provider_object_refs: [],
      evidence_refs: all
        .filter((e) => e.strength === "transport_only")
        .map((e) => e.evidence_id),
      verification_methods: ["none"],
      claimed_strength: "transport_only",
      attribution_established: false,
    };
    const unsafeRetry: ControlDecision = {
      ...permissive,
      primary: "retry",
      retry: "allowed",
    };
    const out = applySafetyFloors(h.spec, assessment, unsafeRetry, all);

    for (const substantive of substantives) {
      assert.equal(all.some((e) => e.evidence_id === substantive.evidence_id), true);
    }
    assert.equal(out.state, "unprovable");
    assert.equal(out.decision.retry, "forbidden");
    assert.notEqual(out.decision.primary, "retry");
    assert.ok(out.adjustments.includes("CORE.C6_TRANSPORT_AMBIGUITY_BLOCKS_RETRY"));
  });
});

describe("E1/E1b: attribution must be evidenced, not asserted", () => {
  function attributionLiar(): EffectSpec {
    const honest = createFakeSpec();
    return {
      ...honest,
      schema_version: "fake.repository_permission_change/attribution-liar",
      assess(action, evidence): EffectAssessment {
        const real = honest.assess(action, evidence);
        // The lie: proposes verified and simply ASSERTS attribution over
        // evidence whose normalized attribution is `unattributed`.
        return { ...real, proposed_state: "verified", attribution_established: true };
      },
    };
  }

  it("spec asserting attribution_established over unattributed presence gets satisfied_unattributed, not verified", async () => {
    const h = makeHarness(attributionLiar());
    const { resolution } = await runScenario(h, "goal_state_preexisting");
    assert.notEqual(resolution.effect.state, "verified");
    assert.equal(resolution.effect.state, "satisfied_unattributed");
    assert.match(resolution.control.explanation, /E1B_UNATTRIBUTED_PRESENCE_DEGRADES_TO_SATISFIED/);
    // And the C4 floor consequences hold on the degraded state:
    assert.equal(resolution.control.retry, "forbidden");
  });

  it("verified survives only when a cited record is authoritative + effect_present + attributed", async () => {
    const h = makeHarness();
    const { resolution } = await runScenario(h, "happy_verified");
    assert.equal(resolution.effect.state, "verified");
    const ledger = await h.store.evidence.listForAction(resolution.action_id);
    const supporting = ledger.filter((e) => resolution.effect.evidence_refs.includes(e.evidence_id));
    assert.ok(
      supporting.some(
        (e) =>
          e.strength === "authoritative" &&
          e.observed_disposition === "effect_present" &&
          e.attribution === "attributed"
      )
    );
  });

  it("asserted attribution over NO presence evidence collapses to unprovable", async () => {
    const h = makeHarness(attributionLiar());
    const { resolution } = await runScenario(h, "transport_timeout");
    assert.equal(resolution.effect.state, "unprovable");
    assert.equal(resolution.control.continuation, "blocked");
  });
});
