import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { normalizePublicGitHubInput } from "../src/providers/github/githubInput.js";
import {
  GITHUB_API_VERSION,
  GITHUB_EFFECT_NAME,
  GitHubPreconditionError,
  mutationPermission,
} from "../src/providers/github/types.js";
import { githubInput, makeGitHubHarness, TEST_GITHUB_TOKEN } from "./githubHelpers.js";

describe("Gate 3 GitHub provider contract", () => {
  it("pins the current API/effect version and centralizes every role mapping", () => {
    assert.equal(GITHUB_API_VERSION, "2026-03-10");
    assert.equal(GITHUB_EFFECT_NAME, "github.repository_permission_change");
    assert.deepEqual(
      ["none", "read", "triage", "write", "maintain", "admin"].map((role) =>
        mutationPermission(role as Parameters<typeof mutationPermission>[0])
      ),
      ["none", "pull", "triage", "push", "maintain", "admin"]
    );
  });

  it("normalizes case and rejects path/host injection-shaped input", () => {
    assert.deepEqual(normalizePublicGitHubInput(githubInput()), {
      owner: "acme",
      repository: "sandbox",
      principal: "alice",
      desired_permission: "write",
      credential_ref: "env:NYST_GITHUB_TOKEN",
    });
    for (const bad of [
      { ...githubInput(), owner: "acme/evil" },
      { ...githubInput(), repository: "../secrets" },
      { ...githubInput(), principal: "alice?x=1" },
      { ...githubInput(), credential_ref: "https://evil.example/token" },
      { ...githubInput(), token: TEST_GITHUB_TOKEN },
    ]) {
      assert.throws(() => normalizePublicGitHubInput(bad));
    }
  });

  it("fails before consequence for public repos, non-members, missing direct grants, and custom roles", async () => {
    const cases = [
      makeGitHubHarness({ private_repository: false }),
      makeGitHubHarness({ organization_member: false }),
      makeGitHubHarness({ direct: false, role: "read" }),
      makeGitHubHarness({ role: "security-reviewer" }),
    ];
    for (let index = 0; index < cases.length; index++) {
      const h = cases[index]!;
      await assert.rejects(
        () => h.service.commit(`precondition-${index}`, githubInput("write"), EMPTY_CONTEXT),
        GitHubPreconditionError
      );
      assert.equal(h.transport.mutationCount, 0);
      assert.equal(await h.store.actions.findByIdentity(GITHUB_EFFECT_NAME, `precondition-${index}`), null);
    }
  });

  it("persists stable provider identity and credential reference, never the token", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const result = await h.service.commit("plan-and-secret", githubInput("write"), EMPTY_CONTEXT);
    const serialized = JSON.stringify({
      action: result.action,
      evidence: await h.store.evidence.listForAction(result.action.action_id),
      resolution: result.resolution,
    });
    assert.equal(serialized.includes(TEST_GITHUB_TOKEN), false);
    assert.equal(result.action.context.credential_ref, "env:NYST_GITHUB_TOKEN");
    assert.equal(result.action.dispatch_plan?.provider, "github");
    assert.equal(result.action.dispatch_plan?.api_version, GITHUB_API_VERSION);
    assert.equal(result.action.dispatch_plan?.credential_ref, "env:NYST_GITHUB_TOKEN");
    assert.deepEqual(
      result.action.dispatch_plan?.target,
      {
        owner: "acme",
        owner_id: "10",
        repository: "sandbox",
        repository_id: "20",
        repository_node_id: "R_repo20",
        principal_login: "alice",
        principal_id: "30",
        principal_node_id: "U_user30",
        desired_permission: "write",
        mutation_permission: "push",
        organization_member: true,
        consistency_deadline: (result.action.input as { consistency_deadline: string }).consistency_deadline,
      }
    );
  });

  it("keeps exact role_name semantics distinct for all standard GitHub roles", async () => {
    for (const role of ["read", "triage", "write", "maintain", "admin"] as const) {
      const h = makeGitHubHarness({ role });
      const result = await h.service.commit(`exact-role-${role}`, githubInput(role), EMPTY_CONTEXT);
      assert.equal(result.resolution.effect.state, "satisfied_unattributed");
      assert.equal(h.transport.mutationCount, 0);
      assert.equal((result.action.input as { preflight_role_name: string }).preflight_role_name, role);
    }
  });

  it("rejects custom direct roles, inconsistent base roles, and switched principal identities", async () => {
    const custom = makeGitHubHarness({ role: "read", direct_role: "security-reviewer" });
    await assert.rejects(
      () => custom.service.commit("custom-direct", githubInput("write"), EMPTY_CONTEXT),
      GitHubPreconditionError
    );

    const inconsistent = makeGitHubHarness({ role: "maintain" });
    inconsistent.transport.permissionBaseOverride = "read";
    await assert.rejects(
      () => inconsistent.service.commit("inconsistent-role", githubInput("write"), EMPTY_CONTEXT),
      /permission and role_name were inconsistent/
    );

    const switched = makeGitHubHarness({ role: "read" });
    switched.transport.permissionPrincipalOverride = {
      login: "Alice",
      id: 31,
      node_id: "U_other31",
      type: "User",
    };
    await assert.rejects(
      () => switched.service.commit("switched-principal", githubInput("write"), EMPTY_CONTEXT),
      /switched principal identity/
    );
    assert.equal(custom.transport.mutationCount + inconsistent.transport.mutationCount + switched.transport.mutationCount, 0);
  });

  it("treats representative provider errors as precondition failures, never absence truth", async () => {
    for (const status of [401, 403, 404, 409, 422, 429, 500, 502, 503]) {
      const h = makeGitHubHarness({ role: "read" });
      h.transport.forceStatus = status;
      await assert.rejects(
        () => h.service.commit(`provider-error-${status}`, githubInput("write"), EMPTY_CONTEXT),
        GitHubPreconditionError
      );
      assert.equal(h.transport.mutationCount, 0);
      assert.equal(await h.store.actions.findByIdentity(GITHUB_EFFECT_NAME, `provider-error-${status}`), null);
    }
  });
});
