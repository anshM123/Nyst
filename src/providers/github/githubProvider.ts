import { canonicalHash, canonicalJson } from "../../core/canonical.js";
import type { ClockAttestor } from "../../core/clock.js";
import type { ActionRecord, DispatchPlan } from "../../model/action.js";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from "../../model/evidence.js";
import type { DispatchResult, ProviderAdapter } from "../../runtime/provider.js";
import type { NewEvidence } from "../../store/store.js";
import { GitHubRestClient } from "./githubClient.js";
import { parseResolvedGitHubInput } from "./githubInput.js";
import { readGitHubPermissionSnapshot, type GitHubPermissionSnapshot } from "./githubSnapshot.js";
import {
  GITHUB_API_VERSION,
  GITHUB_EFFECT_NAME,
  GitHubContractError,
  GitHubObservationError,
  GitHubTransportError,
  effectiveRoleMatches,
  type GitHubResolvedPermissionInput,
  type GitHubSafeHeaders,
} from "./types.js";

export class GitHubRepositoryPermissionProvider implements ProviderAdapter {
  readonly effect_name = GITHUB_EFFECT_NAME;

  constructor(
    private readonly client: GitHubRestClient,
    private readonly clock: ClockAttestor
  ) {}

  async dispatch(
    action: ActionRecord,
    plan: DispatchPlan,
    onMutation?: (() => void | Promise<void>) | undefined
  ): Promise<DispatchResult> {
    const input = parseResolvedGitHubInput(action.input);
    this.assertPlan(action, plan, input);
    let snapshot: GitHubPermissionSnapshot;
    try {
      snapshot = await this.snapshot(input);
    } catch (error) {
      return this.failureResult(action, error, "pre_dispatch_revalidation");
    }
    const goalPresent = this.goalMatches(input, snapshot);
    if (input.operation === "observe_only" || goalPresent) {
      return { send_certainty: "sent", evidence: [this.snapshotEvidence(action, input, snapshot, false)] };
    }
    if (!snapshot.direct_collaborator || !snapshot.organization_member) {
      return {
        send_certainty: "definitely_not_sent",
        evidence: [this.transportEvidence(action, "precondition_changed_before_send", "definitely_not_sent")],
      };
    }

    let response;
    try {
      response = input.operation === "remove_collaborator"
        ? await this.client.removeCollaborator(
            input.owner, input.repository, input.principal_login, input.credential_ref
          )
        : await this.client.setPermission(
            input.owner,
            input.repository,
            input.principal_login,
            input.mutation_permission === "none"
              ? (() => { throw new GitHubContractError("Persisted set operation has no mutation permission"); })()
              : input.mutation_permission,
            input.credential_ref
          );
    } catch (error) {
      return this.failureResult(action, error, "mutation_transport");
    }
    // Runtime consequence-boundary hooks (including injected process crashes)
    // are deliberately outside the provider transport catch. Swallowing one
    // would misclassify a crash after a real write as an ordinary response.
    if (response.status === 204 || response.status === 201) await onMutation?.();
    return {
      send_certainty: "sent",
      evidence: [this.responseEvidence(action, input, response.status, response.headers)],
    };
  }

  async observe(
    action: ActionRecord,
    plan: DispatchPlan,
    priorEvidence: readonly EvidenceRecord[] = []
  ): Promise<NewEvidence[]> {
    const input = parseResolvedGitHubInput(action.input);
    this.assertPlan(action, plan, input);
    let snapshot: GitHubPermissionSnapshot;
    try {
      snapshot = await this.snapshot(input);
    } catch (error) {
      if (error instanceof GitHubObservationError) {
        return [this.observationFailureEvidence(action, error)];
      }
      throw error;
    }
    const provenNotSent = priorEvidence.some((item) => {
      if (item.source !== "nyst.dispatch-boundary" || !item.payload || typeof item.payload !== "object") {
        return false;
      }
      return (item.payload as { send_certainty?: unknown }).send_certainty === "definitely_not_sent";
    });
    const evidence = this.snapshotEvidence(action, input, snapshot, provenNotSent);
    const priorSnapshots = priorEvidence.filter((item) =>
      item.source === "github.repository-permission" &&
      payloadType(item.payload) === "github_permission_snapshot"
    );
    const previous = priorSnapshots.at(-1);
    if (previous && previous.provider_event_id !== evidence.provider_event_id) {
      evidence.supersedes_evidence_id = previous.evidence_id;
    }
    return [evidence];
  }

