import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { InputCollisionError } from "../src/model/action.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { githubInput, makeGitHubHarness } from "./githubHelpers.js";

describe("Gate 3 GitHub runtime semantics", () => {
  it("changes an existing member role once and reports exact goal satisfaction without false attribution", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const result = await h.service.commit("clean-write", githubInput("write"), EMPTY_CONTEXT);
    assert.equal(h.transport.mutationCount, 1);
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    assert.equal(result.resolution.control.retry, "forbidden");
    assert.equal(result.resolution.control.continuation, "allowed");
    assert.equal(verifyResolution(h.signer, result.resolution), true);
    assert.notEqual(result.resolution.effect.state, "verified");
  });

  it("removes direct/effective access and permits continuation only after effective none", async () => {
    const h = makeGitHubHarness({ role: "write" });
    const result = await h.service.commit("clean-removal", githubInput("none"), EMPTY_CONTEXT);
    assert.equal(h.transport.mutationCount, 1);
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    assert.equal(result.resolution.control.continuation, "allowed");
    assert.equal(h.transport.role, "none");
    assert.equal(h.transport.direct, false);
  });

  it("accepts GitHub's 200 no-access shape with a null role_name after removal", async () => {
    const h = makeGitHubHarness({ role: "write" });
    h.transport.permissionNoneAs200WithoutRoleName = true;
    const result = await h.service.commit("clean-removal-null-role", githubInput("none"), EMPTY_CONTEXT);
    assert.equal(h.transport.mutationCount, 1);
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    assert.equal(result.resolution.control.continuation, "allowed");
    assert.equal(h.transport.role, "none");
    assert.equal(h.transport.direct, false);
  });

  it("holds safely when a post-removal permission read temporarily omits role_name", async () => {
    const h = makeGitHubHarness({ role: "write" });
    h.transport.postMutationReads = ["read"];
    h.transport.permissionRoleNameEmpty = true;
    const first = await h.service.commit("removal-transitional-null-role", githubInput("none"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "pending");
    assert.equal(first.resolution.control.continuation, "blocked");
    assert.equal(h.transport.mutationCount, 1);
    h.transport.permissionRoleNameEmpty = false;
    h.clock.advance(6 * 60_000);
    const terminal = await h.runtime.reconcile(first.action.action_id);
    assert.equal(terminal.effect.state, "satisfied_unattributed");
    assert.equal(terminal.control.continuation, "allowed");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("response loss after the provider effect reconciles without redispatch", async () => {
    const h = makeGitHubHarness({ role: "read" });
    h.transport.responseLossAfterEffect = true;
    const first = await h.service.commit("response-loss", githubInput("maintain"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "satisfied_unattributed");
    assert.equal(h.transport.mutationCount, 1);
    const recovered = await h.runtime.recover(first.action.action_id);
    assert.equal(recovered.effect.state, "satisfied_unattributed");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("a 204 response without matching provider state remains pending, then proves not-applied without unsafe retry", async () => {
    const h = makeGitHubHarness({ role: "read" });
    h.transport.successfulResponseWithoutEffect = true;
    const first = await h.service.commit("false-success", githubInput("write"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "pending");
    assert.equal(first.resolution.control.retry, "forbidden");
    h.clock.advance(6 * 60_000);
    const terminal = await h.runtime.reconcile(first.action.action_id);
    assert.equal(terminal.effect.state, "not_applied");
    assert.equal(terminal.control.retry, "forbidden");
    assert.equal(terminal.control.reason_code, "CORE.RUNTIME_RETRY_REQUIRES_PROVEN_NOT_SENT");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("a proven-before-send failure plus provider absence permits one guarded retry", async () => {
    const h = makeGitHubHarness({ role: "read" });
    h.transport.failDefinitelyBeforeSend = true;
    const first = await h.service.commit("before-send", githubInput("write"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "not_applied");
    assert.equal(first.resolution.control.retry, "allowed");
    assert.equal(h.transport.mutationCount, 0);
    h.transport.failDefinitelyBeforeSend = false;
    const retried = await h.runtime.retry(first.action.action_id, first.resolution.resolution_id);
    assert.equal(retried.effect.state, "satisfied_unattributed");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("direct removal that leaves inherited effective access blocks offboarding continuation", async () => {
    const h = makeGitHubHarness({ role: "write" });
    h.transport.inheritedRoleAfterRemoval = "write";
    const first = await h.service.commit("inherited-access", githubInput("none"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "pending");
    assert.equal(first.resolution.control.continuation, "blocked");
    h.clock.advance(6 * 60_000);
    const terminal = await h.runtime.reconcile(first.action.action_id);
    assert.equal(terminal.effect.state, "not_applied");
    assert.equal(terminal.control.continuation, "blocked");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("preexisting exact effective goal performs no mutation and remains unattributed", async () => {
    const h = makeGitHubHarness({ role: "triage" });
    const result = await h.service.commit("preexisting", githubInput("triage"), EMPTY_CONTEXT);
    assert.equal(h.transport.mutationCount, 0);
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    assert.equal(result.resolution.control.retry, "forbidden");
  });

  it("same logical action under 2/10/100 callers remains one action and one GitHub write", async () => {
    for (const count of [2, 10, 100]) {
      const h = makeGitHubHarness({ role: "read" });
      const results = await Promise.all(
        Array.from({ length: count }, () =>
          h.service.commit(`concurrent-${count}`, githubInput("admin"), EMPTY_CONTEXT)
        )
      );
      assert.equal(new Set(results.map((item) => item.action.action_id)).size, 1);
      assert.equal(h.transport.mutationCount, 1);
      assert.ok(results.every((item) => item.resolution.effect.state === "satisfied_unattributed"));
    }
  });

  it("same business key with a different desired permission collides before a second write", async () => {
    const h = makeGitHubHarness({ role: "read" });
    await h.service.commit("collision", githubInput("write"), EMPTY_CONTEXT);
    await assert.rejects(
      () => h.service.commit("collision", githubInput("admin"), EMPTY_CONTEXT),
      InputCollisionError
    );
    assert.equal(h.transport.mutationCount, 1);
  });

  it("a newer authentication/visibility failure invalidates an older continuation basis", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const first = await h.service.commit("stale-auth", githubInput("write"), EMPTY_CONTEXT);
    assert.equal(first.resolution.control.continuation, "allowed");
    h.transport.forceStatus = 403;
    const later = await h.runtime.reconcile(first.action.action_id);
    assert.equal(later.effect.state, "unprovable");
    assert.equal(later.control.continuation, "blocked");
  });

  it("rate-limited observation holds with bounded Retry-After and never redispatches", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const first = await h.service.commit("rate-limited-read", githubInput("write"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "satisfied_unattributed");
    h.transport.forceStatus = 429;
    h.transport.forceHeaders = { "retry-after": "120", "x-ratelimit-remaining": "0" };
    const limited = await h.runtime.reconcile(first.action.action_id);
    assert.equal(limited.effect.state, "pending");
    assert.equal(limited.control.primary, "hold");
    assert.equal(limited.control.retry, "forbidden");
    assert.equal(limited.control.continuation, "blocked");
    assert.ok(limited.control.next_check_at);
    const wait = new Date(limited.control.next_check_at!).getTime() -
      new Date(limited.trust.resolved_at).getTime();
    assert.ok(wait >= 1_000 && wait <= 5 * 60_000);
    assert.equal(h.transport.mutationCount, 1);
  });

  it("has durable action, hash, spec, plan, credential reference, operation, and API version before mutation", async () => {
    const h = makeGitHubHarness({ role: "read" });
    let inspected = false;
    h.transport.beforeMutation = async () => {
      const action = await h.store.actions.findByIdentity(
        "github.repository_permission_change",
        "persist-before-github-write"
      );
      assert.ok(action);
      assert.match(action.input_hash, /^sha256:/);
      assert.equal(action.spec_version, "github.repository_permission_change/1.0.0");
      assert.equal(action.context.credential_ref, "env:NYST_GITHUB_TOKEN");
      assert.equal(action.dispatch_plan?.provider, "github");
      assert.equal(action.dispatch_plan?.operation, "set_permission");
      assert.equal(action.dispatch_plan?.api_version, "2026-03-10");
      inspected = true;
    };
    await h.service.commit("persist-before-github-write", githubInput("write"), EMPTY_CONTEXT);
    assert.equal(inspected, true);
    assert.equal(h.transport.mutationCount, 1);
  });

  it("does not mistake an invitation-shaped 201 race for effective access", async () => {
    const h = makeGitHubHarness({ role: "read" });
    h.transport.successfulResponseWithoutEffect = true;
    h.transport.mutationStatus = 201;
    h.transport.beforeMutation = () => { h.transport.organizationMember = false; };
    const result = await h.service.commit("invitation-race", githubInput("write"), EMPTY_CONTEXT);
    assert.notEqual(result.resolution.effect.state, "verified");
    assert.equal(result.resolution.effect.state, "unprovable");
    assert.equal(result.resolution.control.retry, "forbidden");
    assert.equal(result.resolution.control.continuation, "blocked");
    const evidence = await h.store.evidence.listForAction(result.action.action_id);
    assert.ok(evidence.some((item) =>
      (item.payload as { invitation_created?: boolean }).invitation_created === true
    ));
  });

  it("does not infer truth or allow retry from provider mutation error responses", async () => {
    for (const status of [401, 403, 409, 422, 429, 500, 502, 503]) {
      const h = makeGitHubHarness({ role: "read" });
      h.transport.mutationStatus = status;
      h.transport.successfulResponseWithoutEffect = true;
      const result = await h.service.commit(`mutation-error-${status}`, githubInput("write"), EMPTY_CONTEXT);
      assert.equal(result.resolution.effect.state, "pending");
      assert.equal(result.resolution.control.retry, "forbidden");
      assert.equal(result.resolution.control.continuation, "blocked");
      assert.equal(h.transport.mutationCount, 1);
    }
  });
});
