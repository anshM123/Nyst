import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, sampleInput, uniqueKey } from "./helpers.js";
import { EMPTY_CONTEXT, type ActionContext } from "../src/model/metadata.js";
import { canonicalHash } from "../src/core/canonical.js";
import { EVIDENCE_SCHEMA_VERSION } from "../src/model/evidence.js";
import type { NewEvidence } from "../src/store/store.js";

function mkEvidence(h: ReturnType<typeof makeHarness>, action_id: string, i: number): NewEvidence {
  const now = h.clock.now();
  const payload = { i };
  return {
    action_id,
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    source: "fake.provider",
    verification_method: "response_inspection",
    kind: "provider_response",
    strength: "corroborative",
    observed_disposition: "indeterminate",
    attribution: "indeterminate",
    provider_object_id: null,
    provider_event_id: null,
    observed_at: now.timestamp,
    provider_timestamp: null,
    payload,
    correlation: { method: "outcome_action_id_header", value: action_id },
    signing: null,
    clock: now,
    supersedes_evidence_id: null,
  };
}

describe("Test 9: evidence appends in deterministic order", () => {
  it("assigns monotonic seq 1..N and lists in that order, even under concurrency", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("ev"), sampleInput(), EMPTY_CONTEXT);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => h.store.evidence.append(mkEvidence(h, action.action_id, i)))
    );
    const list = await h.store.evidence.listForAction(action.action_id);
    assert.deepEqual(list.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("payload_hash is computed by the ledger from the stored payload", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("hash"), sampleInput(), EMPTY_CONTEXT);
    const stored = await h.store.evidence.append(mkEvidence(h, action.action_id, 42));
    assert.equal(stored.payload_hash, canonicalHash(stored.payload));
    // Callers cannot supply a hash at all — the field is not part of NewEvidence,
    // so {payload: X, hash: hash(Y)} is unrepresentable at the ledger boundary.
    assert.equal("payload_hash" in mkEvidence(h, action.action_id, 1), false);
  });
});

describe("Test 10: existing evidence is not silently mutated", () => {
  it("ledger exposes no update/delete; records are frozen; corrections append with supersedes", async () => {
    const h = makeHarness();
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("immut"), sampleInput(), EMPTY_CONTEXT);
    const first = await h.store.evidence.append(mkEvidence(h, action.action_id, 1));

    // No mutation API exists on the ledger.
    const ledger = h.store.evidence as unknown as Record<string, unknown>;
    for (const forbidden of ["update", "delete", "remove", "rewrite", "set"]) {
      assert.equal(typeof ledger[forbidden], "undefined", `ledger must not expose ${forbidden}()`);
    }

    // Records are deep-frozen — in-place mutation throws or is ignored.
    assert.throws(() => {
      "use strict";
      (first as unknown as { strength: string }).strength = "authoritative";
    });
    const after = await h.store.evidence.listForAction(action.action_id);
    assert.equal(after[0]!.strength, "corroborative");

    // Correction path: append a new record referencing the old one; both remain.
    const correction = await h.store.evidence.append({
      ...mkEvidence(h, action.action_id, 2),
      supersedes_evidence_id: first.evidence_id,
    });
    const all = await h.store.evidence.listForAction(action.action_id);
    assert.equal(all.length, 2);
    assert.equal(all[1]!.evidence_id, correction.evidence_id);
    assert.equal(all[1]!.supersedes_evidence_id, first.evidence_id);
    assert.equal(all[0]!.evidence_id, first.evidence_id); // original untouched

    // Superseding a nonexistent record is rejected.
    await assert.rejects(() =>
      h.store.evidence.append({
        ...mkEvidence(h, action.action_id, 3),
        supersedes_evidence_id: "00000000-0000-4000-8000-00000000dead",
      })
    );
  });
});

describe("Test 11: Day-1 metadata round-trips", () => {
  it("value, workload/agent, model, credential ref, approval, clock all persist", async () => {
    const h = makeHarness();
    const context: ActionContext = {
      value_minor_units: 129900,
      value_currency: "USD",
      risk_magnitude: "high",
      workload_id: "billing-service",
      workload_version: "2.14.1",
      model_identity: "agent-model-x",
      model_config_hash: "sha256:" + "a".repeat(64),
      credential_ref: "vault://kv/providers/fake#key-7",
      approval: { required: true, fired: true, reference: "approval_evt_991" },
    };
    const { action } = await h.engine.beginAction(h.spec, uniqueKey("meta"), sampleInput(), context);
    const loaded = await h.store.actions.getAction(action.action_id);
    assert.deepEqual(loaded!.context, context);
    assert.equal(loaded!.created_clock.source, "local_system_clock");
    assert.equal(loaded!.created_clock.trusted, false);

    // Nullable AI metadata: ordinary software stores nulls, and that round-trips too.
    const plain = await h.engine.beginAction(h.spec, uniqueKey("meta-plain"), sampleInput(), EMPTY_CONTEXT);
    const loadedPlain = await h.store.actions.getAction(plain.action.action_id);
    assert.equal(loadedPlain!.context.model_identity, null);
    assert.equal(loadedPlain!.context.value_minor_units, null);
  });

  it("refuses obviously-raw credentials in metadata", async () => {
    const h = makeHarness();
    await assert.rejects(() =>
      h.engine.beginAction(h.spec, uniqueKey("cred"), sampleInput(), {
        ...EMPTY_CONTEXT,
        credential_ref: "sk_live_abc123SECRET",
      })
    );
  });
});
