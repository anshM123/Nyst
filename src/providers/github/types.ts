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
  /**
   * OPTIONAL since v0.3.3, and normally omitted.
   *
   * This used to be required AND pinned to the literal `env:NYST_GITHUB_TOKEN`,
   * which meant a caller had to name the OPERATOR's environment variable in
   * every action payload. A customer whose credential lives under their own
   * tenant reference could reach `Ready` and still have every dispatch refused
   * at input validation — the seventh appearance of this same defect.
   *
   * The tenant's configured connection is the authority. When this is supplied
   * it must MATCH that connection, which keeps it useful as an explicit
   * assertion about which credential the caller believes is in play.
   */
  credential_ref?: string;
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
  /**
   * `X-OAuth-Scopes` — what GitHub says this credential is allowed to do.
   *
   * The provider's OWN statement about the token, which is the only way a
   * read-only preflight can learn about a WRITE capability: proving one by
   * performing a write is exactly what invariant I20 forbids. A capability
   * learned here is therefore AUTHORIZED, never VERIFIED.
   *
   * Absent for fine-grained tokens, which do not return this header. Absence
   * means "not stated", never "not granted".
   */
  oauth_scopes?: string | null;
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

/**
 * The credential could not be resolved, or is malformed.
 *
 * A CONFIGURATION fact rather than a crash, so it carries 503 — the operator
 * is told what is missing instead of being shown "internal_error" for
 * something they could fix in a minute.
 */
export class GitHubCredentialError extends Error {
  override name = "GitHubCredentialError";
  readonly statusCode = 503;
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

/**
 * A DELIBERATE REFUSAL, and it must not read as a crash (v0.3.3).
 *
 * Every one of these is Nyst declining to act because a precondition it
 * requires is not true: the person is not a direct collaborator, the
 * repository is not private, a role-setting PUT would create an invitation.
 * They are the most informative thing the provider layer produces.
 *
 * None of them carried a `statusCode`, so the error handler — which surfaces a
 * message only for statuses NYST SET ITSELF — collapsed all of them to 500
 * `internal_error`. The operator was shown a crash for a decision, and the
 * sentence explaining exactly which precondition failed was discarded.
 *
 * Third time this exact shape has appeared in one release: 503s collapsing,
 * provider refusals collapsing, and the classify() word-match ordering. A
 * refusal is a first-class result in this product, and a refusal that arrives
 * as "internal_error" is indistinguishable from a bug.
 *
 * 409 CONFLICT: the request is well-formed and the world is not in a state
 * where Nyst is willing to perform it.
 */
export class GitHubPreconditionError extends Error {
  override name = "GitHubPreconditionError";
  readonly statusCode = 409;
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
