import { canonicalHash, canonicalJson } from "../../core/canonical.js";
import type { ClockAttestor } from "../../core/clock.js";
import type { ActionRecord, DispatchPlan } from "../../model/action.js";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from "../../model/evidence.js";
import type { DispatchResult, ProviderAdapter } from "../../runtime/provider.js";
import type { NewEvidence } from "../../store/store.js";
import type { OktaRestClient } from "./oktaClient.js";
import { parseResolvedOktaInput } from "./oktaInput.js";
import { readOktaUserSnapshot, type OktaUserSnapshot } from "./oktaSnapshot.js";
import {
  OKTA_API_VERSION,
  OKTA_EFFECT_NAME,
  OktaContractError,
  OktaObservationError,
  OktaTransportError,
  desiredProviderStatus,
  isSupportedOktaStatus,
  type OktaResolvedSuspensionInput,
  type OktaSafeHeaders,
} from "./types.js";

export class OktaUserSuspensionProvider implements ProviderAdapter {
  readonly effect_name = OKTA_EFFECT_NAME;
  constructor(private readonly client: OktaRestClient, private readonly clock: ClockAttestor) {}

  async dispatch(action: ActionRecord, plan: DispatchPlan, onMutation?: () => void | Promise<void>): Promise<DispatchResult> {
    const input = parseResolvedOktaInput(action.input);
    this.assertPlan(action, plan, input);
    let snapshot: OktaUserSnapshot;
    try { snapshot = await this.snapshot(input); }
    catch (error) { return this.failureResult(action, error, "pre_dispatch_revalidation"); }
    const goalPresent = this.goalMatches(input, snapshot);
    if (input.operation === "observe_only" || goalPresent) {
      return { send_certainty: "sent", evidence: [this.snapshotEvidence(action, input, snapshot, false)] };
    }
    if (!this.legalPrecondition(input, snapshot)) {
      return { send_certainty: "definitely_not_sent", evidence: [this.snapshotEvidence(action, input, snapshot, true)] };
    }
    let response;
    try {
      response = input.operation === "suspend"
        ? await this.client.suspendUser(input.org_origin, input.user_id, input.credential_ref)
        : await this.client.unsuspendUser(input.org_origin, input.user_id, input.credential_ref);
    } catch (error) { return this.failureResult(action, error, "mutation_transport"); }
    if (response.status === 200) await onMutation?.();
    return { send_certainty: "sent", evidence: [this.responseEvidence(action, input, response.status, response.headers)] };
  }

  async observe(action: ActionRecord, plan: DispatchPlan, priorEvidence: readonly EvidenceRecord[] = []): Promise<NewEvidence[]> {
    const input = parseResolvedOktaInput(action.input);
    this.assertPlan(action, plan, input);
    const provenNotSent = priorEvidence.some((item) => item.source === "nyst.dispatch-boundary" &&
      item.payload && typeof item.payload === "object" &&
      (item.payload as { send_certainty?: unknown }).send_certainty === "definitely_not_sent");
    let evidence: NewEvidence;
    try { evidence = this.snapshotEvidence(action, input, await this.snapshot(input), provenNotSent); }
    catch (error) { evidence = this.observationFailureEvidence(action, error); }
    const previous = priorEvidence.filter((item) =>
      item.source === "okta.user-suspension" && payloadType(item.payload) === "okta_user_snapshot"
    ).at(-1);
    if (previous && previous.provider_event_id !== evidence.provider_event_id) evidence.supersedes_evidence_id = previous.evidence_id;
    return [evidence];
  }

  private snapshot(input: OktaResolvedSuspensionInput): Promise<OktaUserSnapshot> {
    return readOktaUserSnapshot(this.client, {
      org: input.org_origin, user_id: input.user_id, credential_ref: input.credential_ref,
    }, { user_id: input.user_id, tenant_host: input.tenant_host });
  }

  private goalMatches(input: OktaResolvedSuspensionInput, snapshot: OktaUserSnapshot): boolean {
    return snapshot.user.status === desiredProviderStatus(input.desired_status) && snapshot.user.transitioning_to_status === null;
  }

  private legalPrecondition(input: OktaResolvedSuspensionInput, snapshot: OktaUserSnapshot): boolean {
    return snapshot.user.transitioning_to_status === null &&
      ((input.operation === "suspend" && snapshot.user.status === "ACTIVE") ||
       (input.operation === "unsuspend" && snapshot.user.status === "SUSPENDED"));
  }

  private snapshotEvidence(action: ActionRecord, input: OktaResolvedSuspensionInput, snapshot: OktaUserSnapshot, provenNotSent: boolean): NewEvidence {
    const now = this.clock.now();
    const goalMatches = this.goalMatches(input, snapshot);
    const supportedStatus = isSupportedOktaStatus(snapshot.user.status) && snapshot.user.transitioning_to_status === null;
    const windowElapsed = provenNotSent || new Date(now.timestamp).getTime() >= new Date(input.consistency_deadline).getTime();
    const payload = {
      type: "okta_user_snapshot",
      tenant_host: input.tenant_host,
      user_id: snapshot.user.id,
      login: snapshot.user.login,
      desired_status: input.desired_status,
      observed_status: snapshot.user.status,
      transitioning_to_status: snapshot.user.transitioning_to_status,
      user_source: snapshot.user.source_type,
      no_admin_roles: true,
      identity_verified: true,
      supported_status: supportedStatus,
      goal_matches: goalMatches,
      consistency_window_elapsed: windowElapsed,
      last_updated: snapshot.user.last_updated,
      status_changed: snapshot.user.status_changed,
      request_id: snapshot.headers.request_id,
    };
    const material = { ...payload, request_id: undefined };
    const disposition = goalMatches ? "effect_present" : supportedStatus && windowElapsed ? "effect_absent" : "indeterminate";
    return this.base(action, {
      kind: disposition === "effect_absent" ? "absence_probe" : "provider_read",
      strength: disposition === "indeterminate" ? "circumstantial" : "authoritative",
      verification_method: disposition === "effect_absent" ? "absence_window_probe" : "provider_read_back",
      observed_disposition: disposition,
      attribution: goalMatches ? "unattributed" : "indeterminate",
      provider_object_id: `okta:${input.tenant_host}:user:${input.user_id}`,
      provider_event_id: `okta:snapshot:${canonicalHash(material)}`,
      provider_timestamp: snapshot.user.last_updated,
      payload,
    });
  }

