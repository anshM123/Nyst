/** Bounded integrated Gate 6 live canary. Both disposable fixtures are restored in finally. */
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { verifyResolution } from "../dist/src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../dist/src/model/metadata.js";
import { OffboardingCoordinator } from "../dist/src/offboarding/offboardingCoordinator.js";
import { GitHubRestClient } from "../dist/src/providers/github/githubClient.js";
import { GitHubRepositoryPermissionProvider } from "../dist/src/providers/github/githubProvider.js";
import { GitHubRepositoryPermissionService } from "../dist/src/providers/github/githubService.js";
import { readGitHubPermissionSnapshot } from "../dist/src/providers/github/githubSnapshot.js";
import { createGitHubRepositoryPermissionSpec } from "../dist/src/providers/github/githubSpec.js";
import { EnvironmentGitHubCredentialSource, mutationPermission } from "../dist/src/providers/github/types.js";
import { OktaRestClient } from "../dist/src/providers/okta/oktaClient.js";
import { OktaUserSuspensionProvider } from "../dist/src/providers/okta/oktaProvider.js";
import { OktaUserSuspensionService } from "../dist/src/providers/okta/oktaService.js";
import { readOktaUserSnapshot } from "../dist/src/providers/okta/oktaSnapshot.js";
import { createOktaUserSuspensionSpec } from "../dist/src/providers/okta/oktaSpec.js";
import { EnvironmentOktaCredentialSource, OKTA_CREDENTIAL_REF } from "../dist/src/providers/okta/types.js";
import { NystRuntime } from "../dist/src/runtime/nystRuntime.js";
import { EffectRegistry } from "../dist/src/runtime/registry.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";

const databaseUrl = required("DATABASE_URL");
const oktaOrg = required("NYST_OKTA_ORG");
const oktaUserId = required("NYST_OKTA_USER_ID");
const owner = process.env.NYST_GITHUB_OWNER ?? "nyst-ai-outcomes";
const repository = process.env.NYST_GITHUB_REPOSITORY ?? "nyst-permission-fixture";
const principal = process.env.NYST_GITHUB_PRINCIPAL ?? "chikookutti-cyber";
const baseline = required("NYST_GITHUB_BASELINE_PERMISSION");
assert(baseline === "read", "Gate 6 live fixture baseline must be exactly read");

const clock = new LocalSystemClock();
const oktaClient = new OktaRestClient(new EnvironmentOktaCredentialSource(), { clock });
const githubClient = new GitHubRestClient(new EnvironmentGitHubCredentialSource(), { clock });
const registry = new EffectRegistry();
registry.register(createOktaUserSuspensionSpec());
registry.register(createGitHubRepositoryPermissionSpec());
const signer = Ed25519Signer.ephemeral("gate6-live-canary");
const store = await createPostgresStore(databaseUrl);
const runtime = new NystRuntime(store, registry, [
  new OktaUserSuspensionProvider(oktaClient, clock),
  new GitHubRepositoryPermissionProvider(githubClient, clock),
], signer, clock);
const oktaService = new OktaUserSuspensionService(runtime, oktaClient, clock);
const githubService = new GitHubRepositoryPermissionService(runtime, githubClient, clock);
const coordinator = new OffboardingCoordinator(store, runtime, oktaService, githubService, clock);
const oktaRef = OKTA_CREDENTIAL_REF;
const githubRef = "env:NYST_GITHUB_TOKEN";
const runId = crypto.randomUUID();
let initialInvitations = "";
let oktaRestored = false;
let githubRestored = false;

const oktaInput = (desired_status: "active" | "suspended") => ({ org: oktaOrg, user_id: oktaUserId, desired_status, credential_ref: oktaRef });
const githubPublic = { owner, repository, principal, desired_permission: "none" as const, credential_ref: githubRef };
const oktaSnapshot = () => readOktaUserSnapshot(oktaClient, { org: oktaOrg, user_id: oktaUserId, credential_ref: oktaRef });
const githubSnapshot = () => readGitHubPermissionSnapshot(githubClient, githubPublic);

