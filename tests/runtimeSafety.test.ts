import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { EVIDENCE_SCHEMA_VERSION } from "../src/model/evidence.js";
import { createFakeSpec } from "../src/fake/fakeSpec.js";
import { NystRuntime, StaleDecisionError } from "../src/runtime/nystRuntime.js";
import { EffectRegistry, MissingEffectSpecError } from "../src/runtime/registry.js";
import type { EffectSpec } from "../src/spec/effectSpec.js";
import { makeRuntimeHarness, runtimeInput } from "./runtimeHelpers.js";

describe("Gate 2 retry and continuation gates", () => {
  it("definitely-not-sent permits one controlled retry with the same DispatchPlan", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "not-sent-retry",
      runtimeInput("definitely_not_sent"),
      EMPTY_CONTEXT
    );
    assert.equal(first.resolution.effect.state, "not_applied");
    assert.equal(first.resolution.control.retry, "allowed");
    const plan = first.action.dispatch_plan;
    const second = await h.runtime.retry(first.action.action_id, first.resolution.resolution_id);
    assert.equal(h.provider.mutationCount(first.action.business_key), 0);
    assert.deepEqual((await h.store.actions.getAction(first.action.action_id))!.dispatch_plan, plan);
    assert.equal(second.control.retry, "forbidden");
    await assert.rejects(
      () => h.runtime.retry(first.action.action_id, second.resolution_id),
      /does not authorize retry|budget exhausted/
    );
  });

  it("definitely-not-sent does not falsely assert that a preexisting goal is absent", async () => {
    const h = makeRuntimeHarness();
    h.provider.setExternalPermission("repo_prod", "alice", "none", null);
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "not-sent-preexisting-goal",
      runtimeInput("definitely_not_sent"),
      EMPTY_CONTEXT
    );
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    assert.equal(result.resolution.control.retry, "forbidden");
    assert.equal(h.provider.mutationCount(result.action.business_key), 0);
  });

  it("new effect-present evidence invalidates a stale retry decision before dispatch", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "stale-retry",
      runtimeInput("definitely_not_sent"),
      EMPTY_CONTEXT
    );
    h.provider.setExternalPermission("repo_prod", "alice", "none", first.action.business_key);
    h.provider.setScenario(first.action.action_id, "definitely_applied");
    const evidence = await h.store.evidence.listForAction(first.action.action_id);
    const absence = evidence.find(
      (item) => item.strength === "authoritative" && item.observed_disposition === "effect_absent"
    )!;
    const observed = await h.provider.observe(first.action, first.action.dispatch_plan!);
    await h.store.evidence.append({
      ...observed[0]!,
      supersedes_evidence_id: absence.evidence_id,
    });
    assert.equal(
      (await h.store.runtime.get(first.action.action_id))!.evidence_sequence,
      (await h.store.evidence.listForAction(first.action.action_id)).at(-1)!.seq
    );
    await assert.rejects(
      () => h.runtime.retry(first.action.action_id, first.resolution.resolution_id),
      StaleDecisionError
    );
    const latest = await h.store.resolutions.latestForAction(first.action.action_id);
    assert.equal(latest!.effect.state, "verified");
    assert.equal(h.provider.mutationCount(first.action.business_key), 0);
  });

  it("atomic retry claim closes the evidence-arrival TOCTOU window", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "retry-toctou",
      runtimeInput("definitely_not_sent"),
      EMPTY_CONTEXT
    );
    const priorEvidence = await h.store.evidence.listForAction(first.action.action_id);
    const absence = priorEvidence.find(
      (item) => item.strength === "authoritative" && item.observed_disposition === "effect_absent"
    )!;
    let injected = false;
    const racing = new NystRuntime(
      h.store,
      h.registry,
      [h.provider],
      h.signer,
      h.clock,
      {
        async fault_injector(point, action) {
          if (point !== "before_dispatch_claim" || injected) return;
          injected = true;
          h.provider.setExternalPermission("repo_prod", "alice", "none", first.action.business_key);
          h.provider.setScenario(first.action.action_id, "definitely_applied");
          const observed = await h.provider.observe(action, action.dispatch_plan!);
          await h.store.evidence.append({
            ...observed[0]!,
            supersedes_evidence_id: absence.evidence_id,
          });
        },
      }
    );
    await assert.rejects(
      () => racing.retry(first.action.action_id, first.resolution.resolution_id),
      StaleDecisionError
    );
    assert.equal(h.provider.mutationCount(first.action.business_key), 0);
  });

  it("stale continuation is rejected after material evidence arrives", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "stale-continuation",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    await h.runtime.authorizeContinuation(first.action.action_id, first.resolution.resolution_id);
    const now = h.clock.now();
    await h.store.evidence.append({
      action_id: first.action.action_id,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: "test.adversary",
      verification_method: "absence_window_probe",
      kind: "absence_probe",
      strength: "authoritative",
      observed_disposition: "effect_absent",
      attribution: "indeterminate",
      provider_object_id: null,
      provider_event_id: "stale-continuation:absence",
      observed_at: now.timestamp,
      provider_timestamp: null,
      payload: { matches: 0, consistency_window_elapsed: true },
      correlation: { method: "test", value: first.action.action_id },
      signing: null,
      clock: now,
      supersedes_evidence_id: null,
    });
    await assert.rejects(
      () => h.runtime.authorizeContinuation(first.action.action_id, first.resolution.resolution_id),
      StaleDecisionError
    );
  });

  it("satisfied_unattributed allows only the explicitly configured continuation", async () => {
    const h = makeRuntimeHarness();
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "preexisting",
      runtimeInput("goal_state_preexisting"),
      EMPTY_CONTEXT
    );
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    assert.equal(result.resolution.control.retry, "forbidden");
    await h.runtime.authorizeContinuation(result.action.action_id, result.resolution.resolution_id);
    await assert.rejects(
      () => h.runtime.retry(result.action.action_id, result.resolution.resolution_id),
      /does not authorize retry/
    );
  });
});

