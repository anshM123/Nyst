import type { ClockAttestor } from "../../core/clock.js";
import type { SendCertainty } from "../../runtime/provider.js";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_EFFECT_NAME = "github.repository_permission_change";
export const GITHUB_SPEC_VERSION = `${GITHUB_EFFECT_NAME}/1.0.0`;

export const GITHUB_PERMISSIONS = [
  "none",
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
] as const;
export type GitHubPermission = (typeof GITHUB_PERMISSIONS)[number];
export type GitHubMutationPermission = "pull" | "triage" | "push" | "maintain" | "admin";
export type GitHubOperation = "observe_only" | "set_permission" | "remove_collaborator";

export interface GitHubPublicPermissionInput {
  owner: string;
  repository: string;
  principal: string;
  desired_permission: GitHubPermission;
  credential_ref: string;
}

export interface GitHubResolvedPermissionInput {
  owner: string;
  owner_id: string;
  repository: string;
  repository_id: string;
  repository_node_id: string;
  repository_private: true;
  principal_login: string;
  principal_id: string;
  principal_node_id: string;
  desired_permission: GitHubPermission;
  mutation_permission: GitHubMutationPermission | "none";
  credential_ref: string;
  operation: GitHubOperation;
  preflight_role_name: string;
  preflight_direct: boolean;
  organization_member: true;
  consistency_deadline: string;
}

export interface GitHubRepositoryIdentity {
  owner: string;
  owner_id: string;
  name: string;
  id: string;
  node_id: string;
  private: boolean;
}

export interface GitHubPrincipalIdentity {
  login: string;
  id: string;
  node_id: string;
}

export interface GitHubDirectCollaborator extends GitHubPrincipalIdentity {
  role_name: string;
}

export interface GitHubRepositoryInvitation {
  id: string;
  invitee_id: string | null;
  invitee_login: string | null;
  permission: string;
}

export interface GitHubPermissionObservation {
  status: "present" | "absent";
  permission: "admin" | "write" | "read" | "none";
  role_name: string;
  user: GitHubPrincipalIdentity | null;
}

export interface GitHubSafeHeaders {
  request_id: string | null;
  retry_after: string | null;
  rate_limit_remaining: string | null;
  rate_limit_reset: string | null;
}

export interface GitHubApiResponse<T> {
  status: number;
  data: T | null;
  headers: GitHubSafeHeaders;
}

export interface GitHubHttpRequest {
  method: "GET" | "PUT" | "DELETE";
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string | null;
  timeout_ms: number;
}

export interface GitHubHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

export interface GitHubTransport {
  send(request: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

export interface GitHubCredentialSource {
  resolve(reference: string): Promise<string>;
}

export class EnvironmentGitHubCredentialSource implements GitHubCredentialSource {
  async resolve(reference: string): Promise<string> {
    if (reference !== "env:NYST_GITHUB_TOKEN") {
      throw new GitHubCredentialError("Unsupported GitHub credential reference");
    }
    const token = process.env.NYST_GITHUB_TOKEN;
    if (!token) throw new GitHubCredentialError("GitHub credential is unavailable");
    return token;
  }
}

export class GitHubCredentialError extends Error {
  override name = "GitHubCredentialError";
}

export class GitHubTransportError extends Error {
  override name = "GitHubTransportError";
  constructor(
    message: string,
    public readonly send_certainty: SendCertainty
  ) {
    super(message);
  }
}

export class GitHubContractError extends Error {
  override name = "GitHubContractError";
}

export class GitHubPreconditionError extends Error {
  override name = "GitHubPreconditionError";
}

export class GitHubObservationError extends GitHubPreconditionError {
  override name = "GitHubObservationError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers: GitHubSafeHeaders,
    public readonly category: "rate_limited" | "authentication_or_visibility" | "provider_rejection"
  ) {
    super(message);
  }
}

export interface GitHubClientOptions {
  transport?: GitHubTransport;
  timeout_ms?: number;
  max_response_bytes?: number;
  clock: ClockAttestor;
}

export function mutationPermission(permission: GitHubPermission): GitHubMutationPermission | "none" {
  switch (permission) {
    case "none": return "none";
    case "read": return "pull";
    case "triage": return "triage";
    case "write": return "push";
    case "maintain": return "maintain";
    case "admin": return "admin";
  }
}

export function isStandardRoleName(value: string): value is GitHubPermission {
  return (GITHUB_PERMISSIONS as readonly string[]).includes(value);
}

export function effectiveRoleMatches(observed: string, desired: GitHubPermission): boolean {
  return observed === desired;
}
