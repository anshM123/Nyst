import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { NystRuntime } from "../src/runtime/nystRuntime.js";
import { ProcessCrashError } from "../src/runtime/provider.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { Store } from "../src/store/store.js";
import { makeOktaHarness, oktaInput } from "./oktaHelpers.js";

const url = process.env.DATABASE_URL;
describe("Gate 5 Okta/PostgreSQL integration and direct attacks", { skip: url ? false : "DATABASE_URL not set — no database to test against" }, () => {
  let store: (Store & { close(): Promise<void> }) | undefined;
  let db: Pool | undefined;
  let serial = 0;
  const key = (prefix: string) => `okta-pg:${prefix}:${Date.now()}:${++serial}`;
  before(async () => { store = await createPostgresStore(url!); db = new Pool({ connectionString: url! }); });
  after(async () => { await store?.close(); await db?.end(); });

  it("persists the exact plan and attempted boundary before the lifecycle consequence", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" }, store!);
    const businessKey = key("persist"); let checked = false;
    h.transport.beforeMutation = async () => {
      const action = await store!.actions.findByIdentity(h.spec.effect_name, businessKey);
      assert.ok(action?.dispatch_plan);
      assert.equal(action.dispatch_plan.provider, "okta");
      assert.equal(action.dispatch_plan.operation, "suspend");
      assert.equal((action.dispatch_plan.target as { user_id: string }).user_id, oktaInput().user_id);
      assert.equal((await store!.runtime.get(action.action_id))?.dispatch_status, "attempted");
      checked = true;
    };
    const result = await h.service.commit(businessKey, oktaInput(), EMPTY_CONTEXT);
    assert.equal(checked, true); assert.equal(h.transport.mutationCount, 1);
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
  });

  it("serializes ten callers and crash-after-effect recovery to one consequence", async () => {
    const concurrent = makeOktaHarness({ status: "ACTIVE" }, store!);
    const duplicateKey = key("dupe");
    const results = await Promise.all(Array.from({ length: 10 }, () => concurrent.service.commit(duplicateKey, oktaInput(), EMPTY_CONTEXT)));
    assert.equal(new Set(results.map((item) => item.action.action_id)).size, 1);
    assert.equal(concurrent.transport.mutationCount, 1);

    let crashed = false;
    const h = makeOktaHarness({ status: "ACTIVE" }, store!, { fault_injector(point) { if (!crashed && point === "after_provider_mutation") { crashed = true; throw new ProcessCrashError(point); } } });
    const businessKey = key("restart");
    await assert.rejects(() => h.service.commit(businessKey, oktaInput(), EMPTY_CONTEXT), ProcessCrashError);
    const action = await store!.actions.findByIdentity(h.spec.effect_name, businessKey); assert.ok(action);
    const recovered = await new NystRuntime(store!, h.registry, [h.provider], h.signer, h.clock).recover(action.action_id);
    assert.equal(recovered.effect.state, "satisfied_unattributed"); assert.equal(h.transport.mutationCount, 1);
  });

  it("rejects tenant, user, desired status, operation, credential, version, and deletion rewrites", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" }, store!);
    const result = await h.service.commit(key("attacks"), oktaInput(), EMPTY_CONTEXT);
    const id = result.action.action_id;
    for (const sql of [
      `UPDATE outcome_actions SET input=jsonb_set(input,'{tenant_host}','"integrator-999.okta.com"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET input=jsonb_set(input,'{user_id}','"00uDIFFERENTUSER0000"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET input=jsonb_set(input,'{desired_status}','"active"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET dispatch_plan=jsonb_set(dispatch_plan,'{operation}','"unsuspend"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET dispatch_plan=jsonb_set(dispatch_plan,'{credential_ref}','"env:EVIL"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET spec_version='okta.user_suspension_change/9.9.9' WHERE action_id=$1`,
      `DELETE FROM outcome_actions WHERE action_id=$1`,
    ]) await assert.rejects(() => db!.query(sql, [id]), /immutable|append-only/);
  });
});