describe("Gate 2 evidence ordering, contradiction, and deduplication", () => {
  it("duplicate provider observations do not duplicate evidence or strengthen truth", async () => {
    const h = makeRuntimeHarness();
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "dedup-evidence",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    const before = await h.store.evidence.listForAction(result.action.action_id);
    await h.runtime.reconcile(result.action.action_id);
    await h.runtime.reconcile(result.action.action_id);
    const after = await h.store.evidence.listForAction(result.action.action_id);
    assert.equal(after.length, before.length);
    assert.equal((await h.store.resolutions.latestForAction(result.action.action_id))!.effect.state, "verified");
  });

  it("contradictory active authoritative presence and absence fail closed", async () => {
    const h = makeRuntimeHarness();
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "contradiction",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    const now = h.clock.now();
    await h.store.evidence.append({
      action_id: result.action.action_id,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: "test.system-of-record",
      verification_method: "absence_window_probe",
      kind: "absence_probe",
      strength: "authoritative",
      observed_disposition: "effect_absent",
      attribution: "indeterminate",
      provider_object_id: null,
      provider_event_id: "contradiction:absence",
      observed_at: now.timestamp,
      provider_timestamp: null,
      payload: { matches: 0, consistency_window_elapsed: true },
      correlation: { method: "test", value: result.action.business_key },
      signing: null,
      clock: now,
      supersedes_evidence_id: null,
    });
    const resolution = await h.runtime.reconcile(result.action.action_id);
    assert.equal(resolution.effect.state, "unprovable");
    assert.equal(resolution.control.continuation, "blocked");
    assert.notEqual(resolution.control.retry, "allowed");
  });
});

