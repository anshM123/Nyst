import type { ClockAttestor } from "../../core/clock.js";
import type { ActionContext } from "../../model/metadata.js";
import type { CommitOptions, CommitResult, NystRuntime } from "../../runtime/nystRuntime.js";
import { GitHubRestClient } from "./githubClient.js";
import { normalizePublicGitHubInput } from "./githubInput.js";
import { readGitHubPermissionSnapshot } from "./githubSnapshot.js";
import {
  GITHUB_EFFECT_NAME,
  GitHubPreconditionError,
  effectiveRoleMatches,
  mutationPermission,
  type GitHubOperation,
} from "./types.js";

export class GitHubRepositoryPermissionService {
  constructor(
    private readonly runtime: NystRuntime,
    private readonly client: GitHubRestClient,
    private readonly clock: ClockAttestor
  ) {}

  async commit(
    businessKey: string,
    publicInput: unknown,
    context: ActionContext,
    options: CommitOptions = {}
  ): Promise<CommitResult> {
    const input = normalizePublicGitHubInput(publicInput);
    /**
     * THE TENANT'S CONNECTION IS THE AUTHORITY (v0.3.3).
     *
     * `credential_ref` used to be REQUIRED in the payload and pinned to the
     * literal `env:NYST_GITHUB_TOKEN`, so every caller had to name the
     * operator's environment variable. A customer whose credential lives under
     * their own `tenant:` reference could reach Ready and still have every
     * dispatch refused at input validation.
     *
     * Omitting it is now normal and correct: the connection configured for this
     * environment decides. Supplying it is still allowed and still CHECKED,
     * because "I believe I am acting with credential X" is a useful assertion
     * for a caller to make and a useful one for Nyst to refuse.
     */
    const credentialRef = input.credential_ref ?? context.credential_ref;
    if (credentialRef === null || credentialRef === undefined) {
      throw new GitHubPreconditionError(
        "No GitHub credential is configured for this environment. Connect GitHub on the Integrations page.");
    }
    if (input.credential_ref !== undefined && context.credential_ref !== null
      && context.credential_ref !== input.credential_ref) {
      throw new GitHubPreconditionError("Context credential reference does not match GitHub input");
    }
    const snapshot = await readGitHubPermissionSnapshot(this.client, { ...input, credential_ref: credentialRef });
    const direct = snapshot.direct_collaborator !== null;
    const goalPresent =
      effectiveRoleMatches(snapshot.permission.role_name, input.desired_permission) &&
      (input.desired_permission === "none" ? !direct : direct);
    let operation: GitHubOperation;
    if (goalPresent) operation = "observe_only";
    else if (!direct) {
      throw new GitHubPreconditionError(
        input.desired_permission === "none"
          ? "Direct access is absent but inherited effective access remains"
          : "Refusing a role-setting PUT that could create an invitation"
      );
    } else {
      operation = input.desired_permission === "none" ? "remove_collaborator" : "set_permission";
    }
    const now = this.clock.now();
    const consistencyDeadline = new Date(new Date(now.timestamp).getTime() + 5 * 60_000).toISOString();
    return this.runtime.commit(
      GITHUB_EFFECT_NAME,
      businessKey,
      {
        owner: snapshot.repository.owner.toLowerCase(),
        owner_id: snapshot.repository.owner_id,
        repository: snapshot.repository.name.toLowerCase(),
        repository_id: snapshot.repository.id,
        repository_node_id: snapshot.repository.node_id,
        repository_private: true,
        principal_login: snapshot.principal.login.toLowerCase(),
        principal_id: snapshot.principal.id,
        principal_node_id: snapshot.principal.node_id,
        desired_permission: input.desired_permission,
        mutation_permission: mutationPermission(input.desired_permission),
        credential_ref: credentialRef,
        operation,
        preflight_role_name: snapshot.permission.role_name,
        preflight_direct: direct,
        organization_member: true,
        consistency_deadline: consistencyDeadline,
      },
      { ...context, credential_ref: credentialRef },
      options
    );
  }
}
