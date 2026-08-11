import { en, lit, obj, str, type Schema } from "../../core/validate.js";
import {
  OKTA_CREDENTIAL_REF,
  OKTA_DESIRED_STATUSES,
  type OktaPublicSuspensionInput,
  type OktaResolvedSuspensionInput,
} from "./types.js";

const INTEGRATOR_ORIGIN = /^https:\/\/integrator-[0-9]+\.okta\.com$/;
const TENANT_HOST = /^integrator-[0-9]+\.okta\.com$/;
const USER_ID = /^[A-Za-z0-9]{10,64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const PublicInputSchema: Schema<OktaPublicSuspensionInput> = obj({
  org: str({ min: 1, max: 200 }),
  user_id: str({ min: 10, max: 64, pattern: USER_ID }),
  desired_status: en(OKTA_DESIRED_STATUSES),
  credential_ref: lit(OKTA_CREDENTIAL_REF),
});

export const OktaResolvedInputSchema: Schema<OktaResolvedSuspensionInput> = obj({
  org_origin: str({ min: 30, max: 200, pattern: INTEGRATOR_ORIGIN }),
  tenant_host: str({ min: 22, max: 190, pattern: TENANT_HOST }),
  user_id: str({ min: 10, max: 64, pattern: USER_ID }),
  desired_status: en(OKTA_DESIRED_STATUSES),
  operation: en(["observe_only", "suspend", "unsuspend"] as const),
  preflight_status: str({ min: 1, max: 100 }),
  preflight_login: str({ min: 1, max: 500 }),
  user_source: lit("OKTA"),
  no_admin_roles: lit(true),
  credential_ref: lit(OKTA_CREDENTIAL_REF),
  consistency_deadline: str({ min: 20, max: 40, pattern: ISO_TIMESTAMP }),
});

export function normalizeOktaOrigin(value: string): string {
  if (!INTEGRATOR_ORIGIN.test(value)) {
    throw new Error("Gate 5 supports only the canonical default Integrator Free Plan Okta origin");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Okta origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Okta origin must be an HTTPS origin without credentials, port, path, query, or fragment");
  }
  const origin = url.origin.toLowerCase();
  return origin;
}

export function normalizePublicOktaInput(value: unknown): OktaPublicSuspensionInput {
  const parsed = PublicInputSchema.parse(value);
  return { ...parsed, org: normalizeOktaOrigin(parsed.org) };
}

export function parseResolvedOktaInput(value: unknown): OktaResolvedSuspensionInput {
  return OktaResolvedInputSchema.parse(value);
}
