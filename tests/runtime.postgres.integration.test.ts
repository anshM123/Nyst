import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { Store } from "../src/store/store.js";
import { InputCollisionError } from "../src/model/action.js";
import { NystRuntime, StaleDecisionError } from "../src/runtime/nystRuntime.js";
import { ProcessCrashError } from "../src/runtime/provider.js";
import { makeRuntimeHarness, runtimeInput } from "./runtimeHelpers.js";

const url = process.env.DATABASE_URL;

describe(
  "Gate 2 PostgreSQL runtime integration",
  { skip: url ? false : "DATABASE_URL not set — no database to test against" },
  () => {
    let store: (Store & { close(): Promise<void> }) | undefined;
    let serial = 0;
    const key = (prefix: string) => `runtime-pg:${prefix}:${Date.now()}:${++serial}`;

    before(async () => {
      store = await createPostgresStore(url!);
      await store.actions.findByIdentity("connectivity.check", "runtime");
    });

    after(async () => {
      await store?.close();
    });

    for (const callers of [2, 10, 100]) {
      it(`${callers} concurrent commits create one row and at most one provider mutation`, async () => {
        const h = makeRuntimeHarness({}, store!);
        const businessKey = key(`concurrent-${callers}`);
        const results = await Promise.all(
          Array.from({ length: callers }, () =>
            h.runtime.commit(
              h.spec.effect_name,
              businessKey,
              runtimeInput("response_lost_after_effect"),
              EMPTY_CONTEXT
            )
          )
        );
        assert.equal(new Set(results.map((result) => result.action.action_id)).size, 1);
        assert.equal(results.filter((result) => result.created).length, 1);
        assert.equal(h.provider.mutationCount(businessKey), 1);
        const action = await store!.actions.findByIdentity(h.spec.effect_name, businessKey);
        assert.ok(action?.dispatch_plan);
        const runtime = await store!.runtime.get(action!.action_id);
        assert.equal(runtime!.dispatch_attempts, 1);
      });
    }

    it("concurrent semantic collision has one winner and no second mutation", async () => {
      const h = makeRuntimeHarness({}, store!);
      const businessKey = key("collision");
      const settled = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) =>
          h.runtime.commit(
            h.spec.effect_name,
            businessKey,
            runtimeInput("definitely_applied", {
              desired_permission: index % 2 === 0 ? "read" : "admin",
            }),
            EMPTY_CONTEXT
          )
        )
      );
      const fulfilled = settled.filter((result) => result.status === "fulfilled");
      const rejected = settled.filter((result) => result.status === "rejected");
      assert.ok(fulfilled.length >= 1);
      assert.ok(rejected.length >= 1);
      assert.ok(rejected.every((result) => result.reason instanceof InputCollisionError));
      assert.equal(new Set(fulfilled.map((result) => result.value.action.action_id)).size, 1);
      assert.equal(h.provider.mutationCount(businessKey), 1);
    });

    it("persisted intent and DispatchPlan are visible before provider dispatch", async () => {
      let inspectedActionId: string | undefined;
      const h = makeRuntimeHarness({
        fault_injector(point, action) {
          if (point === "before_dispatch_claim") {
            inspectedActionId = action.action_id;
            throw new ProcessCrashError(point);
          }
        },
      }, store!);
      const businessKey = key("persist-first");
      await assert.rejects(
        () => h.runtime.commit(
          h.spec.effect_name,
          businessKey,
          runtimeInput("definitely_applied"),
          EMPTY_CONTEXT
        ),
        ProcessCrashError
      );
      assert.ok(inspectedActionId);
      const action = await store!.actions.getAction(inspectedActionId!);
      const runtime = await store!.runtime.get(inspectedActionId!);
      assert.ok(action);
      assert.ok(action!.dispatch_plan);
      assert.match(action!.input_hash, /^sha256:/);
      assert.equal(runtime!.dispatch_status, "not_started");
      assert.equal(h.provider.mutationCount(businessKey), 0);
    });

    it("restart after response loss and 10 concurrent reconcilers never redispatch", async () => {
      const h = makeRuntimeHarness({
        fault_injector(point) {
          if (point === "after_provider_mutation") throw new ProcessCrashError(point);
        },
      }, store!);
      const businessKey = key("restart");
      await assert.rejects(
        () => h.runtime.commit(
          h.spec.effect_name,
          businessKey,
          runtimeInput("response_lost_after_effect"),
          EMPTY_CONTEXT
        ),
        ProcessCrashError
      );
      const action = await store!.actions.findByIdentity(h.spec.effect_name, businessKey);
      const runtimes = Array.from({ length: 10 }, () =>
        new NystRuntime(store!, h.registry, [h.provider], h.signer, h.clock)
      );
      const resolutions = await Promise.all(
        runtimes.map((runtime) => runtime.recover(action!.action_id))
      );
      assert.ok(resolutions.every((resolution) => resolution.effect.state === "verified"));
      assert.equal(h.provider.mutationCount(businessKey), 1);
      const latest = await store!.resolutions.latestForAction(action!.action_id);
      assert.equal(
        latest!.runtime!.resolution_sequence,
        Math.max(...resolutions.map((resolution) => resolution.runtime!.resolution_sequence))
      );
    });

    it("PostgreSQL serializes evidence arrival against a guarded retry claim", async () => {
      const h = makeRuntimeHarness({}, store!);
      const businessKey = key("retry-toctou");
      const first = await h.runtime.commit(
        h.spec.effect_name,
        businessKey,
        runtimeInput("definitely_not_sent"),
        EMPTY_CONTEXT
      );
      const ledger = await store!.evidence.listForAction(first.action.action_id);
      const absence = ledger.find(
        (item) => item.strength === "authoritative" && item.observed_disposition === "effect_absent"
      )!;
      let injected = false;
      const racing = new NystRuntime(
        store!,
        h.registry,
        [h.provider],
        h.signer,
        h.clock,
        {
          async fault_injector(point, action) {
            if (point !== "before_dispatch_claim" || injected) return;
            injected = true;
            h.provider.setExternalPermission("repo_prod", "alice", "none", businessKey);
            h.provider.setScenario(action.action_id, "definitely_applied");
            const observed = await h.provider.observe(action, action.dispatch_plan!);
            await store!.evidence.append({
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
      const runtime = await store!.runtime.get(first.action.action_id);
      const evidence = await store!.evidence.listForAction(first.action.action_id);
      assert.equal(runtime!.evidence_sequence, evidence.at(-1)!.seq);
      assert.equal(h.provider.mutationCount(businessKey), 0);
    });
  }
);
