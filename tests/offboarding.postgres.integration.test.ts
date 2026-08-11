import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { makeOffboardingHarness, offboardingIntent } from "./offboardingHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  describe("Gate 6 Offboarding/PostgreSQL integration", { skip: "DATABASE_URL not set — no database to test against" }, () => {});
} else {
  describe("Gate 6 Offboarding/PostgreSQL integration", () => {
    it("persists one run and one action per provider under ten-way contention", async () => {
      const store = await createPostgresStore(databaseUrl);
      try {
        const h = makeOffboardingHarness(store);
        const suffix = randomUUID();
        const intent = offboardingIntent({
          business_key: `gate6-pg-${suffix}`,
          subject: { subject_key: `employee-${suffix}`, display_name: "Postgres Fixture" },
        });
        const views = await Promise.all(Array.from({ length: 10 }, () => h.coordinator.execute(intent)));
        const final = await h.coordinator.view(views[0]!.run.run_id);
        assert.equal(final.status, "complete");
        assert.equal(new Set(views.map((view) => view.run.run_id)).size, 1);
        assert.equal(h.oktaTransport.mutationCount, 1);
        assert.equal(h.githubTransport.mutationCount, 1);
      } finally { await store.close(); }
    });

    it("rejects direct run-intent, action-link, and deletion attacks", async () => {
      const store = await createPostgresStore(databaseUrl);
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        const h = makeOffboardingHarness(store);
        const suffix = randomUUID();
        const view = await h.coordinator.execute(offboardingIntent({
          business_key: `gate6-attack-${suffix}`,
          subject: { subject_key: `attack-${suffix}`, display_name: "Attack Fixture" },
        }));
        for (const sql of [
          "UPDATE outcome_offboarding_runs SET subject_key='rewritten' WHERE run_id=$1",
          "UPDATE outcome_offboarding_runs SET okta_action_id=NULL WHERE run_id=$1",
          "UPDATE outcome_offboarding_runs SET github_action_id=NULL WHERE run_id=$1",
          "DELETE FROM outcome_offboarding_runs WHERE run_id=$1",
        ]) {
          await assert.rejects(() => pool.query(sql, [view.run.run_id]));
        }
        const persisted = await store.offboarding.get(view.run.run_id);
        assert.equal(persisted?.input_hash, view.run.input_hash);
        assert.equal(persisted?.okta_action_id, view.run.okta_action_id);
        assert.equal(persisted?.github_action_id, view.run.github_action_id);
      } finally { await pool.end(); await store.close(); }
    });

    it("rejects a stale source resolution in the atomic downstream claim", async () => {
      const store = await createPostgresStore(databaseUrl);
      try {
        const h = makeOffboardingHarness(store);
        const suffix = randomUUID();
        const view = await h.coordinator.execute(offboardingIntent({
          business_key: `gate6-stale-${suffix}`,
          subject: { subject_key: `stale-${suffix}`, display_name: "Stale Fixture" },
        }));
        const old = view.okta.resolution!;
        await h.runtime.reconcile(old.action_id);
        const source = (await store.actions.getAction(view.github.action_id!))!;
        await assert.rejects(() => h.runtime.commit(
          "github.repository_permission_change",
          `gate6-stale-target-${suffix}`,
          source.input,
          source.context,
          { continuation_guard: { action_id: old.action_id, resolution_id: old.resolution_id } }
        ));
        const target = await store.actions.findByIdentity("github.repository_permission_change", `gate6-stale-target-${suffix}`);
        assert.equal((await store.runtime.get(target!.action_id))?.dispatch_status, "not_started");
      } finally { await store.close(); }
    });
  });
}