  private responseEvidence(action: ActionRecord, input: OktaResolvedSuspensionInput, status: number, headers: OktaSafeHeaders): NewEvidence {
    return this.base(action, {
      kind: "provider_response", strength: "corroborative", verification_method: "response_inspection",
      observed_disposition: "indeterminate", attribution: "indeterminate",
      provider_object_id: `okta:${input.tenant_host}:user:${input.user_id}`,
      provider_event_id: `okta:mutation:${headers.request_id ?? `${action.action_id}:${status}`}`,
      provider_timestamp: null,
      payload: { type: "okta_lifecycle_response", http_status: status, request_id: headers.request_id, operation: input.operation },
    });
  }

  private failureResult(action: ActionRecord, error: unknown, stage: string): DispatchResult {
    const certainty = error instanceof OktaTransportError ? error.send_certainty : "definitely_not_sent";
    return { send_certainty: certainty, evidence: [this.transportEvidence(action, stage, certainty)] };
  }

  private transportEvidence(action: ActionRecord, category: string, certainty: "definitely_not_sent" | "may_have_been_sent" | "sent"): NewEvidence {
    return this.base(action, {
      kind: "transport_error", strength: "transport_only", verification_method: "none",
      observed_disposition: "indeterminate", attribution: "indeterminate", provider_object_id: null,
      provider_event_id: null, provider_timestamp: null,
      payload: { type: "okta_transport_failure", category, send_certainty: certainty },
    });
  }

  private observationFailureEvidence(action: ActionRecord, error: unknown): NewEvidence {
    const actual = error instanceof OktaObservationError ? error : null;
    const category = actual?.category ?? "contract_or_topology_failure";
    const headers = actual?.headers ?? emptyHeaders();
    const payload = {
      type: "okta_observation_failure", category, http_status: actual?.status ?? null,
      retry_after: headers.retry_after, rate_limit_remaining: headers.rate_limit_remaining,
      rate_limit_reset: headers.rate_limit_reset,
      next_check_at: category === "rate_limited" ? boundedNextCheck(this.clock.now().timestamp, headers) : null,
    };
    return this.base(action, {
      kind: "provider_response", strength: "corroborative", verification_method: "response_inspection",
      observed_disposition: "indeterminate", attribution: "indeterminate", provider_object_id: null,
      provider_event_id: `okta:observation-failure:${canonicalHash(payload)}`, provider_timestamp: null, payload,
    });
  }

  private base(action: ActionRecord, over: Pick<NewEvidence,
    "kind" | "strength" | "verification_method" | "observed_disposition" | "attribution" |
    "provider_object_id" | "provider_event_id" | "provider_timestamp" | "payload">): NewEvidence {
    const now = this.clock.now();
    return {
      action_id: action.action_id, evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: "okta.user-suspension", observed_at: now.timestamp,
      correlation: { method: "nyst_action_id", value: action.action_id }, signing: null,
      clock: now, supersedes_evidence_id: null, ...over,
    };
  }

  private assertPlan(action: ActionRecord, plan: DispatchPlan, input: OktaResolvedSuspensionInput): void {
    const expected = oktaDispatchPlan(action, input);
    if (canonicalJson(plan) !== canonicalJson(expected)) throw new OktaContractError("Persisted Okta DispatchPlan does not match the bound action");
  }
}

export function oktaDispatchPlan(action: ActionRecord, input: OktaResolvedSuspensionInput): DispatchPlan {
  return {
    correlation: { method: "nyst_action_id", value: action.action_id }, idempotency_key: null,
    description: `Okta ${input.operation} for tenant ${input.tenant_host}, user ${input.user_id}, desired status ${input.desired_status}`,
    provider: "okta", operation: input.operation, api_version: OKTA_API_VERSION,
    credential_ref: input.credential_ref,
    target: {
      org_origin: input.org_origin, tenant_host: input.tenant_host, user_id: input.user_id,
      desired_status: input.desired_status, preflight_status: input.preflight_status,
      user_source: "OKTA", no_admin_roles: true, consistency_deadline: input.consistency_deadline,
    },
  };
}

function payloadType(value: unknown): string | null {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string"
    ? (value as { type: string }).type : null;
}
function boundedNextCheck(nowIso: string, headers: OktaSafeHeaders): string {
  const now = new Date(nowIso).getTime();
  const retrySeconds = headers.retry_after !== null && /^\d+$/.test(headers.retry_after) ? Number(headers.retry_after) : null;
  const resetMs = headers.rate_limit_reset !== null && /^\d+$/.test(headers.rate_limit_reset) ? Number(headers.rate_limit_reset) * 1000 : null;
  const proposed = retrySeconds !== null ? now + retrySeconds * 1000 : resetMs ?? now + 60_000;
  return new Date(Math.min(now + 5 * 60_000, Math.max(now + 60_000, proposed))).toISOString();
}
function emptyHeaders(): OktaSafeHeaders {
  return { request_id: null, retry_after: null, rate_limit_remaining: null, rate_limit_reset: null };
}
