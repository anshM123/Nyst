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
    if (context.credential_ref !== null && context.credential_ref !== input.credential_ref) {
      throw new GitHubPreconditionError("Context credential reference does not match GitHub input");
    }
    const snapshot = await readGitHubPermissionSnapshot(this.client, input);
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
        credential_ref: input.credential_ref,
        operation,
        preflight_role_name: snapshot.permission.role_name,
        preflight_direct: direct,
        organization_member: true,
        consistency_deadline: consistencyDeadline,
      },
      { ...context, credential_ref: input.credential_ref },
      options
    );
  }
}
