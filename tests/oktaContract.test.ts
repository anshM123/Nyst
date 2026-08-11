import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { normalizePublicOktaInput } from "../src/providers/okta/oktaInput.js";
import { OKTA_DOCUMENTED_USER_STATUSES, OKTA_EFFECT_NAME, OKTA_SPEC_VERSION } from "../src/providers/okta/types.js";
import { makeOktaHarness, oktaInput, TEST_OKTA_ORIGIN, TEST_OKTA_USER_ID } from "./oktaHelpers.js";

describe("Gate 5 Okta provider contract", () => {
  it("pins the EffectSpec and exact semantic identity fields", () => {
    const h = makeOktaHarness();
    assert.equal(h.spec.effect_name, OKTA_EFFECT_NAME);
    assert.equal(h.spec.schema_version, OKTA_SPEC_VERSION);
    assert.deepEqual(h.spec.semantic_fields, ["tenant_host", "user_id", "desired_status"]);
    assert.equal(h.spec.provider_idempotency_semantics, null);
  });

  it("accepts only a canonical default Integrator Free Plan origin", () => {
    assert.equal(normalizePublicOktaInput(oktaInput()).org, TEST_OKTA_ORIGIN);
    for (const org of [
      "http://integrator-1234567.okta.com", "https://integrator-1234567.okta.com/path",
      "https://user@integrator-1234567.okta.com", "https://integrator-1234567.okta.com:443",
      "https://example.okta.com", "https://integrator-1234567.oktapreview.com",
      "https://integrator-1234567.okta.com.evil.test", "https://127.0.0.1",
    ]) assert.throws(() => normalizePublicOktaInput({ ...oktaInput(), org }));
  });

  it("rejects path-injection user IDs and semantic fault controls", () => {
    for (const user_id of ["../admin", `${TEST_OKTA_USER_ID}/roles`, "x%2fy", "short"])
      assert.throws(() => normalizePublicOktaInput({ ...oktaInput(), user_id }));
    assert.throws(() => normalizePublicOktaInput({ ...oktaInput(), scenario: "response_loss" }));
  });

  it("persists stable tenant/user identity and only a credential reference", async () => {
    const h = makeOktaHarness();
    let checked = false;
    h.transport.beforeMutation = async () => {
      const action = await h.store.actions.findByIdentity(OKTA_EFFECT_NAME, "contract-persist");
      assert.ok(action?.dispatch_plan);
      assert.equal(action.spec_version, OKTA_SPEC_VERSION);
      assert.equal(action.context.credential_ref, "env:NYST_OKTA_ACCESS_TOKEN");
      assert.equal(action.dispatch_plan.provider, "okta");
      assert.equal(action.dispatch_plan.operation, "suspend");
      assert.equal((action.dispatch_plan.target as { user_id: string }).user_id, TEST_OKTA_USER_ID);
      assert.equal(JSON.stringify(action).includes("TEST_OKTA_ACCESS_TOKEN"), false);
      checked = true;
    };
    await h.service.commit("contract-persist", oktaInput(), EMPTY_CONTEXT);
    assert.equal(checked, true);
  });

  for (const status of OKTA_DOCUMENTED_USER_STATUSES.filter((value) => !["ACTIVE", "SUSPENDED"].includes(value))) {
    it(`fails closed without mutation for unsupported ${status}`, async () => {
      const h = makeOktaHarness({ status });
      const result = await h.service.commit(`unsupported:${status}`, oktaInput(), EMPTY_CONTEXT);
      assert.equal(h.transport.mutationCount, 0);
      assert.equal(result.resolution.effect.state, "unprovable");
      assert.equal(result.resolution.control.retry, "forbidden");
      assert.equal(result.resolution.control.continuation, "blocked");
    });
  }

  it("fails closed for an unknown future status", async () => {
    const h = makeOktaHarness({ status: "FUTURE_QUANTUM_LOCK" });
    const result = await h.service.commit("unsupported:future", oktaInput(), EMPTY_CONTEXT);
    assert.equal(h.transport.mutationCount, 0);
    assert.equal(result.resolution.effect.state, "unprovable");
  });

  it("rejects non-Okta-sourced and admin fixture users before consequence", async () => {
    await assert.rejects(() => makeOktaHarness({ source_type: "ACTIVE_DIRECTORY" }).service.commit("source", oktaInput(), EMPTY_CONTEXT));
    await assert.rejects(() => makeOktaHarness({ roles: [{ type: "SUPER_ADMIN", status: "ACTIVE" }] }).service.commit("admin", oktaInput(), EMPTY_CONTEXT));
  });
});
