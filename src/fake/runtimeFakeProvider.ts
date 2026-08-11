import type { ClockAttestor } from "../core/clock.js";
import type { ActionRecord, DispatchPlan } from "../model/action.js";
import { EVIDENCE_SCHEMA_VERSION } from "../model/evidence.js";
import type { NewEvidence } from "../store/store.js";
import type {
  CompensationResult,
  DispatchResult,
  ProviderAdapter,
} from "../runtime/provider.js";

export type RuntimeFakeScenario =
  | "definitely_not_sent"
  | "definitely_applied"
  | "definitely_not_applied"
  | "request_may_have_been_sent"
  | "response_lost_after_effect"
  | "only_transport"
  | "provider_read_unavailable"
  | "eventual_consistency"
  | "goal_state_preexisting"
  | "wrong_permission"
  | "happy_verified"
  | "confirmed_absent"
  | "transport_timeout";

type Permission = "none" | "read" | "write" | "admin";

interface ResourceState {
  permission: Permission;
  attributed_operation: string | null;
  version: number;
}

interface OperationState {
  result: "applied" | "not_applied" | "ambiguous" | "satisfied_unattributed" | "wrong";
  send_certainty: DispatchResult["send_certainty"];
}

interface FakeInput {
  repository_id: string;
  principal_id: string;
  desired_permission: Permission;
  scenario?: RuntimeFakeScenario;
}

export class RuntimeFakeProvider implements ProviderAdapter {
  readonly effect_name = "fake.repository_permission_change";
  private readonly resources = new Map<string, ResourceState>();
  private readonly operations = new Map<string, OperationState>();
  private readonly scenarioOverrides = new Map<string, RuntimeFakeScenario>();
  private readonly reads = new Map<string, number>();
  private readonly mutations = new Map<string, number>();
  private readonly compensationMutations = new Map<string, number>();

  constructor(private readonly clock: ClockAttestor) {}

  setScenario(action_id: string, scenario: RuntimeFakeScenario): void {
    this.scenarioOverrides.set(action_id, scenario);
  }

  setExternalPermission(
    repository_id: string,
    principal_id: string,
    permission: Permission,
    attributed_operation: string | null = null
  ): void {
    const key = this.resourceKey({ repository_id, principal_id });
    const prior = this.resources.get(key);
    this.resources.set(key, {
      permission,
      attributed_operation,
      version: (prior?.version ?? 0) + 1,
    });
  }

  mutationCount(operation_id?: string): number {
    if (operation_id) return this.mutations.get(operation_id) ?? 0;
    return [...this.mutations.values()].reduce((sum, value) => sum + value, 0);
  }

  compensationMutationCount(operation_id?: string): number {
    if (operation_id) return this.compensationMutations.get(operation_id) ?? 0;
    return [...this.compensationMutations.values()].reduce((sum, value) => sum + value, 0);
  }

