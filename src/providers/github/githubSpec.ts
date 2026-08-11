import type { ActionRecord, DispatchPlan } from "../../model/action.js";
import { CONTROL_DECISION_VERSION, type ControlDecision } from "../../model/controlDecision.js";
import type { EvidenceRecord } from "../../model/evidence.js";
import type { EffectAssessment, EffectSpec } from "../../spec/effectSpec.js";
import { GitHubResolvedInputSchema, parseResolvedGitHubInput } from "./githubInput.js";
import {
  GITHUB_API_VERSION,
  GITHUB_EFFECT_NAME,
  GITHUB_SPEC_VERSION,
} from "./types.js";

const POLICY_VERSION = "github-repository-permission-policy/1";

interface SnapshotPayload {
  type: "github_permission_snapshot";
  repository_id: string;
  principal_id: string;
  desired_permission: string;
  observed_role_name: string;
  direct_collaborator: boolean;
  goal_matches: boolean;
  consistency_window_elapsed: boolean;
}

interface ObservationFailurePayload {
  type: "github_observation_failure";
  category: string;
  next_check_at: string | null;
}

export function createGitHubRepositoryPermissionSpec(): EffectSpec {
  return {
    effect_name: GITHUB_EFFECT_NAME,
    schema_version: GITHUB_SPEC_VERSION,
    input_schema: GitHubResolvedInputSchema,
    semantic_fields: ["owner_id", "repository_id", "principal_id", "desired_permission"],
    business_key_semantics:
      "Caller-supplied stable identity for one exact effective permission goal on one stable repository/principal pair.",
    provider_correlation_semantics:
      "The DispatchPlan binds stable GitHub repository/user IDs. GitHub read-back has no action correlation, so goal presence remains unattributed.",
    provider_idempotency_semantics: null,
    evidence_sources: [
      "github_mutation_response",
      "github_permission_snapshot",
      "github_transport_failure",
    ],

    prepareDispatch(action: ActionRecord): DispatchPlan {
      const input = parseResolvedGitHubInput(action.input);
      return {
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
    },

    retry_safe_when_not_applied: true,
    goal_state_sufficient_for_continuation: true,

    assess(action: ActionRecord, evidence: readonly EvidenceRecord[]): EffectAssessment {
      const input = parseResolvedGitHubInput(action.input);
      const active = activeEvidence(evidence);
      const snapshots = active.filter((item) => {
        const payload = snapshotPayload(item.payload);
        return payload !== null &&
          payload.repository_id === input.repository_id &&
          payload.principal_id === input.principal_id &&
          payload.desired_permission === input.desired_permission;
      });
      const latest = snapshots.at(-1);
      const payload = latest ? snapshotPayload(latest.payload) : null;
      const latestActive = active.at(-1);
      const failure = latestActive ? observationFailurePayload(latestActive.payload) : null;
      if (latestActive && failure?.category === "rate_limited" && failure.next_check_at) {
        return {
          ...assessment("pending", [latestActive], false,
            "GitHub observation was rate limited; hold until the bounded provider-informed recheck time."),
          next_check_at: failure.next_check_at,
        };
      }
      if (latestActive && failure) {
        return assessment(
          "unprovable",
          [latestActive],
          false,
          "A current GitHub observation failed authentication, visibility, or provider preconditions."
        );
      }
      if (latest && latestActive && latestActive.seq > latest.seq && latestActive.strength === "transport_only") {
        return assessment(
          "unprovable",
          [],
          false,
          "A newer GitHub observation attempt failed; the older permission snapshot is no longer a current authorization basis."
        );
      }
      if (latest && payload?.goal_matches && latest.observed_disposition === "effect_present") {
        return assessment("satisfied_unattributed", [latest], false,
          "Exact effective GitHub goal is present; GitHub exposes no action-correlated read-back.");
      }
      if (latest && payload && !payload.goal_matches && !payload.consistency_window_elapsed) {
        return assessment("pending", [latest], false,
          "GitHub effective permission may still be converging.");
      }
      if (
        latest && payload && !payload.goal_matches && payload.consistency_window_elapsed &&
        latest.observed_disposition === "effect_absent"
      ) {
        return assessment("not_applied", [latest], false,
          "Bounded post-window observation proves the exact effective goal is absent.");
      }
      const substantive = active.filter((item) => item.strength !== "transport_only");
      return assessment(
        "unprovable",
        substantive.length > 0 ? [substantive.at(-1)!] : [],
        false,
        "GitHub truth or required identity/topology could not be established."
      );
    },

    decide(_action: ActionRecord, assessmentValue: EffectAssessment): ControlDecision {
      switch (assessmentValue.proposed_state) {
        case "satisfied_unattributed":
          return decision("do_not_retry", "forbidden", "allowed", "none",
            "GITHUB.EFFECTIVE_GOAL_SATISFIED", "Exact effective access goal is present; do not repeat the mutation.");
        case "not_applied":
          return decision("retry", "allowed", "blocked", "none",
            "GITHUB.GOAL_PROVEN_ABSENT", "The goal is absent; runtime may retry only if dispatch is also proven unsent.");
        case "pending":
          return {
            ...decision("hold", "forbidden", "blocked", "none",
              "GITHUB.CONSISTENCY_WINDOW_OPEN", "Hold while GitHub permission state may be converging or observation is rate limited."),
            ...(assessmentValue.next_check_at ? { next_check_at: assessmentValue.next_check_at } : {}),
          };
        case "verified":
        case "compensated":
        case "unprovable":
          return decision("escalate", "forbidden", "blocked", "escalate",
            "GITHUB.TRUTH_UNPROVABLE", "GitHub evidence does not justify a safe terminal authorization.");
      }
    },

    compensation: { supported: false, method: null, confirming_evidence: [] },
    escalation_conditions: [
      "authentication or authorization failure",
      "repository or principal identity mismatch",
      "custom role or unsupported topology",
      "contradictory observations",
      "consistency window elapsed without the exact effective goal",
    ],
  };
}

function activeEvidence(evidence: readonly EvidenceRecord[]): EvidenceRecord[] {
  const superseded = new Set(
    evidence.map((item) => item.supersedes_evidence_id).filter((id): id is string => id !== null)
  );
  return evidence.filter((item) => !superseded.has(item.evidence_id));
}

function snapshotPayload(value: unknown): SnapshotPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Partial<SnapshotPayload>;
  return payload.type === "github_permission_snapshot" &&
    typeof payload.repository_id === "string" &&
    typeof payload.principal_id === "string" &&
    typeof payload.desired_permission === "string" &&
    typeof payload.observed_role_name === "string" &&
    typeof payload.direct_collaborator === "boolean" &&
    typeof payload.goal_matches === "boolean" &&
    typeof payload.consistency_window_elapsed === "boolean"
    ? payload as SnapshotPayload
    : null;
}

