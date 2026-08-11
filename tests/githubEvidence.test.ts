import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { githubInput, makeGitHubHarness } from "./githubHelpers.js";

describe("Gate 3 GitHub evidence behavior", () => {
  it("deduplicates identical permission facts and reconciliation never writes", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const result = await h.service.commit("dedup-read", githubInput("write"), EMPTY_CONTEXT);
    const before = await h.store.evidence.listForAction(result.action.action_id);
    await h.runtime.reconcile(result.action.action_id);
    await h.runtime.reconcile(result.action.action_id);
    const after = await h.store.evidence.listForAction(result.action.action_id);
    assert.equal(after.length, before.length);
    assert.equal(h.transport.mutationCount, 1);
  });

  it("supersedes an old role snapshot when eventual consistency converges", async () => {
    const h = makeGitHubHarness({ role: "read" });
    h.transport.postMutationReads = ["read", "read", "write"];
    const first = await h.service.commit("eventual", githubInput("write"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "pending");
    const second = await h.runtime.reconcile(first.action.action_id);
    assert.equal(second.effect.state, "pending");
    const third = await h.runtime.reconcile(first.action.action_id);
    assert.equal(third.effect.state, "satisfied_unattributed");
    const evidence = await h.store.evidence.listForAction(first.action.action_id);
    const snapshots = evidence.filter((item) =>
      (item.payload as { type?: string }).type === "github_permission_snapshot"
    );
    assert.ok(snapshots.at(-1)?.supersedes_evidence_id);
    assert.equal(h.transport.mutationCount, 1);
  });

  it("never treats a mutation response itself as verified external truth", async () => {
    const h = makeGitHubHarness({ role: "read" });
    h.transport.successfulResponseWithoutEffect = true;
    const result = await h.service.commit("response-not-truth", githubInput("admin"), EMPTY_CONTEXT);
    const evidence = await h.store.evidence.listForAction(result.action.action_id);
    assert.ok(evidence.some((item) =>
      (item.payload as { type?: string; http_status?: number }).type === "github_mutation_response" &&
      (item.payload as { http_status?: number }).http_status === 204
    ));
    assert.notEqual(result.resolution.effect.state, "verified");
    assert.equal(result.resolution.effect.state, "pending");
  });
});