  async dispatch(
    action: ActionRecord,
    plan: DispatchPlan,
    onMutation?: (() => void | Promise<void>) | undefined
  ): Promise<DispatchResult> {
    const input = this.input(action);
    const operation = this.operationId(plan);
    const priorOperation = this.operations.get(operation);
    if (priorOperation) {
      return {
        send_certainty: priorOperation.send_certainty,
        evidence: [this.transportEvidence(action, operation, "deduplicated_dispatch")],
      };
    }

    const scenario = this.scenario(action);
    if (scenario === "definitely_not_sent") {
      return {
        send_certainty: "definitely_not_sent",
        evidence: [this.transportEvidence(action, operation, "proved_before_send")],
      };
    }

    if (scenario === "definitely_not_applied" || scenario === "confirmed_absent") {
      this.operations.set(operation, { result: "not_applied", send_certainty: "sent" });
      return {
        send_certainty: "sent",
        evidence: [this.responseEvidence(action, operation, 409, "provider_rejected_without_effect")],
      };
    }

    if (
      scenario === "request_may_have_been_sent" ||
      scenario === "only_transport" ||
      scenario === "provider_read_unavailable" ||
      scenario === "transport_timeout"
    ) {
      this.operations.set(operation, { result: "ambiguous", send_certainty: "may_have_been_sent" });
      return {
        send_certainty: "may_have_been_sent",
        evidence: [this.transportEvidence(action, operation, "request_may_have_been_sent")],
      };
    }

    const key = this.resourceKey(input);
    if (scenario === "goal_state_preexisting") {
      if (!this.resources.has(key)) {
        this.setExternalPermission(
          input.repository_id,
          input.principal_id,
          input.desired_permission,
          null
        );
      }
      this.operations.set(operation, { result: "satisfied_unattributed", send_certainty: "sent" });
      return {
        send_certainty: "sent",
        evidence: [this.responseEvidence(action, operation, 200, "goal_state_already_present")],
      };
    }

    const permission = scenario === "wrong_permission"
      ? (input.desired_permission === "admin" ? "write" : "admin")
      : input.desired_permission;
    const prior = this.resources.get(key);
    if (prior?.permission !== permission || prior.attributed_operation !== operation) {
      this.resources.set(key, {
        permission,
        attributed_operation: operation,
        version: (prior?.version ?? 0) + 1,
      });
      this.mutations.set(operation, (this.mutations.get(operation) ?? 0) + 1);
      await onMutation?.();
    }
    const result = scenario === "wrong_permission" ? "wrong" : "applied";
    const sendCertainty = scenario === "response_lost_after_effect"
      ? "may_have_been_sent"
      : "sent";
    this.operations.set(operation, { result, send_certainty: sendCertainty });
    return {
      send_certainty: sendCertainty,
      evidence: [
        scenario === "response_lost_after_effect"
          ? this.transportEvidence(action, operation, "response_lost_after_effect")
          : this.responseEvidence(
              action,
              operation,
              scenario === "eventual_consistency" ? 202 : 200,
              "provider_response_received"
            ),
      ],
    };
  }

  async observe(action: ActionRecord, plan: DispatchPlan): Promise<NewEvidence[]> {
    const input = this.input(action);
    const operation = this.operationId(plan);
    const scenario = this.scenario(action);
    const read = (this.reads.get(action.action_id) ?? 0) + 1;
    this.reads.set(action.action_id, read);
    const resource = this.resources.get(this.resourceKey(input));

    if (
      scenario === "request_may_have_been_sent" ||
      scenario === "only_transport" ||
      scenario === "transport_timeout"
    ) {
      return [this.transportEvidence(action, operation, "observation_unavailable")];
    }
    if (scenario === "definitely_not_sent") {
      return resource
        ? [this.readEvidence(
            action,
            operation,
            resource,
            resource.permission === input.desired_permission,
            resource.attributed_operation === operation
          )]
        : [this.absenceEvidence(action, operation)];
    }
    if (scenario === "provider_read_unavailable") {
      return [this.transportEvidence(action, operation, `provider_read_unavailable:${read}`)];
    }

    if (scenario === "eventual_consistency" && read <= 2) {
      return [this.pendingEvidence(action, operation, read)];
    }

    if (!resource || scenario === "definitely_not_applied" || scenario === "confirmed_absent") {
      return [this.absenceEvidence(action, operation)];
    }

    const matches = resource.permission === input.desired_permission;
    const attributed = resource.attributed_operation === operation;
    return [this.readEvidence(action, operation, resource, matches, attributed)];
  }

  async compensate(action: ActionRecord, plan: DispatchPlan): Promise<CompensationResult> {
    const input = this.input(action);
    const operation = this.operationId(plan);
    const key = this.resourceKey(input);
    const current = this.resources.get(key);
    if (!current || current.attributed_operation !== operation) {
      throw new Error("No attributed fake-provider effect is available to compensate");
    }
    if ((this.compensationMutations.get(operation) ?? 0) > 0) {
      return { evidence: [this.compensationEvidence(action, operation)] };
    }
    const restored: Permission = input.desired_permission === "none" ? "read" : "none";
    this.resources.set(key, {
      permission: restored,
      attributed_operation: `${operation}:compensation`,
      version: current.version + 1,
    });
    this.compensationMutations.set(operation, 1);
    return { evidence: [this.compensationEvidence(action, operation)] };
  }