  private async snapshot(input: GitHubResolvedPermissionInput): Promise<GitHubPermissionSnapshot> {
    return readGitHubPermissionSnapshot(
      this.client,
      {
        owner: input.owner,
        repository: input.repository,
        principal: input.principal_login,
        credential_ref: input.credential_ref,
      },
      input
    );
  }

  private goalMatches(input: GitHubResolvedPermissionInput, snapshot: GitHubPermissionSnapshot): boolean {
    return effectiveRoleMatches(snapshot.permission.role_name, input.desired_permission) &&
      (input.desired_permission === "none"
        ? snapshot.direct_collaborator === null
        : snapshot.direct_collaborator !== null);
  }

  private snapshotEvidence(
    action: ActionRecord,
    input: GitHubResolvedPermissionInput,
    snapshot: GitHubPermissionSnapshot,
    forceWindowElapsed: boolean
  ): NewEvidence {
    const now = this.clock.now();
    const goalMatches = this.goalMatches(input, snapshot);
    const windowElapsed = forceWindowElapsed ||
      new Date(now.timestamp).getTime() >= new Date(input.consistency_deadline).getTime();
    const payload = {
      type: "github_permission_snapshot",
      repository_id: snapshot.repository.id,
      repository_node_id: snapshot.repository.node_id,
      principal_id: snapshot.principal.id,
      principal_node_id: snapshot.principal.node_id,
      desired_permission: input.desired_permission,
      observed_permission: snapshot.permission.permission,
      observed_role_name: snapshot.permission.role_name,
      direct_collaborator: snapshot.direct_collaborator !== null,
      organization_member: true,
      repository_private: true,
      identity_verified: true,
      goal_matches: goalMatches,
      consistency_window_elapsed: windowElapsed,
      request_id: snapshot.permission_headers.request_id,
    };
    // Provider request IDs identify HTTP exchanges, not changes in repository
    // permission truth.  Keep them as audit metadata, but deduplicate snapshots
    // by the material fact so repeated reconciliation cannot manufacture weight.
    const materialFact = {
      ...payload,
      request_id: undefined,
    };
    return this.base(action, {
      kind: goalMatches ? "provider_read" : windowElapsed ? "absence_probe" : "provider_read",
      strength: goalMatches || windowElapsed ? "authoritative" : "circumstantial",
      verification_method: goalMatches || !windowElapsed ? "provider_read_back" : "absence_window_probe",
      observed_disposition: goalMatches ? "effect_present" : windowElapsed ? "effect_absent" : "indeterminate",
      attribution: goalMatches ? "unattributed" : "indeterminate",
      provider_object_id: `github:repository:${input.repository_id}:principal:${input.principal_id}`,
      provider_event_id: `github:snapshot:${canonicalHash(materialFact)}`,
      payload,
    });
  }

  private responseEvidence(
    action: ActionRecord,
    input: GitHubResolvedPermissionInput,
    status: number,
    headers: GitHubSafeHeaders
  ): NewEvidence {
    return this.base(action, {
      kind: "provider_response",
      strength: "corroborative",
      verification_method: "response_inspection",
      observed_disposition: "indeterminate",
      attribution: "indeterminate",
      provider_object_id: `github:repository:${input.repository_id}:principal:${input.principal_id}`,
      provider_event_id: `github:mutation:${headers.request_id ?? `${action.action_id}:${status}`}`,
      payload: {
        type: "github_mutation_response",
        http_status: status,
        request_id: headers.request_id,
        operation: input.operation,
        invitation_created: status === 201,
        supported_existing_collaborator_response: status === 204,
      },
    });
  }

  private failureResult(action: ActionRecord, error: unknown, stage: string): DispatchResult {
    const certainty = error instanceof GitHubTransportError
      ? error.send_certainty
      : "definitely_not_sent";
    return {
      send_certainty: certainty,
      evidence: [this.transportEvidence(action, stage, certainty)],
    };
  }