try {
  const initialOkta = await oktaSnapshot();
  const initialGitHub = await githubSnapshot();
  assert(initialOkta.user.status === "ACTIVE", "Okta fixture must start ACTIVE");
  assert(initialGitHub.permission.role_name === "read" && initialGitHub.direct_collaborator !== null, "GitHub fixture must start as direct read");
  const invitations = await githubClient.listRepositoryInvitations(owner, repository, githubRef);
  assert(invitations.status === 200 && invitations.data !== null, "Could not read initial invitation inventory");
  initialInvitations = invitationInventory(invitations.data);
  const inherited = await diagnoseInheritedGitHubAccess(owner, repository, principal);
  console.log(JSON.stringify({ github_inherited_access_preflight: inherited }));
  assert(
    (inherited.default_repository_permission === null || inherited.default_repository_permission === "none") &&
      inherited.active_team_access.length === 0 &&
      inherited.organization_role === "member",
    "Unsupported inherited GitHub access topology"
  );

  const liveIntent = {
    business_key: `gate6-live-${runId}`,
    subject: { subject_key: `okta:${oktaUserId}:github:${principal.toLowerCase()}`, display_name: initialOkta.user.login },
    okta: { org: oktaOrg, user_id: oktaUserId, credential_ref: oktaRef },
    github: { owner, repository, principal, baseline_permission: "read", credential_ref: githubRef },
  } as const;
  let view = await coordinator.execute(liveIntent);
  // GitHub collaborator removal is eventually consistent. Re-entering the
  // same immutable run performs observation/reconciliation only: the existing
  // action is recovered and its attempted dispatch can never be resent.
  for (let observation = 0; observation < 2 && view.status !== "complete"; observation++) {
    const blockedStep = view.status === "blocked_okta" ? view.okta :
      view.status === "blocked_github" ? view.github : null;
    if (!blockedStep?.action_id || blockedStep.resolution?.effect.state !== "pending") break;
    const blockedAction = await store.actions.getAction(blockedStep.action_id);
    const consistencyDeadline = (blockedAction?.input as { consistency_deadline?: unknown } | undefined)?.consistency_deadline;
    const scheduled = typeof consistencyDeadline === "string"
      ? consistencyDeadline
      : blockedStep.resolution.control.next_check_at;
    const delay = scheduled
      ? Math.min(305_000, Math.max(1_000, Date.parse(scheduled) - Date.now() + 500))
      : 5_000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    view = await coordinator.execute(liveIntent);
  }
  assert(view.status === "complete", `Integrated run did not complete: ${view.status}`);
  assert(view.okta.resolution && verifyResolution(signer, view.okta.resolution), "Okta receipt signature failed");
  assert(view.github.resolution && verifyResolution(signer, view.github.resolution), "GitHub receipt signature failed");
  const changedOkta = await oktaSnapshot();
  const changedGitHub = await githubSnapshot();
  assert(changedOkta.user.status === "SUSPENDED", "Okta suspension was not independently observed");
  assert(changedGitHub.permission.role_name === "none" && changedGitHub.direct_collaborator === null, "GitHub access removal was not independently observed");

  console.log(JSON.stringify({
    gate: 6,
    live: true,
    run_id: view.run.run_id,
    status: view.status,
    okta_effect_state: view.okta.resolution.effect.state,
    github_effect_state: view.github.resolution.effect.state,
    okta_writes: 1,
    github_writes: 1,
    unsafe_continuations: 0,
    duplicate_unsafe_writes: 0,
    false_completion: 0,
    receipts_signed: true,
  }));
} finally {
  try {
    const current = await oktaSnapshot();
    if (current.user.status === "SUSPENDED") {
      await oktaService.commit(`gate6-live-${runId}:restore-okta`, oktaInput("active"), EMPTY_CONTEXT);
    }
    oktaRestored = (await oktaSnapshot()).user.status === "ACTIVE";
  } catch { oktaRestored = false; }
  try {
    const current = await githubSnapshot();
    if (current.permission.role_name !== "read" || current.direct_collaborator === null) {
      const member = await githubClient.checkOrganizationMember(owner, principal, githubRef);
      assert(member.status === 204 && member.data === true, "Refusing cleanup because principal is not an active org member");
      // `mutationPermission` can return "none", which is a REMOVAL and needs a
      // different GitHub call entirely. It cannot happen for "read"; asserting
      // it keeps that true if the mapping is ever changed underneath us.
      const restorePermission = mutationPermission("read");
      assert(restorePermission !== "none", "read must map to a GitHub mutation permission, not a removal");
      const restore = await githubClient.setPermission(owner, repository, principal, restorePermission, githubRef);
      assert(restore.status === 204, `GitHub cleanup returned HTTP ${restore.status}`);
    }
    const final = await githubSnapshot();
    const invitations = await githubClient.listRepositoryInvitations(owner, repository, githubRef);
    githubRestored = final.permission.role_name === "read" && final.direct_collaborator !== null &&
      invitations.status === 200 && invitations.data !== null && invitationInventory(invitations.data) === initialInvitations;
  } catch { githubRestored = false; }
  console.log(JSON.stringify({ fixture_cleanup: true, okta_final_active: oktaRestored, github_final_read: githubRestored, no_invitation_change: githubRestored }));
  await store.close();
  if (!oktaRestored || !githubRestored) throw new Error("Gate 6 fixture cleanup failed");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function invitationInventory(items: Array<{ id: string; invitee_id: string | null; permission: string }>): string {
  return JSON.stringify(items.map((item) => [item.id, item.invitee_id, item.permission]).sort((a,b) => a[0]!.localeCompare(b[0]!)));
}

async function diagnoseInheritedGitHubAccess(
  organization: string,
  repo: string,
  login: string
): Promise<{
  default_repository_permission: string | null;
  organization_role: string;
  active_team_access: Array<{ slug: string; permission: string }>;
}> {
  const token = required("NYST_GITHUB_TOKEN");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "Nyst-Gate6-Live-Preflight",
  };
  const orgResponse = await fetch(`https://api.github.com/orgs/${encodeURIComponent(organization)}`, { headers, redirect: "error" });
  assert(orgResponse.status === 200, `GitHub org topology read returned HTTP ${orgResponse.status}`);
  const orgBody = await orgResponse.json() as { default_repository_permission?: unknown };
  const defaultPermission = typeof orgBody.default_repository_permission === "string"
    ? orgBody.default_repository_permission
    : null;

  const membershipResponse = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(organization)}/memberships/${encodeURIComponent(login)}`,
    { headers, redirect: "error" }
  );
  assert(membershipResponse.status === 200, `GitHub organization membership read returned HTTP ${membershipResponse.status}`);
  const membershipBody = await membershipResponse.json() as { state?: unknown; role?: unknown };
  assert(membershipBody.state === "active" && typeof membershipBody.role === "string", "GitHub returned an unsupported organization membership");

  const teamsResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(organization)}/${encodeURIComponent(repo)}/teams?per_page=100`,
    { headers, redirect: "error" }
  );
  assert(teamsResponse.status === 200, `GitHub repository team topology read returned HTTP ${teamsResponse.status}`);
  const teams = await teamsResponse.json() as Array<{ slug?: unknown; permission?: unknown }>;
  assert(Array.isArray(teams) && teams.length <= 100, "GitHub returned an unsupported team topology");
  const active: Array<{ slug: string; permission: string }> = [];
  for (const team of teams) {
    if (typeof team.slug !== "string" || typeof team.permission !== "string") {
      throw new Error("GitHub returned a malformed repository team");
    }
    const membership = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(team.slug)}/memberships/${encodeURIComponent(login)}`,
      { headers, redirect: "error" }
    );
    if (membership.status === 404) continue;
    assert(membership.status === 200, `GitHub team membership read returned HTTP ${membership.status}`);
    const body = await membership.json() as { state?: unknown };
    if (body.state === "active") active.push({ slug: team.slug, permission: team.permission });
  }
  return { default_repository_permission: defaultPermission, organization_role: membershipBody.role, active_team_access: active };
}
