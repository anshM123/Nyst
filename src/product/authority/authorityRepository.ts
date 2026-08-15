/**
 * AUTHORITY PERSISTENCE.
 *
 * Autonomy Line rules, human exceptions, signed ContinuationGrants, and the
 * durable record of every canonical authority decision.
 *
 * The two things this file must never let happen:
 *
 *   1. An exception that changes what Nyst OBSERVED. An exception authorizes
 *      continuation despite an unsatisfied or indeterminate outcome; it does
 *      not make the outcome satisfied. There is no `markVerified`, no
 *      `overrideVerdict`, and the schema cannot store one.
 *
 *   2. A ContinuationGrant that outlives the observation it rests on. Every
 *      grant pins the outcome, the exact contract version, the evaluation
 *      sequence, and the specific effects and resources it covers. Any of
 *      those moving invalidates it.
 */
import { randomUUID } from "node:crypto";
import { canonicalHash } from "../../core/canonical.js";
import type { Signer } from "../../core/signing.js";
import type { ProductDb } from "../productRepository.js";
import type { TenantScope } from "../types.js";
import type { OutcomeVerdict } from "../outcome/invariantEngine.js";
import type { AuthorityDecision, AuthorityException } from "./canonicalAuthority.js";
import type { AutonomyDisposition, AutonomyRule } from "./autonomyLine.js";

export interface AutonomyRuleInput {
  agent_id?: string | null;
  effect_name?: string | null;
  outcome_spec?: string | null;
  resource_class?: string | null;
  max_amount_minor?: number | null;
  currency?: string | null;
  max_actions_per_window?: number | null;
  max_amount_minor_per_window?: number | null;
  window_seconds?: number | null;
  requires_reversible?: boolean;
  requires_no_open_incident?: boolean;
  requires_outcome_satisfied?: string | null;
  disposition: AutonomyDisposition;
  rationale: string;
}

export interface ExceptionInput {
  kind: "exception_rule" | "temporary_grant" | "human_approval" | "emergency_policy" | "break_glass";
  agent_id?: string | null;
  effect_name?: string | null;
  outcome_spec?: string | null;
  outcome_instance_id?: string | null;
  action_id?: string | null;
  authorizes: AuthorityException["authorizes"];
  max_amount_minor?: number | null;
  currency?: string | null;
  actor_role: string;
  reason: string;
  reference?: string | null;
  expires_in_seconds: number;
}

export interface ContinuationGrantInput {
  agent_id?: string | null;
  outcome_instance_id: string;
  permitted_effects: readonly string[];
  resource_scope: readonly string[];
  expires_in_seconds: number;
  /** Required when the outcome is not SATISFIED. */
  exception_id?: string | null;
}

export interface GrantValidation {
  valid: boolean;
  grant_id: string | null;
  /** The exact reason it is unusable. Never a bare "invalid grant". */
  reason: string | null;
}