  private scenario(action: ActionRecord): RuntimeFakeScenario {
    const input = this.input(action);
    return this.scenarioOverrides.get(action.action_id) ?? input.scenario ?? "definitely_applied";
  }

  private input(action: ActionRecord): FakeInput {
    return action.input as FakeInput;
  }

  private operationId(plan: DispatchPlan): string {
    return plan.idempotency_key ?? plan.correlation.value;
  }

  private resourceKey(input: Pick<FakeInput, "repository_id" | "principal_id">): string {
    return `${input.repository_id}\u0000${input.principal_id}`;
  }

  private base(
    action: ActionRecord,
    operation: string,
    over: Partial<NewEvidence> & Pick<NewEvidence, "payload">
  ): NewEvidence {
    const now = this.clock.now();
    return {
      action_id: action.action_id,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: "fake.runtime-provider",
      verification_method: "none",
      kind: "provider_response",
      strength: "transport_only",
      observed_disposition: "indeterminate",
      attribution: "indeterminate",
      provider_object_id: null,
      provider_event_id: null,
      observed_at: now.timestamp,
      provider_timestamp: null,
      correlation: { method: "nyst_operation_id", value: operation },
      signing: null,
      clock: now,
      supersedes_evidence_id: null,
      ...over,
    };
  }

  private transportEvidence(action: ActionRecord, operation: string, detail: string): NewEvidence {
    return this.base(action, operation, {
      provider_event_id: `${operation}:transport:${detail}`,
      payload: { detail },
    });
  }

  private responseEvidence(
    action: ActionRecord,
    operation: string,
    status: number,
    detail: string
  ): NewEvidence {
    return this.base(action, operation, {
      kind: "provider_response",
      strength: "corroborative",
      verification_method: "response_inspection",
      provider_event_id: `${operation}:response:${detail}`,
      payload: { http_status: status, detail, accepted: status === 202 },
    });
  }

  private pendingEvidence(action: ActionRecord, operation: string, read: number): NewEvidence {
    return this.base(action, operation, {
      kind: "provider_read",
      strength: "circumstantial",
      verification_method: "provider_read_back",
      provider_event_id: `${operation}:pending-read:${read}`,
      observed_disposition: "effect_absent",
      payload: { accepted: true, read, consistency_window_elapsed: false },
    });
  }

  private absenceEvidence(action: ActionRecord, operation: string): NewEvidence {
    return this.base(action, operation, {
      kind: "absence_probe",
      strength: "authoritative",
      verification_method: "absence_window_probe",
      provider_event_id: `${operation}:absence:confirmed`,
      observed_disposition: "effect_absent",
      attribution: "attributed",
      payload: { matches: 0, consistency_window_elapsed: true, operation_lookup: "not_found" },
    });
  }

  private readEvidence(
    action: ActionRecord,
    operation: string,
    resource: ResourceState,
    matches: boolean,
    attributed: boolean
  ): NewEvidence {
    const input = this.input(action);
    return this.base(action, operation, {
      kind: "provider_read",
      strength: "authoritative",
      verification_method: "provider_read_back",
      provider_object_id: `permission:${input.repository_id}:${input.principal_id}`,
      provider_event_id: `${operation}:read:v${resource.version}`,
      observed_disposition: matches ? "effect_present" : "indeterminate",
      attribution: attributed ? "attributed" : "unattributed",
      provider_timestamp: this.clock.now().timestamp,
      payload: {
        object: `permission:${input.repository_id}:${input.principal_id}`,
        repository_id: input.repository_id,
        principal_id: input.principal_id,
        permission: resource.permission,
        status: "applied",
        metadata: attributed ? { nyst_operation_id: operation } : {},
      },
    });
  }

  private compensationEvidence(action: ActionRecord, operation: string): NewEvidence {
    return this.base(action, operation, {
      kind: "compensation_confirmation",
      strength: "authoritative",
      verification_method: "provider_read_back",
      provider_object_id: `${operation}:compensation`,
      provider_event_id: `${operation}:compensation:confirmed`,
      attribution: "attributed",
      payload: { original_operation: operation, compensation_status: "applied" },
    });
  }
}
