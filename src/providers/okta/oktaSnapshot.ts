import { OktaContractError, OktaObservationError, type OktaSafeHeaders, type OktaUserIdentity } from "./types.js";
import type { OktaRestClient } from "./oktaClient.js";

export interface OktaUserSnapshot {
  user: OktaUserIdentity;
  no_admin_roles: true;
  user_source_okta: true;
  headers: OktaSafeHeaders;
}

export async function readOktaUserSnapshot(
  client: OktaRestClient,
  input: { org: string; user_id: string; credential_ref: string },
  expected?: { user_id: string; tenant_host: string }
): Promise<OktaUserSnapshot> {
  const origin = new URL(input.org);
  if (expected && (expected.user_id !== input.user_id || expected.tenant_host !== origin.hostname)) {
    throw new OktaContractError("Persisted Okta tenant or user identity mismatch");
  }
  const userResponse = await client.getUser(input.org, input.user_id, input.credential_ref);
  if (userResponse.status !== 200 || !userResponse.data) throw observationError(userResponse.status, userResponse.headers);
  if (userResponse.data.id !== input.user_id) throw new OktaContractError("Okta returned a different stable user ID");
  if (userResponse.data.source_type !== "OKTA") throw new OktaContractError("Gate 5 supports only Okta-sourced users");

  const rolesResponse = await client.listUserRoles(input.org, input.user_id, input.credential_ref);
  if (rolesResponse.status !== 200 || !rolesResponse.data) throw observationError(rolesResponse.status, rolesResponse.headers);
  if (rolesResponse.data.length !== 0) throw new OktaContractError("Gate 5 fixture user must have no admin-role assignments");
  return { user: userResponse.data, no_admin_roles: true, user_source_okta: true, headers: userResponse.headers };
}

function observationError(status: number, headers: OktaSafeHeaders): OktaObservationError {
  const rateLimited = status === 429;
  const category = rateLimited
    ? "rate_limited"
    : [401, 403, 404].includes(status)
      ? "authentication_authorization_or_identity"
      : "provider_unavailable";
  return new OktaObservationError("Okta user truth could not be established", status, headers, category);
}
