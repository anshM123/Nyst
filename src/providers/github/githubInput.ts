import { bool, en, lit, obj, opt, str, type Schema } from "../../core/validate.js";
import {
  GITHUB_PERMISSIONS,
  type GitHubPublicPermissionInput,
  type GitHubResolvedPermissionInput,
} from "./types.js";

const OWNER_OR_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const DIGITS = /^\d+$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * A reference NAMES a secret and is never one. Same four schemes the
 * SecretProvider accepts, including `tenant:` for a credential the customer
 * supplied through the UI.
 */
const CREDENTIAL_REFERENCE = /^(?:env|vault|secret-manager|tenant):[A-Za-z0-9_./:-]{3,280}$/;

const PublicInputSchema: Schema<GitHubPublicPermissionInput> = obj({
  owner: str({ min: 1, max: 39, pattern: OWNER_OR_LOGIN }),
  repository: str({ min: 1, max: 100, pattern: REPOSITORY }),
  principal: str({ min: 1, max: 39, pattern: OWNER_OR_LOGIN }),
  desired_permission: en(GITHUB_PERMISSIONS),
  // Optional, and pinned to no particular deployment. See the type for why.
  credential_ref: opt(str({ min: 5, max: 300, pattern: CREDENTIAL_REFERENCE })),
});

export const GitHubResolvedInputSchema: Schema<GitHubResolvedPermissionInput> = obj({
  owner: str({ min: 1, max: 39, pattern: OWNER_OR_LOGIN }),
  owner_id: str({ min: 1, max: 30, pattern: DIGITS }),
  repository: str({ min: 1, max: 100, pattern: REPOSITORY }),
  repository_id: str({ min: 1, max: 30, pattern: DIGITS }),
  repository_node_id: str({ min: 1, max: 500 }),
  repository_private: lit(true),
  principal_login: str({ min: 1, max: 39, pattern: OWNER_OR_LOGIN }),
  principal_id: str({ min: 1, max: 30, pattern: DIGITS }),
  principal_node_id: str({ min: 1, max: 500 }),
  desired_permission: en(GITHUB_PERMISSIONS),
  mutation_permission: en(["none", "pull", "triage", "push", "maintain", "admin"] as const),
  // Resolved by the service from the tenant's own connection. Any legal
  // reference, never one deployment's environment variable.
  credential_ref: str({ min: 5, max: 300, pattern: CREDENTIAL_REFERENCE }),
  operation: en(["observe_only", "set_permission", "remove_collaborator"] as const),
  preflight_role_name: str({ min: 1, max: 200 }),
  preflight_direct: bool(),
  organization_member: lit(true),
  consistency_deadline: str({ min: 20, max: 40, pattern: ISO_TIMESTAMP }),
});

export function parseResolvedGitHubInput(value: unknown): GitHubResolvedPermissionInput {
  return GitHubResolvedInputSchema.parse(value);
}

export function normalizePublicGitHubInput(value: unknown): GitHubPublicPermissionInput {
  const parsed = PublicInputSchema.parse(value);
  return {
    owner: parsed.owner.toLowerCase(),
    repository: parsed.repository.toLowerCase(),
    principal: parsed.principal.toLowerCase(),
    desired_permission: parsed.desired_permission,
    // Absent is the normal case: the tenant's configured connection decides.
    ...(parsed.credential_ref === undefined ? {} : { credential_ref: parsed.credential_ref }),
  };
}