function observationFailurePayload(value: unknown): ObservationFailurePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Partial<ObservationFailurePayload>;
  return payload.type === "github_observation_failure" &&
    typeof payload.category === "string" &&
    (payload.next_check_at === null || typeof payload.next_check_at === "string")
    ? payload as ObservationFailurePayload
    : null;
}

function assessment(
  proposed_state: EffectAssessment["proposed_state"],
  evidence: EvidenceRecord[],
  attributed: boolean,
  notes: string
): EffectAssessment {
  return {
    proposed_state,
    provider_object_refs: evidence
      .map((item) => item.provider_object_id)
      .filter((id): id is string => id !== null),
    evidence_refs: evidence.map((item) => item.evidence_id),
    verification_methods: [...new Set(evidence.map((item) => item.verification_method))],
    claimed_strength: evidence[0]?.strength ?? "none",
    attribution_established: attributed,
    notes,
  };
}

function decision(
  primary: ControlDecision["primary"],
  retry: ControlDecision["retry"],
  continuation: ControlDecision["continuation"],
  recovery: ControlDecision["recovery"],
  reason_code: string,
  explanation: string
): ControlDecision {
  return {
    decision_version: CONTROL_DECISION_VERSION,
    primary,
    retry,
    continuation,
    recovery,
    reason_code,
    explanation,
    policy_version: POLICY_VERSION,
    spec_version: GITHUB_SPEC_VERSION,
  };
}
