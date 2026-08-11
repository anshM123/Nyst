/**
 * Bounded, reversible Gate-3 canary for a dedicated disposable GitHub fixture.
 * It never prints or persists the token. Required environment variables:
 * DATABASE_URL and NYST_GITHUB_TOKEN. Non-secret fixture identity defaults to
 * nyst-ai-outcomes/nyst-permission-fixture and may be overridden with
 * NYST_GITHUB_OWNER, NYST_GITHUB_REPOSITORY, NYST_GITHUB_PRINCIPAL,
 * NYST_GITHUB_BASELINE_PERMISSION, NYST_GITHUB_TEST_PERMISSION.
 */
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { verifyResolution } from "../dist/src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../dist/src/model/metadata.js";
import { GitHubRestClient } from "../dist/src/providers/github/githubClient.js";
import { GitHubRepositoryPermissionProvider } from "../dist/src/providers/github/githubProvider.js";
import { GitHubRepositoryPermissionService } from "../dist/src/providers/github/githubService.js";
import { createGitHubRepositoryPermissionSpec } from "../dist/src/providers/github/githubSpec.js";
import { readGitHubPermissionSnapshot } from "../dist/src/providers/github/githubSnapshot.js";
import {
  EnvironmentGitHubCredentialSource,
  GITHUB_PERMISSIONS,
  type GitHubPermission,
} from "../dist/src/providers/github/types.js";
import { NystRuntime } from "../dist/src/runtime/nystRuntime.js";
import { EffectRegistry } from "../dist/src/runtime/registry.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";

const databaseUrl = required("DATABASE_URL");
const owner = process.env.NYST_GITHUB_OWNER ?? "nyst-ai-outcomes";
const repository = process.env.NYST_GITHUB_REPOSITORY ?? "nyst-permission-fixture";
const principal = process.env.NYST_GITHUB_PRINCIPAL ?? "chikookutti-cyber";
const baseline = permission("NYST_GITHUB_BASELINE_PERMISSION");
const testRole = permission("NYST_GITHUB_TEST_PERMISSION");
if (baseline === "none" || testRole === "none" || baseline === testRole) {
  throw new Error("Live canary requires two different non-none roles so cleanup never creates an invitation");
}

const credential_ref = "env:NYST_GITHUB_TOKEN";
const clock = new LocalSystemClock();
const client = new GitHubRestClient(new EnvironmentGitHubCredentialSource(), { clock });
const store = await createPostgresStore(databaseUrl);
const registry = new EffectRegistry();
registry.register(createGitHubRepositoryPermissionSpec());
const signer = Ed25519Signer.ephemeral("gate3-live-canary");
const provider = new GitHubRepositoryPermissionProvider(client, clock);
const runtime = new NystRuntime(store, registry, [provider], signer, clock);
const service = new GitHubRepositoryPermissionService(runtime, client, clock);
const input = (desired_permission: GitHubPermission) => ({
  owner,
  repository,
  principal,
  desired_permission,
  credential_ref,
});
const snapshot = () => readGitHubPermissionSnapshot(client, input(baseline));
const runId = new Date().toISOString().replace(/[^0-9]/g, "");

