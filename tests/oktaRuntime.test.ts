import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyResolution } from "../src/engine/resolver.js";
import { InputCollisionError } from "../src/model/action.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { StaleDecisionError } from "../src/runtime/nystRuntime.js";
import { makeOktaHarness, oktaInput } from "./oktaHelpers.js";

describe("Gate 5 Okta lifecycle semantics", () => {
  for (const [initial, desired, expectedWrites] of [
    ["ACTIVE", "suspended", 1], ["SUSPENDED", "active", 1],
    ["ACTIVE", "active", 0], ["SUSPENDED", "suspended", 0],
  ] as const) {
    it(`${initial} -> ${desired.toUpperCase()} uses ${expectedWrites} lifecycle write(s)`, async () => {
      const h = makeOktaHarness({ status: initial });
      const result = await h.service.commit(`matrix:${initial}:${desired}`, oktaInput(desired), EMPTY_CONTEXT);
      assert.equal(h.transport.mutationCount, expectedWrites);
      assert.equal(result.resolution.effect.state, "satisfied_unattributed");
      assert.notEqual(result.resolution.effect.state, "verified");
      assert.equal(result.resolution.control.retry, "forbidden");
      assert.equal(result.resolution.control.continuation, "allowed");
      assert.equal(verifyResolution(h.signer, result.resolution), true);
    });
  }

  it("response loss after effect reconciles without redispatch", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    h.transport.responseLossAfterEffect = true;
    const result = await h.service.commit("loss", oktaInput("suspended"), EMPTY_CONTEXT);
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    assert.equal(h.transport.mutationCount, 1);
    await h.runtime.recover(result.action.action_id);
    await Promise.all(Array.from({ length: 10 }, () => h.runtime.reconcile(result.action.action_id)));
    assert.equal(h.transport.mutationCount, 1);
  });

  it("successful response without effect never establishes the goal", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    h.transport.successfulResponseWithoutEffect = true;
    const first = await h.service.commit("false-success", oktaInput("suspended"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "pending");
    assert.equal(first.resolution.control.retry, "forbidden");
    h.clock.advance(6 * 60_000);
    const terminal = await h.runtime.reconcile(first.action.action_id);
    assert.equal(terminal.effect.state, "not_applied");
    assert.equal(terminal.control.retry, "forbidden");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("eventual ACTIVE, ACTIVE, SUSPENDED progression never redispatches", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    h.transport.postMutationReads = ["ACTIVE", "ACTIVE", "SUSPENDED"];
    const first = await h.service.commit("eventual", oktaInput(), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "pending");
    assert.equal((await h.runtime.reconcile(first.action.action_id)).effect.state, "pending");
    assert.equal((await h.runtime.reconcile(first.action.action_id)).effect.state, "satisfied_unattributed");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("definitely-not-sent may use one guarded retry with the stable operation", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    h.transport.failDefinitelyBeforeSend = true;
    const first = await h.service.commit("before-send", oktaInput(), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "not_applied");
    assert.equal(first.resolution.control.retry, "allowed");
    assert.equal(h.transport.mutationCount, 0);
    const plan = structuredClone(first.action.dispatch_plan);
    h.transport.failDefinitelyBeforeSend = false;
    const retried = await h.runtime.retry(first.action.action_id, first.resolution.resolution_id);
    assert.equal(retried.effect.state, "satisfied_unattributed");
    assert.deepEqual((await h.store.actions.getAction(first.action.action_id))?.dispatch_plan, plan);
    assert.equal(h.transport.mutationCount, 1);
  });

  for (const mode of ["timeout", "reset", "ambiguous"] as const) {
    it(`${mode} may-have-been-sent blocks blind retry`, async () => {
      const h = makeOktaHarness({ status: "ACTIVE" });
      h.transport.failMayHaveBeenSentBeforeEffect = true;
      const result = await h.service.commit(`ambiguous:${mode}`, oktaInput(), EMPTY_CONTEXT);
      assert.equal(result.resolution.effect.state, "pending");
      assert.equal(result.resolution.control.retry, "forbidden");
      assert.equal(result.resolution.control.continuation, "blocked");
      assert.equal(h.transport.mutationCount, 0);
    });
  }

  for (const status of [401, 403, 404, 500, 502, 503]) {
    it(`observation ${status} invalidates prior continuation and fails closed`, async () => {
      const h = makeOktaHarness({ status: "ACTIVE" });
      const first = await h.service.commit(`read-error:${status}`, oktaInput(), EMPTY_CONTEXT);
      h.transport.forceReadStatus = status;
      const result = await h.runtime.reconcile(first.action.action_id);
      assert.equal(result.effect.state, "unprovable");
      assert.equal(result.control.retry, "forbidden");
      assert.equal(result.control.continuation, "blocked");
      assert.equal(h.transport.mutationCount, 1);
    });
  }

  it("429 persists a bounded hint without redispatch", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const first = await h.service.commit("rate-limit", oktaInput(), EMPTY_CONTEXT);
    h.transport.forceReadStatus = 429;
    h.transport.forceReadHeaders = { "retry-after": "120", "x-rate-limit-reset": "9999999999" };
    const result = await h.runtime.reconcile(first.action.action_id);
    assert.equal(result.effect.state, "pending");
    assert.equal(result.control.primary, "hold");
    assert.equal(result.control.retry, "forbidden");
    assert.equal(result.control.continuation, "blocked");
    const wait = new Date(result.control.next_check_at!).getTime() - new Date(result.trust.resolved_at).getTime();
    assert.ok(wait >= 60_000 && wait <= 300_000);
    assert.equal(h.transport.mutationCount, 1);
  });

  for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
    it(`lifecycle response ${status} cannot manufacture effect truth or mutation retry`, async () => {
      const h = makeOktaHarness({ status: "ACTIVE" });
      h.transport.mutationStatus = status;
      const result = await h.service.commit(`mutation-error:${status}`, oktaInput(), EMPTY_CONTEXT);
      assert.equal(result.resolution.effect.state, "pending");
      assert.equal(result.resolution.control.retry, "forbidden");
      assert.equal(result.resolution.control.continuation, "blocked");
      assert.equal(h.transport.mutationCount, 1);
    });
  }

  it("stable user ID remains authoritative across login change", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const first = await h.service.commit("login-change", oktaInput(), EMPTY_CONTEXT);
    h.transport.login = "renamed@example.test";
    const later = await h.runtime.reconcile(first.action.action_id);
    assert.equal(later.effect.state, "satisfied_unattributed");
  });

  it("repeated reconciliation is observation-only and deduplicates identical status facts", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const first = await h.service.commit("dedup", oktaInput(), EMPTY_CONTEXT);
    const before = await h.store.evidence.listForAction(first.action.action_id);
    await Promise.all(Array.from({ length: 10 }, () => h.runtime.reconcile(first.action.action_id)));
    const after = await h.store.evidence.listForAction(first.action.action_id);
    assert.equal(after.length, before.length);
    assert.equal(h.transport.mutationCount, 1);
  });

  it("stable user ID mismatch fails closed", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const first = await h.service.commit("identity-mismatch", oktaInput(), EMPTY_CONTEXT);
    h.transport.userId = "00uDIFFERENTUSER0000";
    const later = await h.runtime.reconcile(first.action.action_id);
    assert.equal(later.effect.state, "unprovable");
    assert.equal(later.control.continuation, "blocked");
  });

  it("2/10/100 duplicate callers converge to one action and one write", async () => {
    for (const count of [2, 10, 100]) {
      const h = makeOktaHarness({ status: "ACTIVE" });
      const results = await Promise.all(Array.from({ length: count }, () => h.service.commit(`dupe:${count}`, oktaInput(), EMPTY_CONTEXT)));
      assert.equal(new Set(results.map((item) => item.action.action_id)).size, 1);
      assert.equal(h.transport.mutationCount, 1);
    }
  });

  it("concurrent opposite goals collide before a second consequence", async () => {
    const h = makeOktaHarness({ status: "ACTIVE" });
    const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      h.service.commit("collision", oktaInput(i % 2 ? "active" : "suspended"), EMPTY_CONTEXT)));
    assert.ok(settled.some((item) => item.status === "rejected" && item.reason instanceof InputCollisionError));
    assert.ok(h.transport.mutationCount <= 1);
  });

  it("stale retry and continuation authorizations are rejected", async () => {
    const retry = makeOktaHarness({ status: "ACTIVE" });
    retry.transport.failDefinitelyBeforeSend = true;
    const retryable = await retry.service.commit("stale-retry", oktaInput(), EMPTY_CONTEXT);
    retry.transport.failDefinitelyBeforeSend = false;
    retry.transport.status = "SUSPENDED";
    await retry.runtime.reconcile(retryable.action.action_id);
    await assert.rejects(() => retry.runtime.retry(retryable.action.action_id, retryable.resolution.resolution_id), StaleDecisionError);

    const continuation = makeOktaHarness({ status: "ACTIVE" });
    const allowed = await continuation.service.commit("stale-cont", oktaInput(), EMPTY_CONTEXT);
    continuation.transport.forceReadStatus = 403;
    await continuation.runtime.reconcile(allowed.action.action_id);
    await assert.rejects(() => continuation.runtime.authorizeContinuation(allowed.action.action_id, allowed.resolution.resolution_id), StaleDecisionError);
  });
});
