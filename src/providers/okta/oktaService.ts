import type { ClockAttestor } from "../../core/clock.js";
import type { ActionContext } from "../../model/metadata.js";
import type { CommitOptions, CommitResult, NystRuntime } from "../../runtime/nystRuntime.js";
import type { OktaRestClient } from "./oktaClient.js";
import { normalizePublicOktaInput } from "./oktaInput.js";
import { readOktaUserSnapshot } from "./oktaSnapshot.js";
import {
  OKTA_EFFECT_NAME,
  OktaPreconditionError,
  desiredProviderStatus,
  isSupportedOktaStatus,
  type OktaOperation,
} from "./types.js";

export class OktaUserSuspensionService {
  constructor(private readonly runtime: NystRuntime, private readonly client: OktaRestClient, private readonly clock: ClockAttestor) {}

  async commit(businessKey: string, publicInput: unknown, context: ActionContext, options: CommitOptions = {}): Promise<CommitResult> {
    const input = normalizePublicOktaInput(publicInput);
    if (context.credential_ref !== null && context.credential_ref !== input.credential_ref) {
      throw new OktaPreconditionError("Context credential reference does not match Okta input");
    }
    const snapshot = await readOktaUserSnapshot(this.client, {
      org: input.org, user_id: input.user_id, credential_ref: input.credential_ref,
    });
    if (snapshot.user.transitioning_to_status !== null) {
      throw new OktaPreconditionError("Okta user is already in a lifecycle transition");
    }
    let operation: OktaOperation = "observe_only";
    if (isSupportedOktaStatus(snapshot.user.status)) {
      if (snapshot.user.status !== desiredProviderStatus(input.desired_status)) {
        operation = input.desired_status === "suspended" ? "suspend" : "unsuspend";
      }
    }
    const now = this.clock.now();
    const consistencyDeadline = new Date(new Date(now.timestamp).getTime() + 5 * 60_000).toISOString();
    const url = new URL(input.org);
    return this.runtime.commit(OKTA_EFFECT_NAME, businessKey, {
      org_origin: input.org,
      tenant_host: url.hostname,
      user_id: snapshot.user.id,
      desired_status: input.desired_status,
      operation,
      preflight_status: snapshot.user.status,
      preflight_login: snapshot.user.login,
      user_source: "OKTA",
      no_admin_roles: true,
      credential_ref: input.credential_ref,
      consistency_deadline: consistencyDeadline,
    }, { ...context, credential_ref: input.credential_ref }, options);
  }
}