let restored = false;
let mutationAttempted = false;
try {
  const initial = await snapshot();
  assertFixture(initial.permission.role_name === baseline, `fixture role must start at ${baseline}`);
  assertFixture(initial.direct_collaborator !== null, "fixture principal must be a direct collaborator");
  const initialDirect = await client.listDirectCollaborators(owner, repository, credential_ref);
  assertFixture(initialDirect.status === 200 && initialDirect.data !== null, "initial collaborator inventory failed");
  const initialInvitations = await client.listRepositoryInvitations(owner, repository, credential_ref);
  assertFixture(initialInvitations.status === 200 && initialInvitations.data !== null, "initial invitation inventory failed");

  mutationAttempted = true;
  const changed = await service.commit(`gate3-live:${runId}:change`, input(testRole), EMPTY_CONTEXT);
  assertFixture(changed.resolution.effect.state === "satisfied_unattributed", "change did not reach exact goal");
  assertFixture(changed.resolution.control.continuation === "allowed", "change did not authorize goal continuation");
  assertFixture(verifyResolution(signer, changed.resolution), "change resolution signature failed");
  const externallyChanged = await snapshot();
  assertFixture(externallyChanged.permission.role_name === testRole, "external read did not confirm test role");

  const restoredResult = await service.commit(`gate3-live:${runId}:restore`, input(baseline), EMPTY_CONTEXT);
  assertFixture(restoredResult.resolution.effect.state === "satisfied_unattributed", "restore did not reach baseline");
  assertFixture(verifyResolution(signer, restoredResult.resolution), "restore resolution signature failed");
  const externalFinal = await snapshot();
  restored = externalFinal.permission.role_name === baseline && externalFinal.direct_collaborator !== null;
  assertFixture(restored, "external final read did not confirm fixture restoration");
  const finalDirect = await client.listDirectCollaborators(owner, repository, credential_ref);
  assertFixture(finalDirect.status === 200 && finalDirect.data !== null, "final collaborator inventory failed");
  assertFixture(
    inventory(initialDirect.data) === inventory(finalDirect.data),
    "direct collaborator inventory changed outside the intended restored role"
  );
  const finalInvitations = await client.listRepositoryInvitations(owner, repository, credential_ref);
  assertFixture(finalInvitations.status === 200 && finalInvitations.data !== null, "final invitation inventory failed");
  assertFixture(
    invitationInventory(initialInvitations.data) === invitationInventory(finalInvitations.data),
    "repository invitation inventory changed during the canary"
  );

  console.log(JSON.stringify({
    gate: 3,
    live: true,
    api: "github.com",
    repository_id: initial.repository.id,
    principal_id: initial.principal.id,
    transitions: [`${baseline}->${testRole}`, `${testRole}->${baseline}`],
    writes: 2,
    final_role: externalFinal.permission.role_name,
    fixture_restored: restored,
    collaborator_inventory_restored: true,
    invitation_inventory_unchanged: true,
    resolutions_signed: true,
  }));
} finally {
  if (mutationAttempted && !restored) {
    try {
      const current = await snapshot();
      if (current.permission.role_name !== baseline) {
        assertFixture(current.direct_collaborator !== null, "cleanup refused: direct collaborator relationship disappeared");
        const response = await client.setPermission(
          current.repository.owner,
          current.repository.name,
          current.principal.login,
          mutationValue(baseline),
          credential_ref
        );
        assertFixture(response.status === 204, `cleanup write returned HTTP ${response.status}`);
      }
      const final = await snapshot();
      restored = final.permission.role_name === baseline && final.direct_collaborator !== null;
      if (!restored) console.error("GATE3_LIVE_CLEANUP_FAILED");
    } catch {
      console.error("GATE3_LIVE_CLEANUP_FAILED");
    }
  }
  await store.close();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function permission(name: string): GitHubPermission {
  const value = required(name);
  if (!(GITHUB_PERMISSIONS as readonly string[]).includes(value)) {
    throw new Error(`${name} must be a standard GitHub permission`);
  }
  return value as GitHubPermission;
}

function mutationValue(value: Exclude<GitHubPermission, "none">) {
  switch (value) {
    case "read": return "pull" as const;
    case "triage": return "triage" as const;
    case "write": return "push" as const;
    case "maintain": return "maintain" as const;
    case "admin": return "admin" as const;
  }
}

function assertFixture(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inventory(items: Array<{ id: string; role_name: string }>): string {
  return JSON.stringify(items.map((item) => [item.id, item.role_name]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
}

function invitationInventory(items: Array<{ id: string; invitee_id: string | null; permission: string }>): string {
  return JSON.stringify(items.map((item) => [item.id, item.invitee_id, item.permission]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
}
