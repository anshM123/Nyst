import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { NystRuntime } from "../src/runtime/nystRuntime.js";
import { ProcessCrashError } from "../src/runtime/provider.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { Store } from "../src/store/store.js";
import { githubInput, makeGitHubHarness } from "./githubHelpers.js";

const url = process.env.DATABASE_URL;

describe(
  "Gate 3 GitHub/PostgreSQL integration",
  { skip: url ? false : "DATABASE_URL not set — no database to test against" },
  () => {
    let store: (Store & { close(): Promise<void> }) | undefined;
    let serial = 0;
    const key = (prefix: string) => `github-pg:${prefix}:${Date.now()}:${++serial}`;

    before(async () => {
      store = await createPostgresStore(url!);
      await store.actions.findByIdentity("connectivity.check", "github-runtime");
    });

    after(async () => {
      await store?.close();
    });

    it("makes the exact GitHub DispatchPlan visible in PostgreSQL before the provider write", async () => {
      const h = makeGitHubHarness({ role: "read" }, store!);
      const businessKey = key("persist-first");
      let inspected = false;
      h.transport.beforeMutation = async () => {
        const action = await store!.actions.findByIdentity(h.spec.effect_name, businessKey);
        assert.ok(action?.dispatch_plan);
        assert.match(action.input_hash, /^sha256:/);
        assert.equal(action.spec_version, h.spec.schema_version);
        assert.equal(action.context.credential_ref, "env:NYST_GITHUB_TOKEN");
        assert.equal(action.dispatch_plan.provider, "github");
        assert.equal(action.dispatch_plan.operation, "set_permission");
        assert.equal(action.dispatch_plan.api_version, "2026-03-10");
        const runtime = await store!.runtime.get(action.action_id);
        // The runtime durably marks the provider boundary ambiguous before it
        // calls the adapter; this deliberately favors no duplicate write after
        // a crash over optimistic redispatch.
        assert.equal(runtime?.dispatch_status, "attempted");
        inspected = true;
      };
      const result = await h.service.commit(businessKey, githubInput("write"), EMPTY_CONTEXT);
      assert.equal(inspected, true);
      assert.equal(h.transport.mutationCount, 1);
      assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    });

    it("serializes 10 callers to one GitHub-shaped write (100-way is covered by the memory mirror and core PG suite)", async () => {
      const h = makeGitHubHarness({ role: "read" }, store!);
      const businessKey = key("concurrent-100");
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          h.service.commit(businessKey, githubInput("admin"), EMPTY_CONTEXT)
        )
      );
      assert.equal(new Set(results.map((item) => item.action.action_id)).size, 1);
      assert.equal(results.filter((item) => item.created).length, 1);
      assert.equal(h.transport.mutationCount, 1);
    });

    it("recovers after a crash following the GitHub-shaped mutation without redispatch", async () => {
      let crashed = false;
      const h = makeGitHubHarness({ role: "read" }, store!, {
        fault_injector(point) {
          if (point === "after_provider_mutation" && !crashed) {
            crashed = true;
            throw new ProcessCrashError(point);
          }
        },
      });
      const businessKey = key("restart");
      await assert.rejects(
        () => h.service.commit(businessKey, githubInput("maintain"), EMPTY_CONTEXT),
        ProcessCrashError
      );
      const action = await store!.actions.findByIdentity(h.spec.effect_name, businessKey);
      assert.ok(action?.dispatch_plan);
      assert.equal(h.transport.mutationCount, 1);
      const restarted = new NystRuntime(store!, h.registry, [h.provider], h.signer, h.clock);
      const recovered = await restarted.recover(action.action_id);
      assert.equal(recovered.effect.state, "satisfied_unattributed");
      assert.equal(h.transport.mutationCount, 1);
      assert.deepEqual((await store!.actions.getAction(action.action_id))?.dispatch_plan, action.dispatch_plan);
    });
  }
);
