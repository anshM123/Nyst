import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { Store } from "../src/store/store.js";
import { githubInput, makeGitHubHarness } from "./githubHelpers.js";

const url = process.env.DATABASE_URL;

describe(
  "Gate 4 GitHub PostgreSQL attack probes",
  { skip: url ? false : "DATABASE_URL not set — no database to test against" },
  () => {
    let store: (Store & { close(): Promise<void> }) | undefined;
    let db: Pool | undefined;

    before(async () => {
      store = await createPostgresStore(url!);
      db = new Pool({ connectionString: url! });
    });

    after(async () => {
      await store?.close();
      await db?.end();
    });

    it("rejects DispatchPlan, semantic intent, spec version, and action deletion attacks", async () => {
      const h = makeGitHubHarness({ role: "read" }, store!);
      const result = await h.service.commit(
        `g4-db-immutability:${Date.now()}`,
        githubInput("write"),
        EMPTY_CONTEXT
      );
      const id = result.action.action_id;
      for (const sql of [
        `UPDATE outcome_actions SET dispatch_plan=jsonb_set(dispatch_plan,'{operation}','\"remove_collaborator\"') WHERE action_id=$1`,
        `UPDATE outcome_actions SET input=jsonb_set(input,'{desired_permission}','\"admin\"') WHERE action_id=$1`,
        `UPDATE outcome_actions SET spec_version='github.repository_permission_change/evil' WHERE action_id=$1`,
        `UPDATE outcome_actions SET internal_state='dispatching' WHERE action_id=$1`,
        `DELETE FROM outcome_actions WHERE action_id=$1`,
      ]) {
        await assert.rejects(() => db!.query(sql, [id]), /immutable|append-only|illegal persisted/);
      }
      const action = await store!.actions.getAction(id);
      assert.deepEqual(action?.dispatch_plan, result.action.dispatch_plan);
      assert.equal(action?.input_hash, result.action.input_hash);
      assert.equal(action?.spec_version, result.action.spec_version);
    });

    it("rejects forged runtime claimant/status combinations", async () => {
      const h = makeGitHubHarness({ role: "read" }, store!);
      const result = await h.service.commit(
        `g4-db-runtime-forge:${Date.now()}`,
        githubInput("admin"),
        EMPTY_CONTEXT
      );
      await assert.rejects(
        () => db!.query(
          `UPDATE outcome_runtime SET dispatch_status='claimed', dispatch_claim_token=NULL WHERE action_id=$1`,
          [result.action.action_id]
        ),
        /outcome_runtime_claim_consistency/
      );
      await assert.rejects(
        () => db!.query(
          `UPDATE outcome_runtime SET dispatch_status='attempted', dispatch_claim_token=gen_random_uuid() WHERE action_id=$1`,
          [result.action.action_id]
        ),
        /outcome_runtime_claim_consistency/
      );
    });
  }
);