/** Shape check before a database round trip. Not a security boundary. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AuthorityRepository {
  constructor(private readonly db: ProductDb) {}

  /* ------------------------------------------------------- autonomy line */

  async createAutonomyRule(scope: TenantScope, userId: string, input: AutonomyRuleInput): Promise<AutonomyRule> {
    if (input.rationale.trim().length < 5) {
      throw Object.assign(new Error("An Autonomy Line rule requires a rationale a person can read"), { statusCode: 400 });
    }
    const row = (await this.db.query(
      `INSERT INTO nyst_autonomy_rules(autonomy_rule_id,organization_id,project_id,environment_id,
         agent_id,effect_name,outcome_spec,resource_class,max_amount_minor,currency,
         max_actions_per_window,max_amount_minor_per_window,window_seconds,
         requires_reversible,requires_no_open_incident,requires_outcome_satisfied,disposition,rationale,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [randomUUID(), scope.organization_id, scope.project_id, scope.environment_id,
        input.agent_id ?? null, input.effect_name ?? null, input.outcome_spec ?? null, input.resource_class ?? null,
        input.max_amount_minor ?? null, input.currency ?? null,
        input.max_actions_per_window ?? null, input.max_amount_minor_per_window ?? null, input.window_seconds ?? null,
        input.requires_reversible === true, input.requires_no_open_incident === true,
        input.requires_outcome_satisfied ?? null, input.disposition, input.rationale.trim(), userId])).rows[0]!;
    return hydrateRule(row);
  }

  async autonomyRules(scope: TenantScope): Promise<AutonomyRule[]> {
    return (await this.db.query(
      `SELECT * FROM nyst_autonomy_rules WHERE environment_id=$1 AND organization_id=$2 AND disabled_at IS NULL
       ORDER BY created_at`,
      [scope.environment_id, scope.organization_id])).rows.map(hydrateRule);
  }

  async disableAutonomyRule(scope: TenantScope, ruleId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE nyst_autonomy_rules SET disabled_at=now()
       WHERE autonomy_rule_id=$1 AND environment_id=$2 AND organization_id=$3 AND disabled_at IS NULL
       RETURNING autonomy_rule_id`,
      [ruleId, scope.environment_id, scope.organization_id]);
    return result.rows.length === 1;
  }

  /**
   * How much this Agent has already done inside a window, for the aggregate
   * dimensions of the Autonomy Line. Counted from the durable admission
   * ledger, which is the same source Blast Radius counts from.
   */
  async autonomyUsage(scope: TenantScope, agentId: string | null, windowSeconds: number): Promise<{ actions: number; amount_minor: number }> {
    const row = (await this.db.query(
      `SELECT count(*)::int actions, coalesce(sum(amount_minor),0)::bigint amount
       FROM nyst_consequence_admissions
       WHERE environment_id=$1 AND admitted AND ($2::uuid IS NULL OR agent_id=$2::uuid)
         AND decided_at > now() - make_interval(secs => $3)`,
      [scope.environment_id, agentId, windowSeconds])).rows[0]!;
    return { actions: Number(row.actions), amount_minor: Number(row.amount) };
  }

  /* ---------------------------------------------------------- exceptions */

  /**
   * Record a human authorization.
   *
   * Notice what this cannot do. There is no parameter that changes a verdict,
   * no flag that marks evidence verified, no way to declare an outcome
   * satisfied. The most a person can say here is "I am authorizing
   * continuation despite what Nyst observed, I am Jane from Security, the
   * reason is INC-812, and this expires in an hour."
   */
  async createException(scope: TenantScope, userId: string, input: ExceptionInput): Promise<Record<string, unknown>> {
    if (input.expires_in_seconds <= 0 || input.expires_in_seconds > 86_400) {
      throw Object.assign(new Error("An authority exception must expire within 24 hours. A permanent exception is a policy change."), { statusCode: 400 });
    }
    if (input.reason.trim().length < 10) {
      throw Object.assign(new Error("An authority exception requires a reason of at least 10 characters"), { statusCode: 400 });
    }
    if (input.kind === "break_glass" && !input.agent_id && !input.effect_name && !input.outcome_instance_id && !input.action_id) {
      throw Object.assign(new Error("A break-glass authorization must name what it applies to. An unscoped emergency authority is not an exception."), { statusCode: 400 });
    }
    const row = (await this.db.query(
      `INSERT INTO nyst_authority_exceptions(exception_id,organization_id,project_id,environment_id,kind,
         agent_id,effect_name,outcome_spec,outcome_instance_id,action_id,authorizes,max_amount_minor,currency,
         actor_user_id,actor_role,reason,reference,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now()+make_interval(secs => $18))
       RETURNING exception_id,kind,authorizes,max_amount_minor,currency,actor_role,reason,reference,issued_at,expires_at`,
      [randomUUID(), scope.organization_id, scope.project_id, scope.environment_id, input.kind,
        input.agent_id ?? null, input.effect_name ?? null, input.outcome_spec ?? null,
        input.outcome_instance_id ?? null, input.action_id ?? null, input.authorizes,
        input.max_amount_minor ?? null, input.currency ?? null,
        userId, input.actor_role, input.reason.trim(), input.reference ?? null, input.expires_in_seconds])).rows[0]!;
    return row;
  }

  /** Live, unexpired, unrevoked exceptions covering this scope. */
  async liveExceptions(scope: TenantScope, filter: {
    agent_id?: string | null; effect_name?: string | null; outcome_instance_id?: string | null; action_id?: string | null;
  } = {}): Promise<AuthorityException[]> {
    const rows = (await this.db.query(
      `SELECT e.exception_id,e.kind,e.authorizes,e.max_amount_minor,e.currency,e.actor_role,e.reason,e.reference,e.expires_at,
              u.email actor
       FROM nyst_authority_exceptions e JOIN nyst_users u ON u.user_id=e.actor_user_id
       WHERE e.environment_id=$1 AND e.organization_id=$2
         AND e.revoked_at IS NULL AND e.expires_at > now()
         AND (e.agent_id IS NULL OR e.agent_id=$3::uuid)
         AND (e.effect_name IS NULL OR e.effect_name=$4::text)
         AND (e.outcome_instance_id IS NULL OR e.outcome_instance_id=$5::uuid)
         AND (e.action_id IS NULL OR e.action_id=$6::uuid)
       ORDER BY e.issued_at DESC`,
      [scope.environment_id, scope.organization_id, filter.agent_id ?? null, filter.effect_name ?? null,
        filter.outcome_instance_id ?? null, filter.action_id ?? null])).rows;
    return rows.map((row) => ({
      exception_id: String(row.exception_id), kind: String(row.kind),
      authorizes: row.authorizes as AuthorityException["authorizes"],
      max_amount_minor: row.max_amount_minor === null ? null : Number(row.max_amount_minor),
      currency: row.currency === null ? null : String(row.currency),
      actor: String(row.actor), actor_role: String(row.actor_role),
      reason: String(row.reason), reference: row.reference === null ? null : String(row.reference),
      expires_at: new Date(String(row.expires_at)).toISOString(),
    }));
  }

  async revokeException(scope: TenantScope, userId: string, exceptionId: string, reason: string): Promise<boolean> {
    if (reason.trim().length < 5) {
      throw Object.assign(new Error("Revoking an exception requires a reason"), { statusCode: 400 });
    }
    const result = await this.db.query(
      `UPDATE nyst_authority_exceptions SET revoked_at=now(),revoked_by=$4,revocation_reason=$5
       WHERE exception_id=$1 AND environment_id=$2 AND organization_id=$3 AND revoked_at IS NULL
       RETURNING exception_id`,
      [exceptionId, scope.environment_id, scope.organization_id, userId, reason.trim()]);
    return result.rows.length === 1;
  }

  /** The full audit trail, including revoked and expired records. */
  async exceptionHistory(scope: TenantScope, limit = 100): Promise<Record<string, unknown>[]> {
    return (await this.db.query(
      `SELECT e.*,u.email actor,r.email revoked_by_email
       FROM nyst_authority_exceptions e
       JOIN nyst_users u ON u.user_id=e.actor_user_id
       LEFT JOIN nyst_users r ON r.user_id=e.revoked_by
       WHERE e.environment_id=$1 AND e.organization_id=$2 ORDER BY e.issued_at DESC LIMIT $3`,
      [scope.environment_id, scope.organization_id, Math.min(Math.max(1, limit), 500)])).rows;
  }

  /* --------------------------------------------------- continuation grants */

  /**
   * Issue a signed ContinuationGrant.
   *
   * A grant for a non-satisfied outcome REQUIRES a named human exception, and
   * the database enforces that too. There is no path to a grant that says
   * "proceed" on an outcome nobody looked at and nobody authorized.
   */
  async issueGrant(scope: TenantScope, input: ContinuationGrantInput, signer: Signer): Promise<Record<string, unknown>> {
    if (input.expires_in_seconds <= 0 || input.expires_in_seconds > 3600) {
      throw Object.assign(new Error("A ContinuationGrant must expire within one hour. There are no broad permanent grants."), { statusCode: 400 });
    }
    if (!input.permitted_effects.length || !input.resource_scope.length) {
      throw Object.assign(new Error("A ContinuationGrant must name the effects and resources it permits. There is no grant for everything."), { statusCode: 400 });
    }
    const instance = (await this.db.query(
      `SELECT i.outcome_instance_id,i.outcome_contract_id,i.contract_version,i.evaluation_sequence,i.verdict,
              c.required_invariants
       FROM nyst_outcome_instances i JOIN nyst_outcome_contracts c USING(outcome_contract_id)
       WHERE i.outcome_instance_id=$1 AND i.environment_id=$2 AND i.organization_id=$3`,
      [input.outcome_instance_id, scope.environment_id, scope.organization_id])).rows[0];
    if (!instance) throw Object.assign(new Error("Unknown OutcomeInstance"), { statusCode: 404 });

    const verdict = String(instance.verdict) as OutcomeVerdict;
    if (verdict !== "satisfied") {
      /**
       * THE EXCEPTION MUST BE REAL (v0.3.2 Phase 3).
       *
       * This used to be `!input.exception_id` and nothing else. Any UUID
       * satisfied it -- randomUUID(), one belonging to another organization,
       * one that expired yesterday, one that was revoked an hour ago, one
       * authorizing something entirely different.
       *
       * The result was worse than an unchecked action. Nyst SIGNED a statement
       * saying a named human authorized continuing past an outcome that is not
       * satisfied, when no such authorization existed. An unchecked action is a
       * gap; this manufactured false attribution to a person.
       *
       * So every dimension is checked, in the database, against the exception
       * actually named -- and the reasons are specific, because the operator
       * reading them is trying to work out which approval they should have
       * obtained.
       */
      if (!input.exception_id) {
        throw Object.assign(new Error(
          `The outcome is ${verdict.toUpperCase()}. A ContinuationGrant on a non-satisfied outcome requires an explicit, attributed human exception.`,
        ), { statusCode: 409 });
      }
      const problem = await this.exceptionCannotAuthorize(scope, input.exception_id, {
        agent_id: input.agent_id ?? null,
        effect_names: input.permitted_effects,
        outcome_instance_id: input.outcome_instance_id,
        verdict,
      });
      if (problem) throw Object.assign(new Error(problem), { statusCode: 409 });
    }

    const facts = (await this.db.query(
      `SELECT detail FROM nyst_outcome_evaluations
       WHERE outcome_instance_id=$1 AND evaluation_sequence=$2`,
      [input.outcome_instance_id, instance.evaluation_sequence])).rows[0];

    const grantId = randomUUID();
    const payload = {
      grant_type: "nyst.continuation_grant.v1",
      grant_id: grantId,
      agent_id: input.agent_id ?? null,
      organization_id: scope.organization_id,
      project_id: scope.project_id,
      environment_id: scope.environment_id,
      outcome_instance_id: String(instance.outcome_instance_id),
      outcome_contract_id: String(instance.outcome_contract_id),
      contract_version: Number(instance.contract_version),
      evaluation_sequence: Number(instance.evaluation_sequence),
      verdict,
      exception_id: input.exception_id ?? null,
      permitted_effects: [...input.permitted_effects].sort(),
      resource_scope: [...input.resource_scope].sort(),
      required_invariants: instance.required_invariants,
    };
    const signature = signer.sign(payload);
    const hash = canonicalHash(payload).replace(/^sha256:/, "");

    const row = (await this.db.query(
      `INSERT INTO nyst_continuation_grants(grant_id,organization_id,project_id,environment_id,agent_id,
         outcome_instance_id,outcome_contract_id,contract_version,evaluation_sequence,verdict,exception_id,
         required_invariants,facts_used,permitted_effects,resource_scope,expires_at,signature,key_id,payload_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now()+make_interval(secs => $16),$17,$18,$19)
       RETURNING grant_id,verdict,permitted_effects,resource_scope,issued_at,expires_at,signature,key_id,payload_hash`,
      [grantId, scope.organization_id, scope.project_id, scope.environment_id, input.agent_id ?? null,
        instance.outcome_instance_id, instance.outcome_contract_id, instance.contract_version,
        instance.evaluation_sequence, verdict, input.exception_id ?? null,
        JSON.stringify(instance.required_invariants),
        JSON.stringify(((facts?.detail ?? {}) as { required?: unknown }).required ?? []),
        [...input.permitted_effects].sort(), [...input.resource_scope].sort(),
        input.expires_in_seconds, signature.signature_b64, signature.key_id, hash])).rows[0]!;
    return { ...row, payload };
  }

  /**
   * Is this grant usable for this exact consequence, right now?
   *
   * Eight ways to say no, each with its own sentence. A generic "invalid
   * grant" would leave an operator guessing which of the eight it was.
   */
  async validateGrant(scope: TenantScope, grantId: string, request: {
    agent_id: string | null;
    effect_name: string;
    resource_ref: string;
    outcome_instance_id: string;
  }): Promise<GrantValidation> {
    const row = (await this.db.query(
      `SELECT g.*, i.evaluation_sequence current_evaluation_sequence, i.contract_version current_contract_version
       FROM nyst_continuation_grants g JOIN nyst_outcome_instances i USING(outcome_instance_id)
       WHERE g.grant_id=$1 AND g.organization_id=$2`,
      [grantId, scope.organization_id])).rows[0];
    if (!row) return { valid: false, grant_id: null, reason: "No such ContinuationGrant exists." };

    const no = (reason: string): GrantValidation => ({ valid: false, grant_id: grantId, reason });

    if (String(row.environment_id) !== scope.environment_id) return no("This grant was issued for a different environment.");
    if (row.revoked_at) return no("This grant has been revoked.");
    if (row.consumed_at) return no("This grant has already been consumed. A grant permits one consequence, not a session.");
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) return no("This grant has expired.");
    if (row.agent_id !== null && String(row.agent_id) !== request.agent_id) {
      return no("This grant was issued to a different Agent.");
    }
    if (String(row.outcome_instance_id) !== request.outcome_instance_id) {
      return no("This grant belongs to a different outcome.");
    }
    if (Number(row.contract_version) !== Number(row.current_contract_version)) {
      return no("The OutcomeContract has been superseded since this grant was issued.");
    }
    if (Number(row.evaluation_sequence) !== Number(row.current_evaluation_sequence)) {
      // The world has been re-observed since this grant was issued. Whatever
      // it rested on may no longer be true, and a grant is a statement about
      // an instant.
      return no("The outcome has been re-evaluated since this grant was issued, so the evidence it rests on is stale.");
    }
    const effects = (row.permitted_effects ?? []) as string[];
    if (!effects.includes(request.effect_name)) {
      return no(`This grant permits ${effects.join(", ")}, and this consequence is ${request.effect_name}.`);
    }
    const resources = (row.resource_scope ?? []) as string[];
    if (!resources.includes(request.resource_ref)) {
      return no(`This grant covers ${resources.join(", ")}, and this consequence targets ${request.resource_ref}.`);
    }

    /**
     * THE EXCEPTION BEHIND THE GRANT MUST STILL BE LIVE (v0.3.2 Phase 3).
     *
     * A grant proves what Nyst ISSUED. It does not prove the authorization is
     * still current. If the human who approved this withdraws the approval
     * before the grant is consumed, the grant must stop authorizing -- signed
     * once is not valid forever.
     *
     * The signature stays valid, and that is correct: revocation withdraws
     * permission, it does not rewrite the historical record of what was issued.
     */
    if (row.exception_id) {
      const problem = await this.exceptionCannotAuthorize(scope, String(row.exception_id), {
        agent_id: request.agent_id,
        effect_names: [request.effect_name],
        outcome_instance_id: request.outcome_instance_id,
        verdict: String(row.verdict) as OutcomeVerdict,
      });
      if (problem) return no(problem);
    }

    return { valid: true, grant_id: grantId, reason: null };
  }

  /**
   * Why this exception cannot authorize this continuation, or null if it can.
   *
   * Returns a SENTENCE rather than a boolean, because every caller shows it to
   * an operator who is trying to work out which approval they actually need.
   * "Invalid exception" would be true and useless.
   *
   * Checked in the database rather than in memory: the exception's scope
   * columns are nullable-means-unscoped, and reproducing that logic here in
   * JavaScript would be a second implementation of the matching rules that
   * `liveExceptions` already owns.
   */
  private async exceptionCannotAuthorize(scope: TenantScope, exceptionId: string, request: {
    agent_id: string | null;
    effect_names: readonly string[];
    outcome_instance_id: string;
    verdict: OutcomeVerdict;
  }): Promise<string | null> {
    if (!UUID_PATTERN.test(exceptionId)) return "That exception reference is not a valid identifier.";

    const row = (await this.db.query(
      `SELECT exception_id,agent_id,effect_name,outcome_instance_id,authorizes,revoked_at,expires_at
       FROM nyst_authority_exceptions
       WHERE exception_id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4`,
      [exceptionId, scope.organization_id, scope.project_id, scope.environment_id])).rows[0];

    // Absent, or belonging to another tenant. Deliberately the same answer:
    // distinguishing them would confirm that an exception exists elsewhere.
    if (!row) return "No live human exception in this environment matches that reference.";
    if (row.revoked_at) return "The human exception behind this grant has been revoked.";
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      return "The human exception behind this grant has expired.";
    }

    // `authorizes` is a closed set, and the values are not interchangeable. An
    // approval to exceed an amount threshold is not an approval to continue
    // past an unestablished outcome, and treating them as equivalent is how a
    // narrow approval silently becomes a broad one.
    const required = request.verdict === "indeterminate"
      ? "continuation_despite_indeterminate_outcome"
      : "continuation_despite_unsatisfied_outcome";
    if (String(row.authorizes) !== required) {
      return `That exception authorizes ${String(row.authorizes)}, not ${required}.`;
    }

    // Nullable scope columns mean "unscoped, so it applies". A NON-null column
    // must match exactly.
    if (row.agent_id !== null && String(row.agent_id) !== request.agent_id) {
      return "That exception was granted for a different Agent.";
    }
    if (row.outcome_instance_id !== null && String(row.outcome_instance_id) !== request.outcome_instance_id) {
      return "That exception was granted for a different outcome.";
    }
    if (row.effect_name !== null && !request.effect_names.includes(String(row.effect_name))) {
      return `That exception covers ${String(row.effect_name)}, which this grant does not permit.`;
    }
    return null;
  }

  /** Consume a grant. One grant permits one consequence. */
  async consumeGrant(scope: TenantScope, grantId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE nyst_continuation_grants SET consumed_at=now()
       WHERE grant_id=$1 AND environment_id=$2 AND organization_id=$3
         AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       RETURNING grant_id`,
      [grantId, scope.environment_id, scope.organization_id]);
    return result.rows.length === 1;
  }

  async revokeGrant(scope: TenantScope, userId: string, grantId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE nyst_continuation_grants SET revoked_at=now(),revoked_by=$4
       WHERE grant_id=$1 AND environment_id=$2 AND organization_id=$3 AND revoked_at IS NULL
       RETURNING grant_id`,
      [grantId, scope.environment_id, scope.organization_id, userId]);
    return result.rows.length === 1;
  }

  /* ---------------------------------------------------- decision history */

  /** Record what was decided, and every input that produced it. */
  async recordDecision(scope: TenantScope, input: {
    agent_id: string | null; effect_name: string; outcome_instance_id?: string | null; action_id?: string | null;
    decision: AuthorityDecision;
  }): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO nyst_authority_decisions(authority_decision_id,organization_id,project_id,environment_id,
         agent_id,effect_name,outcome_instance_id,action_id,disposition,reasons,
         controlling_policy_version_id,autonomy_rule_id,freeze_id,budget_id,exception_id,grant_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, scope.organization_id, scope.project_id, scope.environment_id,
        input.agent_id, input.effect_name, input.outcome_instance_id ?? null, input.action_id ?? null,
        input.decision.disposition, JSON.stringify(input.decision.reasons),
        input.decision.controlling_policy_version_id,
        input.decision.autonomy.rule?.autonomy_rule_id ?? null,
        input.decision.freeze_id, input.decision.budget_id,
        input.decision.exception_id, input.decision.grant_id]);
    return id;
  }

  async decisions(scope: TenantScope, limit = 50): Promise<Record<string, unknown>[]> {
    return (await this.db.query(
      `SELECT * FROM nyst_authority_decisions WHERE environment_id=$1 AND organization_id=$2
       ORDER BY decided_at DESC LIMIT $3`,
      [scope.environment_id, scope.organization_id, Math.min(Math.max(1, limit), 200)])).rows;
  }
}

function hydrateRule(row: Record<string, unknown>): AutonomyRule {
  return {
    autonomy_rule_id: String(row.autonomy_rule_id),
    agent_id: row.agent_id ? String(row.agent_id) : null,
    effect_name: row.effect_name ? String(row.effect_name) : null,
    outcome_spec: row.outcome_spec ? String(row.outcome_spec) : null,
    resource_class: row.resource_class ? String(row.resource_class) : null,
    max_amount_minor: row.max_amount_minor === null ? null : Number(row.max_amount_minor),
    currency: row.currency ? String(row.currency) : null,
    max_actions_per_window: row.max_actions_per_window === null ? null : Number(row.max_actions_per_window),
    max_amount_minor_per_window: row.max_amount_minor_per_window === null ? null : Number(row.max_amount_minor_per_window),
    window_seconds: row.window_seconds === null ? null : Number(row.window_seconds),
    requires_reversible: row.requires_reversible === true,
    requires_no_open_incident: row.requires_no_open_incident === true,
    requires_outcome_satisfied: row.requires_outcome_satisfied ? String(row.requires_outcome_satisfied) : null,
    disposition: row.disposition as AutonomyDisposition,
    rationale: String(row.rationale),
  };
}
