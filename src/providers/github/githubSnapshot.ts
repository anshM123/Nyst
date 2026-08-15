import { GitHubRestClient } from "./githubClient.js";
import {
  GitHubContractError,
  GitHubObservationError,
  GitHubPreconditionError,
  isStandardRoleName,
  type GitHubDirectCollaborator,
  type GitHubPermissionObservation,
  type GitHubPrincipalIdentity,
  type GitHubPublicPermissionInput,
  type GitHubRepositoryIdentity,
  type GitHubResolvedPermissionInput,
  type GitHubSafeHeaders,
} from "./types.js";

export interface GitHubPermissionSnapshot {
  repository: GitHubRepositoryIdentity;
  principal: GitHubPrincipalIdentity;
  organization_member: true;
  direct_collaborator: GitHubDirectCollaborator | null;
  permission: GitHubPermissionObservation;
  permission_headers: GitHubSafeHeaders;
}

/**
 * `credential_ref` is REQUIRED here even though it is optional on the public
 * input (v0.3.3). By the time a snapshot is read the caller's omission has been
 * resolved against the tenant's configured connection, and a snapshot with no
 * credential is not a weaker read — it is not a read at all.
 */
type SnapshotIdentity = Pick<
  GitHubPublicPermissionInput,
  "owner" | "repository"
> & { principal: string; credential_ref: string };

export async function readGitHubPermissionSnapshot(
  client: GitHubRestClient,
  identity: SnapshotIdentity,
  expected?: GitHubResolvedPermissionInput
): Promise<GitHubPermissionSnapshot> {
  const organization = await client.getOrganization(identity.owner, identity.credential_ref);
  requireStatus(organization, 200, "organization preflight");
  if (!organization.data) throw new GitHubContractError("GitHub organization response was empty");

  const repository = await client.getRepository(
    identity.owner,
    identity.repository,
    identity.credential_ref
  );
  requireStatus(repository, 200, "repository preflight");
  if (!repository.data) throw new GitHubContractError("GitHub repository response was empty");
  if (!repository.data.private) {
    throw new GitHubPreconditionError("Gate 3 supports private repositories only");
  }
  if (
    repository.data.owner.toLowerCase() !== organization.data.login.toLowerCase() ||
    repository.data.owner_id !== organization.data.id
  ) {
    throw new GitHubContractError("Repository owner identity did not match the organization");
  }

  const principal = await client.getUser(identity.principal, identity.credential_ref);
  requireStatus(principal, 200, "principal preflight");
  if (!principal.data) throw new GitHubContractError("GitHub principal response was empty");

  const membership = await client.checkOrganizationMember(
    repository.data.owner,
    principal.data.login,
    identity.credential_ref
  );
  requireStatus(membership, 204, "organization membership preflight");
  if (membership.data !== true) {
    throw new GitHubPreconditionError("Target principal is not an active organization member");
  }

  const direct = await client.listDirectCollaborators(
    repository.data.owner,
    repository.data.name,
    identity.credential_ref
  );
  requireStatus(direct, 200, "direct collaborator preflight");
  if (!direct.data) throw new GitHubContractError("GitHub direct collaborator response was empty");
  const matches = direct.data.filter((item) => item.id === principal.data!.id);
  if (matches.length > 1) throw new GitHubContractError("GitHub returned duplicate principal identities");
  if (matches[0] && (
    matches[0].node_id !== principal.data.node_id ||
    matches[0].login.toLowerCase() !== principal.data.login.toLowerCase()
  )) {
    throw new GitHubContractError("Direct collaborator observation switched principal identity");
  }
  if (matches[0] && !isStandardRoleName(matches[0].role_name)) {
    throw new GitHubPreconditionError("Custom direct repository roles are unsupported");
  }

  const permission = await client.getPermission(
    repository.data.owner,
    repository.data.name,
    principal.data.login,
    identity.credential_ref
  );
  if (permission.status !== 200 && permission.status !== 404) {
    throw observationError(permission.status, permission.headers, "GitHub permission observation");
  }
  if (!permission.data) throw new GitHubContractError("GitHub permission response was empty");
  if (permission.data.user && (
    permission.data.user.id !== principal.data.id ||
    permission.data.user.node_id !== principal.data.node_id ||
    permission.data.user.login.toLowerCase() !== principal.data.login.toLowerCase()
  )) {
    throw new GitHubContractError("Permission observation switched principal identity");
  }
  const transitionalRemovalRole = expected?.operation === "remove_collaborator" &&
    expected.desired_permission === "none" && permission.data.role_name === "unknown";
  if (!isStandardRoleName(permission.data.role_name) && !transitionalRemovalRole) {
    throw new GitHubPreconditionError("Custom or unknown GitHub repository roles are unsupported");
  }

  if (expected) validateExpected(expected, repository.data, principal.data);
  return {
    repository: repository.data,
    principal: principal.data,
    organization_member: true,
    direct_collaborator: matches[0] ?? null,
    permission: permission.data,
    permission_headers: permission.headers,
  };
}

function requireStatus(
  response: { status: number; headers: GitHubSafeHeaders },
  expected: number,
  label: string
): void {
  if (response.status !== expected) {
    throw observationError(response.status, response.headers, label);
  }
}

function observationError(status: number, headers: GitHubSafeHeaders, label: string): GitHubObservationError {
  const rateLimited = status === 429 ||
    (status === 403 && (headers.retry_after !== null || headers.rate_limit_remaining === "0"));
  const category = rateLimited
    ? "rate_limited"
    : status === 401 || status === 403 || status === 404
      ? "authentication_or_visibility"
      : "provider_rejection";
  return new GitHubObservationError(`${label} failed with HTTP ${status}`, status, headers, category);
}

function validateExpected(
  expected: GitHubResolvedPermissionInput,
  repository: GitHubRepositoryIdentity,
  principal: GitHubPrincipalIdentity
): void {
  if (
    repository.id !== expected.repository_id ||
    repository.node_id !== expected.repository_node_id ||
    repository.owner_id !== expected.owner_id ||
    repository.owner.toLowerCase() !== expected.owner ||
    repository.name.toLowerCase() !== expected.repository
  ) {
    throw new GitHubPreconditionError("Persisted GitHub repository identity no longer matches");
  }
  if (
    principal.id !== expected.principal_id ||
    principal.node_id !== expected.principal_node_id ||
    principal.login.toLowerCase() !== expected.principal_login
  ) {
    throw new GitHubPreconditionError("Persisted GitHub principal identity no longer matches");
  }
}