  private transportEvidence(
    action: ActionRecord,
    category: string,
    certainty: "definitely_not_sent" | "may_have_been_sent" | "sent"
  ): NewEvidence {
    return this.base(action, {
      kind: "transport_error",
      strength: "transport_only",
      verification_method: "none",
      observed_disposition: "indeterminate",
      attribution: "indeterminate",
      provider_object_id: null,
      provider_event_id: null,
      payload: { type: "github_transport_failure", category, send_certainty: certainty },
    });
  }

  private observationFailureEvidence(action: ActionRecord, error: GitHubObservationError): NewEvidence {
    const now = this.clock.now();
    const nextCheckAt = boundedNextCheck(now.timestamp, error.headers);
    const payload = {
      type: "github_observation_failure",
      category: error.category,
      http_status: error.status,
      retry_after: error.headers.retry_after,
      rate_limit_remaining: error.headers.rate_limit_remaining,
      rate_limit_reset: error.headers.rate_limit_reset,
      next_check_at: error.category === "rate_limited" ? nextCheckAt : null,
    };
    return this.base(action, {
      kind: "provider_response",
      strength: "corroborative",
      verification_method: "response_inspection",
      observed_disposition: "indeterminate",
      attribution: "indeterminate",
      provider_object_id: null,
      provider_event_id: `github:observation-failure:${canonicalHash(payload)}`,
      payload,
    });
  }

  private base(
    action: ActionRecord,
    over: Pick<
      NewEvidence,
      "kind" | "strength" | "verification_method" | "observed_disposition" |
      "attribution" | "provider_object_id" | "provider_event_id" | "payload"
    >
  ): NewEvidence {
    const now = this.clock.now();
    return {
      action_id: action.action_id,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: "github.repository-permission",
      observed_at: now.timestamp,
      provider_timestamp: null,
      correlation: { method: "nyst_action_id", value: action.action_id },
      signing: null,
      clock: now,
      supersedes_evidence_id: null,
      ...over,
    };
  }

  private assertPlan(
    action: ActionRecord,
    plan: DispatchPlan,
    input: GitHubResolvedPermissionInput
  ): void {
    const expected = {
      correlation: { method: "nyst_action_id", value: action.action_id },
      idempotency_key: null,
      description:
        `GitHub ${input.operation} for repository ${input.repository_id}, principal ${input.principal_id}, effective role ${input.desired_permission}`,
      provider: "github",
      operation: input.operation,
      api_version: GITHUB_API_VERSION,
      credential_ref: input.credential_ref,
      target: {
        owner: input.owner,
        owner_id: input.owner_id,
        repository: input.repository,
        repository_id: input.repository_id,
        repository_node_id: input.repository_node_id,
        principal_login: input.principal_login,
        principal_id: input.principal_id,
        principal_node_id: input.principal_node_id,
        desired_permission: input.desired_permission,
        mutation_permission: input.mutation_permission,
        organization_member: true,
        consistency_deadline: input.consistency_deadline,
      },
    };
    if (canonicalJson(plan) !== canonicalJson(expected)) {
      throw new GitHubContractError("Persisted GitHub DispatchPlan does not match the bound action");
    }
  }
}

function payloadType(value: unknown): string | null {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
    ? (value as { type: string }).type
    : null;
}

function boundedNextCheck(nowIso: string, headers: GitHubSafeHeaders): string {
  const now = new Date(nowIso).getTime();
  const retrySeconds = headers.retry_after !== null && /^\d+$/.test(headers.retry_after)
    ? Number(headers.retry_after)
    : null;
  const resetMs = headers.rate_limit_reset !== null && /^\d+$/.test(headers.rate_limit_reset)
    ? Number(headers.rate_limit_reset) * 1000
    : null;
  const proposed = retrySeconds !== null ? now + retrySeconds * 1000 : resetMs ?? now + 60_000;
  return new Date(Math.min(now + 5 * 60_000, Math.max(now + 60_000, proposed))).toISOString();
}