describe("Gate 2 EffectSpec versioning and malformed adapters", () => {
  it("recovery uses the version bound to the action, not the current registry version", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "version-bound",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    const versionB: EffectSpec = { ...createFakeSpec(), schema_version: "fake.repository_permission_change/2.0.0" };
    h.registry.register(versionB);
    const recovered = await h.runtime.recover(first.action.action_id);
    assert.equal(recovered.control.spec_version, h.spec.schema_version);
  });

  it("missing historical EffectSpec fails closed instead of falling back to latest", async () => {
    const h = makeRuntimeHarness();
    const first = await h.runtime.commit(
      h.spec.effect_name,
      "missing-version",
      runtimeInput("definitely_applied"),
      EMPTY_CONTEXT
    );
    const registry = new EffectRegistry();
    registry.register({ ...createFakeSpec(), schema_version: "fake.repository_permission_change/2.0.0" });
    const restarted = new NystRuntime(h.store, registry, [h.provider], h.signer, h.clock);
    await assert.rejects(() => restarted.recover(first.action.action_id), MissingEffectSpecError);
  });

  it("invalid assessment state is rejected and never signed", async () => {
    const honest = createFakeSpec();
    const broken = {
      ...honest,
      schema_version: "fake.repository_permission_change/broken-state",
      assess() {
        return {
          proposed_state: "definitely_successful",
          provider_object_refs: [],
          evidence_refs: [],
          verification_methods: [],
          claimed_strength: "none",
          attribution_established: false,
        };
      },
    } as unknown as EffectSpec;
    const h = makeRuntimeHarness();
    h.registry.register(broken);
    await assert.rejects(
      () => h.runtime.commit(
        broken.effect_name,
        "broken-state",
        runtimeInput("only_transport"),
        EMPTY_CONTEXT
      ),
      /expected one of/
    );
    const action = await h.store.actions.findByIdentity(broken.effect_name, "broken-state");
    assert.ok(action);
    assert.equal(await h.store.resolutions.latestForAction(action!.action_id), null);
  });

  it("prepare failure happens before provider mutation", async () => {
    const honest = createFakeSpec();
    const broken: EffectSpec = {
      ...honest,
      schema_version: "fake.repository_permission_change/broken-prepare",
      prepareDispatch() {
        throw new Error("prepare exploded");
      },
    };
    const h = makeRuntimeHarness();
    h.registry.register(broken);
    await assert.rejects(
      () => h.runtime.commit(
        broken.effect_name,
        "broken-prepare",
        runtimeInput("definitely_applied"),
        EMPTY_CONTEXT
      ),
      /prepare exploded/
    );
    assert.equal(h.provider.mutationCount(), 0);
  });

  it("assessment and policy exceptions fail closed without a signed decision", async () => {
    for (const stage of ["assess", "decide"] as const) {
      const honest = createFakeSpec();
      const broken: EffectSpec = stage === "assess"
        ? { ...honest, schema_version: `fake.repository_permission_change/throws-${stage}`, assess() { throw new Error("classify exploded"); } }
        : { ...honest, schema_version: `fake.repository_permission_change/throws-${stage}`, decide() { throw new Error("policy exploded"); } };
      const h = makeRuntimeHarness();
      h.registry.register(broken);
      const key = `throws-${stage}`;
      await assert.rejects(
        () => h.runtime.commit(
          broken.effect_name,
          key,
          runtimeInput("only_transport"),
          EMPTY_CONTEXT
        ),
        /exploded/
      );
      const action = await h.store.actions.findByIdentity(broken.effect_name, key);
      assert.equal(await h.store.resolutions.latestForAction(action!.action_id), null);
    }
  });

  it("unsupported compensation is rejected before a compensation mutation", async () => {
    const strict: EffectSpec = {
      ...createFakeSpec(),
      schema_version: "fake.repository_permission_change/no-compensation",
      compensation: { supported: false, method: null, confirming_evidence: [] },
    };
    const h = makeRuntimeHarness();
    h.registry.register(strict);
    const result = await h.runtime.commit(
      strict.effect_name,
      "unsupported-compensation",
      runtimeInput("wrong_permission"),
      EMPTY_CONTEXT
    );
    await assert.rejects(
      () => h.runtime.compensate(result.action.action_id),
      /unsupported/
    );
    assert.equal(h.provider.compensationMutationCount(), 0);
  });

  it("ambiguous compensation never claims compensated", async () => {
    const h = makeRuntimeHarness();
    const result = await h.runtime.commit(
      h.spec.effect_name,
      "ambiguous-compensation",
      runtimeInput("wrong_permission"),
      EMPTY_CONTEXT
    );
    const compensate = h.provider.compensate.bind(h.provider);
    h.provider.compensate = async (action, plan) => {
      await compensate(action, plan);
      throw new Error("compensation response lost");
    };
    await assert.rejects(
      () => h.runtime.compensate(result.action.action_id),
      /response lost/
    );
    const later = await h.runtime.reconcile(result.action.action_id);
    assert.notEqual(later.effect.state, "compensated");
    assert.equal(later.control.continuation, "blocked");
    assert.equal(h.provider.compensationMutationCount(result.action.business_key), 1);
  });

  it("signer failure persists no unsigned receipt and recovery does not redispatch", async () => {
    const h = makeRuntimeHarness();
    const failingSigner = {
      ...h.signer,
      keyId: h.signer.keyId,
      publicKeyB64: () => h.signer.publicKeyB64(),
      sign() { throw new Error("signer unavailable"); },
      verify: h.signer.verify.bind(h.signer),
    };
    const runtime = new NystRuntime(
      h.store,
      h.registry,
      [h.provider],
      failingSigner,
      h.clock
    );
    const key = "signer-failure";
    await assert.rejects(
      () => runtime.commit(
        h.spec.effect_name,
        key,
        runtimeInput("definitely_applied"),
        EMPTY_CONTEXT
      ),
      /signer unavailable/
    );
    const action = await h.store.actions.findByIdentity(h.spec.effect_name, key);
    assert.equal(await h.store.resolutions.latestForAction(action!.action_id), null);
    const recovered = await h.runtime.recover(action!.action_id);
    assert.equal(recovered.effect.state, "verified");
    assert.equal(h.provider.mutationCount(key), 1);
  });
});
