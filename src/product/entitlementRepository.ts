/**
 * COMMERCIAL ENTITLEMENT, PERSISTED (v0.3.2 Phase 10).
 *
 * `commercialEntitlement.ts` had the whole model — four states, nine gated
 * features, a decision function — and no storage and no caller. So nothing
 * recorded what an organization had paid for, nothing could enforce it, and
 * "Shadow Trial does not include Enforced" was true only of the pricing page.
 * A trial user could POST to the mode transition and get Enforced.
 *
 * THE LINE THIS FILE MUST NOT CROSS.
 *
 * Entitlement gates a COMMERCIAL feature. It never grants safety authority and
 * never substitutes for one. PROTECT lets a customer ASK for Enforced; whether
 * Enforced happens still depends on readiness, policy, the Autonomy Line,
 * Freeze, Blast Radius and Authority — none of which consult this table, and
 * all of which are evaluated independently.
 *
 * Money decides what you may ask for. It never decides what is safe.
 */
import { randomUUID } from "node:crypto";
import { entitlementFor, mayEnable, type CommercialState, type Entitlement, type EntitlementDecision, type GatedFeature } from "../public/commercialEntitlement.js";
import type { ProductDb } from "./productRepository.js";
import type { TenantScope } from "./types.js";

export class EntitlementRepository {
  constructor(private readonly db: ProductDb) {}

  /**
   * What this organization has paid for.
   *
   * An organization with no row is treated as a TRIAL. Failing closed to the
   * most restrictive plan is the only safe default: the alternative is a
   * missing row silently granting everything, which is how billing bugs become
   * free enterprise accounts.
   */
  async entitlement(organizationId: string): Promise<Entitlement> {
    const row = (await this.db.query(
      `SELECT state,feature_overrides,expires_at,grandfathered
       FROM nyst_organization_entitlements WHERE organization_id=$1`,
      [organizationId])).rows[0];

    if (!row) {
      return entitlementFor({
        state: "trial",
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
    }
    return entitlementFor({
      state: String(row.state) as CommercialState,
      expires_at: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
      grandfathered: row.grandfathered === true,
      feature_overrides: (row.feature_overrides ?? []) as GatedFeature[],
    });
  }

  /** May this organization enable this commercial feature? */
  async mayEnable(organizationId: string, feature: GatedFeature): Promise<EntitlementDecision> {
    return mayEnable(await this.entitlement(organizationId), feature);
  }

  /**
   * Change a plan. A commercial act, so it carries an actor and a reason.
   *
   * Deliberately not exposed to the customer's own session — an organization
   * upgrading itself is a billing decision, not a product setting.
   */
  async setEntitlement(input: {
    organization_id: string;
    state: CommercialState;
    changed_by: string | null;
    reason: string;
    expires_at?: string | null;
    feature_overrides?: readonly GatedFeature[];
    note?: string | null;
  }): Promise<Entitlement> {
    if (input.reason.trim().length < 5) {
      throw Object.assign(new Error("Changing an entitlement requires a reason"), { statusCode: 400 });
    }
    const previous = (await this.db.query(
      `SELECT state FROM nyst_organization_entitlements WHERE organization_id=$1`,
      [input.organization_id])).rows[0];

    // A trial must always carry an expiry; a paid plan must not silently keep
    // one from a previous trial.
    const expires = input.state === "trial"
      ? (input.expires_at ?? new Date(Date.now() + 30 * 86_400_000).toISOString())
      : (input.expires_at ?? null);

    await this.db.query(
      `INSERT INTO nyst_organization_entitlements(organization_id,state,feature_overrides,expires_at,updated_by,note)
       VALUES($1,$2,$3::text[],$4,$5,$6)
       ON CONFLICT (organization_id) DO UPDATE SET
         state=excluded.state, feature_overrides=excluded.feature_overrides,
         expires_at=excluded.expires_at, updated_by=excluded.updated_by,
         updated_at=now(), note=excluded.note`,
      [input.organization_id, input.state, [...(input.feature_overrides ?? [])],
        expires, input.changed_by, input.note ?? null]);

    await this.db.query(
      `INSERT INTO nyst_entitlement_audit(entitlement_audit_id,organization_id,previous_state,new_state,changed_by,reason)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), input.organization_id, previous ? String(previous.state) : null,
        input.state, input.changed_by, input.reason.trim()]);

    return this.entitlement(input.organization_id);
  }

  async history(organizationId: string, limit = 50): Promise<Record<string, unknown>[]> {
    return (await this.db.query(
      `SELECT previous_state,new_state,reason,changed_at FROM nyst_entitlement_audit
       WHERE organization_id=$1 ORDER BY changed_at DESC LIMIT $2`,
      [organizationId, Math.min(Math.max(limit, 1), 200)])).rows;
  }
}

/**
 * Which commercial feature a mode transition requires, if any.
 *
 * Shadow requires nothing. It is the posture where Nyst observes and controls
 * nothing, and a customer must always be able to return to it — including a
 * customer whose trial has just expired. Charging for the ability to STOP
 * controlling things would be indefensible.
 */
export function featureForMode(mode: "shadow" | "canary" | "enforced"): GatedFeature | null {
  if (mode === "enforced") return "enforced_mode";
  if (mode === "canary") return "canary_mode";
  return null;
}
