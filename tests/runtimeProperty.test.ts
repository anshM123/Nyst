import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import type { EvidenceRecord } from "../src/model/evidence.js";
import type { OutcomeResolution } from "../src/model/resolution.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { NystRuntime } from "../src/runtime/nystRuntime.js";
import { ProcessCrashError } from "../src/runtime/provider.js";
import { makeRuntimeHarness, runtimeInput } from "./runtimeHelpers.js";

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function active(evidence: readonly EvidenceRecord[]): EvidenceRecord[] {
  const superseded = new Set(
    evidence.map((item) => item.supersedes_evidence_id).filter((id): id is string => id !== null)
  );
  return evidence.filter((item) => !superseded.has(item.evidence_id));
}

function assertSafety(
  resolution: OutcomeResolution,
  evidence: readonly EvidenceRecord[]
): void {
  const current = active(evidence);
  const cited = current.filter((item) => resolution.effect.evidence_refs.includes(item.evidence_id));
  if (resolution.effect.state === "verified") {
    assert.ok(cited.some((item) =>
      item.strength === "authoritative" &&
      item.observed_disposition === "effect_present" &&
      item.attribution === "attributed"
    ));
  }
  if (resolution.effect.state === "not_applied") {
    assert.ok(cited.some((item) =>
      item.strength === "authoritative" && item.observed_disposition === "effect_absent"
    ));
  }
  if (resolution.effect.state === "pending" || resolution.effect.state === "unprovable") {
    assert.notEqual(resolution.control.retry, "allowed");
    assert.equal(resolution.control.continuation, "blocked");
  }
}

describe("Gate 2 deterministic property/model sequences", () => {
  for (const seed of [1, 7, 42, 2026, 65537]) {
    it(`seed ${seed} preserves global invariants`, async () => {
      const random = rng(seed);
      const scenarios = [
        "definitely_applied",
        "response_lost_after_effect",
        "definitely_not_applied",
        "definitely_not_sent",
        "eventual_consistency",
        "goal_state_preexisting",
        "only_transport",
        "wrong_permission",
      ] as const;
      const h = makeRuntimeHarness();
      for (let index = 0; index < 12; index++) {
        const scenario = scenarios[Math.floor(random() * scenarios.length)]!;
        const key = `property:${seed}:${index}`;
        let result = await h.runtime.commit(
          h.spec.effect_name,
          key,
          runtimeInput(scenario, { principal_id: `principal_${index}` }),
          EMPTY_CONTEXT
        );
        const repetitions = Math.floor(random() * 4);
        for (let step = 0; step < repetitions; step++) {
          const choice = Math.floor(random() * 3);
          if (choice === 0) {
            result = await h.runtime.commit(
              h.spec.effect_name,
              key,
              runtimeInput(scenario, { principal_id: `principal_${index}` }),
              EMPTY_CONTEXT
            );
          } else if (choice === 1) {
            result = { ...result, resolution: await h.runtime.reconcile(result.action.action_id) };
          } else {
            const restarted = new NystRuntime(
              h.store,
              h.registry,
              [h.provider],
              h.signer,
              h.clock
            );
            result = { ...result, resolution: await restarted.recover(result.action.action_id) };
          }
          const evidence = await h.store.evidence.listForAction(result.action.action_id);
          assertSafety(result.resolution, evidence);
          assert.equal(verifyResolution(h.signer, result.resolution), true);
          assert.ok(h.provider.mutationCount(key) <= 1, `seed=${seed} step=${step}`);
        }
      }
    });
  }
});

describe("Gate 2 repeated concurrency/fault stress", () => {
  for (const seed of [101, 202, 303]) {
    it(`seed ${seed}: 100 identical commits remain one mutation`, async () => {
      const h = makeRuntimeHarness();
      const key = `stress:${seed}`;
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          h.runtime.commit(
            h.spec.effect_name,
            key,
            runtimeInput("response_lost_after_effect"),
            EMPTY_CONTEXT
          )
        )
      );
      assert.equal(new Set(results.map((result) => result.action.action_id)).size, 1);
      assert.equal(h.provider.mutationCount(key), 1);
    });
  }

  it("repeats crash-after-mutation plus concurrent recovery ten times", async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      let crashed = false;
      const h = makeRuntimeHarness({
        fault_injector(point) {
          if (!crashed && point === "after_provider_mutation") {
            crashed = true;
            throw new ProcessCrashError(point);
          }
        },
      });
      const key = `crash-stress:${iteration}`;
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
      const workers = Array.from({ length: 10 }, () =>
        new NystRuntime(h.store, h.registry, [h.provider], h.signer, h.clock)
      );
      const resolutions = await Promise.all(workers.map((worker) => worker.recover(action!.action_id)));
      assert.ok(resolutions.every((resolution) => resolution.effect.state === "verified"));
      assert.equal(h.provider.mutationCount(key), 1);
    }
  });

  it("retry racing reconciliation never exceeds one external mutation", async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const h = makeRuntimeHarness();
      const first = await h.runtime.commit(
        h.spec.effect_name,
        `retry-race:${iteration}`,
        runtimeInput("definitely_not_sent"),
        EMPTY_CONTEXT
      );
      await Promise.allSettled([
        h.runtime.retry(first.action.action_id, first.resolution.resolution_id),
        h.runtime.reconcile(first.action.action_id),
      ]);
      assert.ok(h.provider.mutationCount(first.action.business_key) <= 1);
    }
  });
});
