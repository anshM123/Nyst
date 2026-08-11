import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { Store } from "../src/store/store.js";
import { STRIPE_INPUT, makeStripeHarness } from "./stripeHelpers.js";

const url = process.env.DATABASE_URL;
describe("Gate 7 Stripe/PostgreSQL integration and direct attacks", { skip: url ? false : "DATABASE_URL not set — no database to test against" }, () => {
  let store: (Store & { close(): Promise<void> }) | undefined; let db: Pool | undefined;
  const key = (prefix: string) => `stripe-pg:${prefix}:${randomUUID()}`;
  before(async () => { store = await createPostgresStore(url!); db = new Pool({ connectionString: url! }); });
  after(async () => { await store?.close(); await db?.end(); });
  for (const effect of ["refund", "capture"] as const) {
    it(`${effect}: persists the exact idempotent plan before one consequence under contention`, async () => {
      const h = makeStripeHarness(effect, store!); const businessKey = key(effect); let observed = false;
      h.transport.beforeMutation = async () => {
        const action = await store!.actions.findByIdentity(h.effect, businessKey); assert.ok(action?.dispatch_plan?.idempotency_key);
        assert.equal(action.dispatch_plan.provider, "stripe"); assert.match(action.dispatch_plan.idempotency_key!, new RegExp(action.action_id));
        assert.equal((await store!.runtime.get(action.action_id))?.dispatch_status, "attempted"); observed = true;
      };
      const results = await Promise.all(Array.from({ length: 10 }, () => h.service.commit(businessKey, STRIPE_INPUT, EMPTY_CONTEXT)));
      assert.equal(observed, true); assert.equal(new Set(results.map((r) => r.action.action_id)).size, 1); assert.equal(h.transport.mutationCount, 1);
    });
  }
  it("rejects semantic, operation, idempotency, credential, version, and deletion rewrites", async () => {
    const h = makeStripeHarness("refund", store!); const result = await h.service.commit(key("attacks"), STRIPE_INPUT, EMPTY_CONTEXT); const id = result.action.action_id;
    for (const sql of [
      `UPDATE outcome_actions SET input=jsonb_set(input,'{amount_minor}','1199') WHERE action_id=$1`,
      `UPDATE outcome_actions SET input=jsonb_set(input,'{payment_intent_id}','"pi_rewritten"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET dispatch_plan=jsonb_set(dispatch_plan,'{operation}','"capture_payment_intent"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET dispatch_plan=jsonb_set(dispatch_plan,'{idempotency_key}','"evil"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET dispatch_plan=jsonb_set(dispatch_plan,'{credential_ref}','"env:EVIL"') WHERE action_id=$1`,
      `UPDATE outcome_actions SET spec_version='stripe.refund/9.9.9' WHERE action_id=$1`,
      `DELETE FROM outcome_actions WHERE action_id=$1`,
    ]) await assert.rejects(() => db!.query(sql, [id]), /immutable|append-only/);
  });
});
