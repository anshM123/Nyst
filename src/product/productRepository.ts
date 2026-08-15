import { createHash, randomBytes, randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type { ActionFilters, EffectSpecDescriptor, ProductContext, ProductPrincipal, TenantScope } from "./types.js";
import { validateWebhookTarget, type ConservativePolicy, type EnvironmentMode, type FailureScenario, type ShadowObservation } from "./controlPlane.js";
import { effectiveAuthority, permittedHumanReviewOperations, SQL_AUTOMATIC_COMPENSATION_AUTHORITY, SQL_AUTOMATIC_CONTINUATION_AUTHORITY, type HumanReviewOperation } from "./effectiveAuthority.js";
import { assertShadowObservationSchema, deriveShadowSemantics } from "./shadowSemantics.js";
import { composeReadiness, evaluateEffectSpecReadiness, isPreflightStale, probeCredentialAvailability, runPreflight, type IntegrationReadiness, type PreflightProbe, type PreflightStatus } from "./readiness.js";
import { buildCapabilityManifest, CAPABILITY_MANIFEST, observedCapabilities, requiredCapabilities, requiredCapabilityRecords, sufficientCapabilities, type CapabilityAttestation, type ProviderCapabilityManifest } from "./capabilityManifest.js";
import type { SecretProvider } from "./secretProvider.js";
import { pruneIdempotencyKeys, withIdempotency, type IdempotentOperation } from "./idempotency.js";
import { admitConsequence, FREEZE_COVERAGE_PREDICATE, linkAdmissionToAction, lockEnvironmentAuthority, type AdmissionDecision, type AdmissionRequest } from "./admission.js";
import { POLICY_TEMPLATES, type PolicyTemplateId } from "./policyTemplates.js";
import { buildProtectionReport, type HighestRiskIncident, type ProtectionReport } from "./protectionReport.js";
import { evaluateGoLiveReadiness, type GoLiveReadiness } from "./goLiveReadiness.js";
import { PROOF_PACK_ATTESTATIONS, type ProofPack } from "./proofPack.js";
import { operationalHealth, recordWorkerHeartbeat, type OperationalHealth, type WorkerKind } from "./operationalHealth.js";
import { emptyMetrics, METRIC_DEFINITIONS, optionalMetricNumber, requireBreakdown, requireMetricInt, resolveRange, type CanonicalMetrics, type InterventionKind, type InterventionSummary, type MetricRange } from "./canonicalMetrics.js";
import type { OutcomeResolution } from "../model/resolution.js";
import { runFailureLabEngine } from "./failureLabEngine.js";
import { sanitizeForProduct } from "./sanitize.js";

export interface ProductDb {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const SESSION_HOURS = 12;
const ALLOWED_API_SCOPES = new Set(["actions:read", "actions:write", "receipts:read", "integrations:read"]);
/**
 * The CONVENTIONAL reference per provider (v0.3.2 Phase 2).
 *
 * A default for a single-tenant deployment and for `.env.example`. It is no
 * longer a requirement: enforcing it made every environment share one
 * credential, which is the definition of a single-tenant architecture.
 */
const EXPECTED_PROVIDER_REFS: Readonly<Record<string, string>> = { github: "env:NYST_GITHUB_TOKEN", okta: "env:NYST_OKTA_ACCESS_TOKEN", stripe: "env:NYST_STRIPE_CREDENTIAL" };
void EXPECTED_PROVIDER_REFS;

export class ProductRepository {
  constructor(private readonly db: ProductDb) {}

  /**
   * The connection this repository writes through.
   *
   * Exposed for ONE reason: so `buildProductServer` can construct the Authority
   * layer itself rather than accepting it as an option a deployment might
   * forget to pass. Until v0.3.2 `authority` was optional, and a server built
   * without it dispatched consequences with no Autonomy Line check at all --
   * the defect this accessor exists to make structurally impossible.
   */
  get database(): ProductDb { return this.db; }
  async health():Promise<void>{await this.db.query("SELECT 1")}

  /**
   * One parameterised statement, for the readiness probe.
   *
   * Deliberately narrow rather than a general escape hatch: /ready must reach
   * the migrations ledger, which is infrastructure rather than product state
   * and has no business getting a typed repository method of its own. Callers
   * pass a literal SQL string with bound parameters; nothing here interpolates.
   */
  async raw(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    return this.db.query(sql, params);
  }

  /**
   * Run work inside a transaction that holds the environment authority row.
   *
   * This is the shared boundary that gives consequence admission, freeze
   * activation and freeze release a single total order per environment (see
   * migration 0018 and `lockEnvironmentAuthority`).
   *
   * It needs a real pool, because a lock is only meaningful for the duration of
   * a transaction on one dedicated connection. A `db` that can only issue
   * single statements cannot provide the guarantee, so it is refused rather
   * than silently downgraded — a freeze that quietly stopped serializing would
   * be the worst possible thing to discover during an incident.
   */
  private async withEnvironmentAuthority<T>(
    scope: TenantScope,
    work: (client: ProductDb) => Promise<T>,
  ): Promise<T> {
    const pool = this.db as ProductDb & { connect?: () => Promise<ProductDb & { release(): void }> };
    if (typeof pool.connect !== "function") {
      throw new Error(
        "Emergency Freeze requires a connection pool that can open a transaction. " +
        "Freeze and consequence admission must cross one durable authority boundary; " +
        "that cannot be guaranteed on a single-statement interface.");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockEnvironmentAuthority(client, scope);
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create an organization, project, environment and first user.
   *
   * `mode` is REQUIRED to be considered, not defaulted silently. The schema
   * default is 'enforced' — a sensible default for a design-partner
   * deployment being bootstrapped by an operator, and a dangerous one for a
   * public signup, which used to land a stranger in the posture where Nyst is
   * in the path of real consequence while the signup page told them they were
   * in Shadow.
   *
   * Callers now say which they mean. Omitting it keeps the historical
   * behaviour for existing bootstrap callers.
   */
  /**
   * Create a workspace. ALL OF IT, OR NONE OF IT (v0.3.2 Phase 4).
   *
   * This used to be three separate statements on the pool: the organization /
   * project / environment / user CTE, then the policy, then the default
   * Autonomy Line rule. A failure after the first one -- a constraint, a
   * dropped connection, a restart -- left a real organization with a real user
   * who could sign in to a workspace with NO POLICY and NO AUTONOMY LINE.
   *
   * That is the worst shape a partial failure can take here, because it is
   * invisible. The person gets an account, signs in, and the missing pieces
   * only surface later as behaviour nobody can explain.
   *
   * One transaction now. Either the whole workspace exists or the signup failed
   * and the caller can say so truthfully: nothing was created.
   *
   * A pool is required, because a transaction needs one connection held across
   * statements. Without one this REFUSES rather than degrading to the old
   * non-atomic behaviour -- silently writing a half-workspace is exactly what
   * this exists to stop.
   */
  async createBootstrap(input: { organization: string; organization_slug: string; project: string; project_slug: string; environment: string; environment_slug: string; email: string; display_name: string; password: string; mode?: EnvironmentMode; initial_agent?: { name: string; slug: string; owner: string; description?: string; framework?: string; tags?: readonly string[] }; federated_identity?: { provider: "google" | "oidc"; provider_subject: string; email_at_link: string; email_verified_at_link: boolean; provider_config_id?: string | null } }): Promise<TenantScope & { user_id: string }> {
    const organizationId = randomUUID(); const projectId = randomUUID(); const environmentId = randomUUID(); const userId = randomUUID();
    const email = normalizedEmail(input.email); const passwordHash = await hash(input.password, 12);

    const pool = this.db as ProductDb & { connect?: () => Promise<ProductDb & { release(): void }> };
    if (typeof pool.connect !== "function") {
      throw new Error(
        "Creating a workspace requires a connection pool that can open a transaction. " +
        "A workspace is created whole or not at all, and a half-created one lets someone sign in " +
        "to an environment with no policy and no Autonomy Line.");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(`WITH organization AS (
        INSERT INTO nyst_organizations(organization_id,slug,name) VALUES($1,$5,$6) RETURNING organization_id
      ), project AS (
        INSERT INTO nyst_projects(project_id,organization_id,slug,name) SELECT $2,organization_id,$7,$8 FROM organization RETURNING project_id,organization_id
      ), environment AS (
        INSERT INTO nyst_environments(environment_id,project_id,organization_id,slug,name,mode) SELECT $3,project_id,organization_id,$9,$10,$14 FROM project
      ) INSERT INTO nyst_users(user_id,organization_id,email,display_name,password_hash) SELECT $4,organization_id,$11,$12,$13 FROM organization`,
        [organizationId, projectId, environmentId, userId, slug(input.organization_slug), bounded(input.organization, 120, "organization"), slug(input.project_slug), bounded(input.project, 120, "project"), slug(input.environment_slug), bounded(input.environment, 120, "environment"), email, bounded(input.display_name, 120, "display name"), passwordHash, input.mode ?? "enforced"]);

      await client.query(`INSERT INTO nyst_policy_versions(policy_version_id,environment_id,project_id,organization_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_by)
        VALUES($1,$2,$3,$4,NULL,1,'automatic','never',false,false,300,$5)`, [randomUUID(), environmentId, projectId, organizationId, userId]);

      /**
       * THE DEFAULT AUTONOMY LINE RULE (v0.3.2 Phase 1).
       *
       * Once the Authority layer actually gates consequences, a workspace with
       * no Autonomy Line rule can dispatch nothing at all — correctly, because
       * "an undescribed Agent has no autonomy". But a brand-new workspace whose
       * first action is refused with no way to discover why is not a usable
       * product, so the bootstrap DESCRIBES a starting posture rather than
       * leaving it absent.
       *
       * That distinction is the whole point. This is not "no rule, therefore
       * anything goes". It is an explicit rule, visible on the Autonomy Line
       * page, carrying a rationale the customer can read and tighten.
       *
       * `requires_reversible` is the conservative half. A reversible effect may
       * proceed; anything IRREVERSIBLE still finds no applicable rule and falls
       * through to "Nyst asks a person". Irreversible is where being wrong is
       * permanent, so it is what stays with a human by default.
       *
       * HONEST TRADE-OFF: a stricter product would default to `human` and make
       * every first action wait for approval. That is defensible and safer.
       * This chooses usable-by-default for reversible effects, and the choice is
       * stated here rather than buried in a migration.
       */
      await client.query(`INSERT INTO nyst_autonomy_rules(autonomy_rule_id,organization_id,project_id,environment_id,
          requires_reversible,requires_no_open_incident,disposition,rationale,created_by)
        VALUES($1,$2,$3,$4,true,true,'autonomous',$5,$6)`,
        [randomUUID(), organizationId, projectId, environmentId,
          "Default starting posture created with this workspace: an Agent may act autonomously on REVERSIBLE "
          + "effects while no incident is open. Irreversible effects still ask a person. Tighten or replace this "
          + "rule on the Autonomy Line page once you know what your Agents actually do.",
          userId]);

      if (input.initial_agent) {
        const agent = input.initial_agent;
        const tags = (agent.tags ?? []).slice(0, 12).map((tag) => bounded(tag, 40, "agent tag"));
        await client.query(`INSERT INTO nyst_agents(agent_id,organization_id,project_id,environment_id,slug,name,owner,description,framework,tags,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [randomUUID(), organizationId, projectId, environmentId, slug(agent.slug), bounded(agent.name, 120, "agent name"),
            bounded(agent.owner, 120, "agent owner"), agent.description ? bounded(agent.description, 1000, "agent description") : "",
            agent.framework ? bounded(agent.framework, 80, "agent framework") : "unspecified", JSON.stringify(tags), userId]);
      }

      if (input.federated_identity) {
        const identity = input.federated_identity;
        await client.query(`INSERT INTO nyst_federated_identities(federated_identity_id,user_id,organization_id,provider,provider_config_id,
            provider_subject,email_at_link,email_verified_at_link,last_login_at)
          VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,now())`,
          [userId, organizationId, identity.provider, identity.provider_config_id ?? null, identity.provider_subject,
            normalizedEmail(identity.email_at_link), identity.email_verified_at_link]);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    return { organization_id: organizationId, project_id: projectId, environment_id: environmentId, user_id: userId };
  }

  async login(organizationSlug: string, email: string, password: string): Promise<{ principal: ProductPrincipal; session: string; csrf: string } | null> {
    const result = await this.db.query(`SELECT u.user_id,u.password_hash,o.organization_id,p.project_id,e.environment_id
      FROM nyst_users u JOIN nyst_organizations o USING(organization_id)
      JOIN LATERAL (SELECT project_id FROM nyst_projects WHERE organization_id=o.organization_id ORDER BY created_at LIMIT 1) p ON true
      JOIN LATERAL (SELECT environment_id FROM nyst_environments WHERE project_id=p.project_id ORDER BY created_at LIMIT 1) e ON true
      WHERE o.slug=$1 AND u.email=$2 AND u.disabled_at IS NULL`, [slug(organizationSlug), normalizedEmail(email)]);
    const row = result.rows[0];
    if (!row || typeof row.password_hash !== "string" || !(await compare(password, row.password_hash))) return null;
    const session = randomBytes(32).toString("base64url"); const csrf = randomBytes(24).toString("base64url");
    await this.db.query(`INSERT INTO nyst_sessions(session_hash,csrf_hash,user_id,organization_id,selected_project_id,selected_environment_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+($7::text||' hours')::interval)`, [digest(session), digest(csrf), row.user_id, row.organization_id, row.project_id, row.environment_id, SESSION_HOURS]);
    return { session, csrf, principal: { kind: "session", user_id: String(row.user_id), api_key_id: null, agent_id: null,
      organization_id: String(row.organization_id), project_id: String(row.project_id), environment_id: String(row.environment_id), scopes: ["*"], csrf_hash: digest(csrf) } };
  }

  async authenticateSession(session: string): Promise<ProductPrincipal | null> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(session)) return null;
    const result = await this.db.query(`UPDATE nyst_sessions s SET last_seen_at=now() FROM nyst_users u
      WHERE s.session_hash=$1 AND s.user_id=u.user_id AND s.organization_id=u.organization_id
        AND s.expires_at>now() AND u.disabled_at IS NULL
      RETURNING u.user_id,s.organization_id,s.selected_project_id project_id,s.selected_environment_id environment_id,s.csrf_hash`, [digest(session)]);
    const row = result.rows[0]; if (!row) return null;
    return { kind: "session", user_id: String(row.user_id), api_key_id: null, agent_id: null, organization_id: String(row.organization_id), project_id: String(row.project_id), environment_id: String(row.environment_id), scopes: ["*"], csrf_hash: String(row.csrf_hash) };
  }

  /**
   * The CSRF token for a session. STABLE, not freshly minted.
   *
   * THE DEFECT THIS FIXES. This used to be `randomBytes(24)` — a NEW token on
   * every call — behind a GET endpoint the page calls whenever sessionStorage
   * is empty. So opening the app in a second tab rotated the token and silently
   * invalidated the FIRST tab: every button there answered "CSRF rejected"
   * until the person signed out and back in. A GET that rotates security state
   * is a bug by construction, and it breaks the most ordinary thing a person
   * does with a web application.
   *
   * It is now DERIVED from the session, so the endpoint is idempotent and every
   * tab of one session agrees. The derivation is a keyed digest of a value the
   * attacker cannot read: the session cookie is httpOnly, so script on another
   * origin cannot read it, and the same-origin policy stops them reading this
   * response — which are exactly the two properties a synchronizer token needs.
   *
   * A leaked session cookie already defeats CSRF entirely, so binding the token
   * to it costs nothing that was not already lost in that scenario.
   */
  async refreshSessionCsrf(session: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(session)) return null;
    const csrf = digest(`nyst.csrf.v1|${session}`).slice(0, 43);
    const result = await this.db.query(
      `UPDATE nyst_sessions s SET csrf_hash=$2,last_seen_at=now()
       FROM nyst_users u
       WHERE s.session_hash=$1 AND s.user_id=u.user_id
         AND s.organization_id=u.organization_id AND s.expires_at>now()
         AND u.disabled_at IS NULL
       RETURNING s.session_hash`,
      [digest(session), digest(csrf)],
    );
    return result.rows.length === 1 ? csrf : null;
  }

  async deleteSession(session: string): Promise<void> { if (/^[A-Za-z0-9_-]{40,100}$/.test(session)) await this.db.query(`DELETE FROM nyst_sessions WHERE session_hash=$1`, [digest(session)]); }

  async context(scope: TenantScope): Promise<ProductContext> {
    const result = await this.db.query(`SELECT p.project_id,p.name project_name,p.slug project_slug,
      e.environment_id,e.name environment_name,e.slug environment_slug,e.mode,e.is_demo
      FROM nyst_projects p JOIN nyst_environments e USING(project_id,organization_id)
      WHERE p.organization_id=$1 ORDER BY p.created_at,p.project_id,e.created_at,e.environment_id`, [scope.organization_id]);
    const projects = new Map<string, ProductContext["projects"][number]>();
    for (const row of result.rows) {
      const projectId = String(row.project_id);
      let project = projects.get(projectId);
      if (!project) {
        project = { project_id: projectId, project_name: String(row.project_name), project_slug: String(row.project_slug), environments: [] };
        projects.set(projectId, project);
      }
      project.environments.push({ environment_id: String(row.environment_id), environment_name: String(row.environment_name), environment_slug: String(row.environment_slug), mode: normalizeMode(row.mode), is_demo: row.is_demo === true });
    }
    return { organization_id: scope.organization_id, selected_project_id: scope.project_id, selected_environment_id: scope.environment_id, projects: [...projects.values()] };
  }

  async switchSessionContext(session: string, scope: TenantScope, projectId: string, environmentId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(session)) return false;
    const result = await this.db.query(`UPDATE nyst_sessions s
      SET selected_project_id=p.project_id,selected_environment_id=e.environment_id,last_seen_at=now()
      FROM nyst_projects p JOIN nyst_environments e USING(project_id,organization_id)
      WHERE s.session_hash=$1 AND s.organization_id=$2
        AND p.organization_id=s.organization_id AND p.project_id=$3
        AND e.environment_id=$4
      RETURNING s.session_hash`, [digest(session), scope.organization_id, projectId, environmentId]);
    return result.rows.length === 1;
  }

  async createProject(scope: Pick<TenantScope, "organization_id">, name: string, projectSlug: string): Promise<string> {
    const id = randomUUID();
    await this.db.query(`INSERT INTO nyst_projects(project_id,organization_id,slug,name) VALUES($1,$2,$3,$4)`, [id, scope.organization_id, slug(projectSlug), bounded(name, 120, "project")]);
    return id;
  }

  /** `mode` defaults to the schema's 'enforced'; a caller creating an environment for someone else should say. */
  async createEnvironment(scope: Pick<TenantScope, "organization_id" | "project_id">, name: string, environmentSlug: string, mode?: EnvironmentMode): Promise<string> {
    const id = randomUUID();
    await this.db.query(`INSERT INTO nyst_environments(environment_id,project_id,organization_id,slug,name,mode) VALUES($1,$2,$3,$4,$5,$6)`, [id, scope.project_id, scope.organization_id, slug(environmentSlug), bounded(name, 120, "environment"), mode ?? "enforced"]);
    await this.db.query(`INSERT INTO nyst_policy_versions(policy_version_id,environment_id,project_id,organization_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_by)
      SELECT $1,$2,$3,$4,NULL,1,'automatic','never',false,false,300,user_id FROM nyst_users
      WHERE organization_id=$4 AND disabled_at IS NULL ORDER BY created_at,user_id LIMIT 1`, [randomUUID(), id, scope.project_id, scope.organization_id]);
    return id;
  }

  /**
   * Create an API key, optionally BOUND to one Agent.
   *
   * A bound key can only ever act as its own Agent (see resolveActingAgent).
   * The composite foreign key makes a cross-tenant Agent id impossible to
   * store, so the binding cannot be used to escape the tenant scope.
   */
  async createApiKey(scope: TenantScope, name: string, scopes: readonly string[], expiresAt: string | null = null, agentId: string | null = null): Promise<{ api_key_id: string; key: string; prefix: string; agent_id: string | null }> {
    if (!scopes.length || scopes.some((value) => !ALLOWED_API_SCOPES.has(value))) throw new Error("Unsupported API key scope");
    if (agentId !== null && !UUID_PATTERN.test(agentId)) throw new Error("Invalid Agent identifier");
    const id = randomUUID(); const prefix = `nyst_${randomBytes(6).toString("hex")}`; const key = `${prefix}.${randomBytes(32).toString("base64url")}`;
    await this.db.query(`INSERT INTO nyst_api_keys(api_key_id,organization_id,project_id,environment_id,name,prefix,secret_hash,scopes,expires_at,agent_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, scope.organization_id, scope.project_id, scope.environment_id, bounded(name, 120, "API key name"), prefix, digest(key), [...scopes], expiresAt, agentId]);
    return { api_key_id: id, key, prefix, agent_id: agentId };
  }

  async authenticateApiKey(key: string): Promise<ProductPrincipal | null> {
    if (!/^nyst_[a-z0-9]{8,20}\.[A-Za-z0-9_-]{40,100}$/.test(key)) return null;
    const result = await this.db.query(`UPDATE nyst_api_keys SET last_used_at=now() WHERE secret_hash=$1 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now()) RETURNING api_key_id,organization_id,project_id,environment_id,scopes,agent_id`, [digest(key)]);
    const row = result.rows[0]; if (!row) return null;
    return { kind: "api_key", user_id: null, api_key_id: String(row.api_key_id), agent_id: row.agent_id ? String(row.agent_id) : null, organization_id: String(row.organization_id), project_id: String(row.project_id), environment_id: String(row.environment_id), scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [], csrf_hash: null };
  }

  async revokeApiKey(scope: TenantScope, keyId: string): Promise<boolean> {
    const result = await this.db.query(`UPDATE nyst_api_keys SET revoked_at=now() WHERE api_key_id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4 AND revoked_at IS NULL RETURNING api_key_id`, [keyId, scope.organization_id, scope.project_id, scope.environment_id]);
    return result.rows.length === 1;
  }

  /**
   * Establish durable tenant (and Agent) ownership BEFORE the action becomes
   * dispatch-eligible. Invariant I4.
   *
   * The Agent binding is written at INSERT time and nyst_action_scopes is
   * immutable, so a historical action can never be re-attributed to a
   * different Agent, and a cross-tenant Agent id fails the composite foreign
   * key rather than being silently accepted.
   */
  async scopeAction(scope: TenantScope, actionId: string, displayBusinessKey: string, agentId: string | null = null): Promise<void> {
    const display = bounded(displayBusinessKey, 500, "business key");
    if (agentId !== null && !UUID_PATTERN.test(agentId)) throw new Error("Invalid Agent identifier");
    await this.db.query(`INSERT INTO nyst_action_scopes(action_id,environment_id,project_id,organization_id,display_business_key,agent_id)
      SELECT a.action_id,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::uuid FROM outcome_actions a
      WHERE a.action_id=$1::uuid AND a.business_key=$2::uuid::text||':'||$5::text
      ON CONFLICT(action_id) DO NOTHING`, [actionId, scope.environment_id, scope.project_id, scope.organization_id, display, agentId]);
    const check = await this.db.query(`SELECT 1 FROM nyst_action_scopes WHERE action_id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4`, [actionId, scope.organization_id, scope.project_id, scope.environment_id]);
    if (!check.rows.length) throw new Error("Action already belongs to a different tenant scope");
    const action = await this.db.query(`SELECT effect_name FROM outcome_actions WHERE action_id=$1`, [actionId]);
    const effectName = String(action.rows[0]?.effect_name ?? "");
    if (!effectName) throw new Error("Action does not exist");
    const [control, policy] = await Promise.all([this.environmentControl(scope), this.currentPolicy(scope, effectName)]);
    await this.bindActionControl(scope, actionId, policy.policy_version_id, control.mode);
  }

  async assertActionScoped(actionId: string): Promise<void> {
    const check = await this.db.query(`SELECT 1 FROM nyst_action_scopes WHERE action_id=$1`, [actionId]);
    if (!check.rows.length) throw new Error("Product action is not dispatch-eligible until durable tenant scope exists");
  }

  async configureEffectSpec(scope: TenantScope, descriptor: EffectSpecDescriptor, enabled: boolean): Promise<void> {
    await this.requireTenantScope(scope);
    const result = await this.db.query(`INSERT INTO nyst_environment_effect_specs(environment_id,project_id,organization_id,effect_name,spec_version,enabled)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(environment_id,effect_name) DO UPDATE SET spec_version=excluded.spec_version,enabled=excluded.enabled
      WHERE nyst_environment_effect_specs.project_id=excluded.project_id AND nyst_environment_effect_specs.organization_id=excluded.organization_id
      RETURNING effect_name`,
      [scope.environment_id, scope.project_id, scope.organization_id, descriptor.effect_name, descriptor.spec_version, enabled]);
    if (!result.rows.length) throw new Error("EffectSpec configuration belongs to a different tenant scope");
  }

  async effectSpecConfiguration(scope: TenantScope, descriptors: readonly EffectSpecDescriptor[], production: boolean): Promise<Array<EffectSpecDescriptor & { enabled: true; credential_ref: string | null }>> {
    const result = await this.db.query(`SELECT s.effect_name,s.spec_version,s.enabled,i.configured,i.credential_ref
      FROM nyst_environment_effect_specs s
      LEFT JOIN nyst_integrations i ON i.environment_id=s.environment_id AND i.project_id=s.project_id AND i.organization_id=s.organization_id
        AND i.provider=split_part(s.effect_name,'.',1)
      WHERE s.organization_id=$1 AND s.project_id=$2 AND s.environment_id=$3`, [scope.organization_id, scope.project_id, scope.environment_id]);
    const rows = new Map(result.rows.map((row) => [String(row.effect_name), row]));
    const available: Array<EffectSpecDescriptor & { enabled: true; credential_ref: string | null }> = [];
    for (const descriptor of descriptors) {
      const row = rows.get(descriptor.effect_name);
      if (!row || row.enabled !== true || String(row.spec_version) !== descriptor.spec_version) continue;
      if (descriptor.provider === "fake") {
        if (!production) available.push({ ...descriptor, enabled: true, credential_ref: null });
      } else if (row.configured === true && row.credential_ref === EXPECTED_PROVIDER_REFS[descriptor.provider]) {
        available.push({ ...descriptor, enabled: true, credential_ref: String(row.credential_ref) });
      }
    }
    return available;
  }

  async apiKeys(scope:TenantScope):Promise<Record<string,unknown>[]>{return (await this.db.query(`SELECT k.api_key_id,k.name,k.prefix,k.scopes,k.created_at,k.last_used_at,k.expires_at,k.revoked_at,k.agent_id,a.name agent_name FROM nyst_api_keys k LEFT JOIN nyst_agents a USING(agent_id) WHERE k.organization_id=$1 AND k.project_id=$2 AND k.environment_id=$3 ORDER BY k.created_at DESC`,[scope.organization_id,scope.project_id,scope.environment_id])).rows;}

  /**
   * Every registered EffectSpec's readiness in this environment.
   *
   * `secrets` is REQUIRED, not optional. The previous signature let a caller
   * omit it and still receive a `ready: true`, because readiness was decided by
   * comparing a stored credential reference string against a constant. That is
   * the second definition Phase 1D exists to delete. If a caller genuinely has
   * no SecretProvider it may pass null, and every provider-backed EffectSpec
   * comes back `readiness_unevaluated` — never ready.
   */
  async effectSpecStatuses(scope:TenantScope,descriptors:readonly EffectSpecDescriptor[],production:boolean,secrets:SecretProvider|null,now:Date=new Date()):Promise<Record<string,unknown>[]>{
    await this.requireTenantScope(scope);
    const result=await this.db.query(`SELECT s.effect_name,s.spec_version,s.enabled,i.configured,i.credential_ref FROM nyst_environment_effect_specs s LEFT JOIN nyst_integrations i ON i.environment_id=s.environment_id AND i.project_id=s.project_id AND i.organization_id=s.organization_id AND i.provider=split_part(s.effect_name,'.',1) WHERE s.organization_id=$1 AND s.project_id=$2 AND s.environment_id=$3`,[scope.organization_id,scope.project_id,scope.environment_id]);
    const configured=new Map(result.rows.map(row=>[String(row.effect_name),row]));
    // One canonical readiness evaluation per provider, shared by every
    // EffectSpec that dispatches through it.
    const providers=new Map<string,IntegrationReadiness>();
    if(secrets){
      for(const provider of new Set(descriptors.map(d=>d.provider).filter(p=>p!=="fake"))){
        providers.set(provider,await this.integrationReadiness(scope,provider,secrets,now));
      }
    }
    return descriptors.map(descriptor=>{
      const row=configured.get(descriptor.effect_name);
      const credentialFree=descriptor.provider==="fake";
      const readiness=evaluateEffectSpecReadiness({
        registered:true,
        configured_in_environment:!!row,
        version_matches:!!row&&String(row.spec_version)===descriptor.spec_version,
        environment_enabled:row?.enabled===true,
        credential_free:credentialFree,
        production,
        integration:credentialFree?null:providers.get(descriptor.provider)??null,
      });
      return {...descriptor,...readiness,
        configured_spec_version:row?String(row.spec_version):null,
        integration_configured:row?.configured===true,
        credential_ref:row?.credential_ref??null};
    });
  }

  async requireEffectSpec(scope: TenantScope, effectName: string, descriptors: readonly EffectSpecDescriptor[], production: boolean): Promise<EffectSpecDescriptor & { enabled: true; credential_ref: string | null }> {
    const descriptor = descriptors.find((item) => item.effect_name === effectName);
    if (!descriptor) throw Object.assign(new Error("EffectSpec is not registered"), { statusCode: 400 });
    const row = await this.db.query(`SELECT spec_version,enabled FROM nyst_environment_effect_specs
      WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND effect_name=$4`, [scope.organization_id, scope.project_id, scope.environment_id, effectName]);
    const configured = row.rows[0];
    if (!configured || configured.enabled !== true) throw Object.assign(new Error("EffectSpec is disabled for this environment"), { statusCode: 409 });
    if (String(configured.spec_version) !== descriptor.spec_version) throw Object.assign(new Error("Configured EffectSpec version is unavailable"), { statusCode: 409 });
    if (descriptor.provider === "fake") {
      if (production) throw Object.assign(new Error("The deterministic fake provider is unavailable in production"), { statusCode: 409 });
      return { ...descriptor, enabled: true, credential_ref: null };
    }
    const integration = await this.db.query(`SELECT credential_ref FROM nyst_integrations
      WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND provider=$4 AND configured=true`, [scope.organization_id, scope.project_id, scope.environment_id, descriptor.provider]);
    const credentialRef = integration.rows[0]?.credential_ref;
    if (typeof credentialRef !== "string") throw Object.assign(new Error("Required provider integration is not configured"), { statusCode: 409 });
    /**
     * ANY VALID REFERENCE, NOT ONE HARDCODED CONSTANT (v0.3.2 Phase 2).
     *
     * This used to require credential_ref === EXPECTED_PROVIDER_REFS[provider],
     * so every environment on the deployment had to name the SAME variable --
     * which is another way of saying every customer shared one GitHub token.
     * Fine for a single design partner, impossible for a hosted product.
     *
     * The shape is checked here; whether the secret behind it exists is
     * answered by the SecretProvider at the moment of use, and by preflight
     * before anything is admitted. Checking resolvability here would mean
     * resolving a secret on every admission, which is both slower and a wider
     * blast radius for a value that must live as briefly as possible.
     */
    if (!/^(env|vault|secret-manager):[A-Za-z0-9_./:-]{3,280}$/.test(credentialRef)) {
      throw Object.assign(new Error(
        "The configured credential reference is not a usable reference. It must name a secret — " +
        "env:NAME, vault:path or secret-manager:name."), { statusCode: 409 });
    }
    return { ...descriptor, enabled: true, credential_ref: credentialRef };
  }

  async listActions(scope: TenantScope, filters: ActionFilters = {}): Promise<Record<string, unknown>[]> {
    const where = ["s.organization_id=$1", "s.project_id=$2", "s.environment_id=$3"]; const params: unknown[] = [scope.organization_id, scope.project_id, scope.environment_id];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(`${sql}$${params.length}`); };
    if (filters.provider) add("a.dispatch_plan->>'provider'=", bounded(filters.provider, 60, "provider"));
    if (filters.effect) add("a.effect_name=", bounded(filters.effect, 200, "effect"));
    if (filters.state) add("r.effect_state=", bounded(filters.state, 40, "state"));
    if (filters.decision) add("r.primary_directive=", bounded(filters.decision, 40, "decision"));
    if (filters.since) add("a.created_at>=", validDate(filters.since));
    params.push(Math.min(200, Math.max(1, filters.limit ?? 50)));
    const result = await this.db.query(`SELECT a.action_id,a.created_at,a.effect_name,a.input_hash,a.internal_state,
      coalesce(a.dispatch_plan->>'provider',split_part(a.effect_name,'.',1)) provider,a.dispatch_plan->>'operation' provider_operation,s.display_business_key AS business_key,r.effect_state,r.primary_directive,
      r.retry_disposition,r.continuation_disposition,r.resolution_sequence,b.environment_mode,b.policy_version_id
      FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id)
      LEFT JOIN nyst_action_policy_bindings b USING(action_id)
      LEFT JOIN LATERAL (SELECT * FROM outcome_resolutions WHERE action_id=a.action_id ORDER BY resolution_sequence DESC NULLS LAST,resolved_at DESC LIMIT 1) r ON true
      WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC,a.action_id LIMIT $${params.length}`, params);
    return result.rows;
  }

  async actionDetail(scope: TenantScope, actionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.query(`SELECT a.*,s.display_business_key AS business_key,rt.dispatch_status,rt.dispatch_attempts,rt.resolution_sequence,rt.evidence_sequence,rt.next_check_at,b.environment_mode,b.policy_version_id,p.version AS policy_version,p.execution_mode AS policy_execution_mode,p.auto_continuation,p.auto_compensation
      FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) LEFT JOIN outcome_runtime rt USING(action_id)
      LEFT JOIN nyst_action_policy_bindings b USING(action_id) LEFT JOIN nyst_policy_versions p USING(policy_version_id)
      WHERE s.organization_id=$1 AND s.project_id=$2 AND s.environment_id=$3 AND a.action_id=$4`, [scope.organization_id, scope.project_id, scope.environment_id, actionId]);
    return result.rows[0] ?? null;
  }

  async evidence(scope: TenantScope, actionId: string): Promise<Record<string, unknown>[] | null> {
    if (!(await this.actionDetail(scope, actionId))) return null;
    return (await this.db.query(`SELECT evidence_id,seq,source,verification_method,kind,strength,observed_disposition,attribution,
      provider_object_id,provider_event_id,observed_at,provider_timestamp,payload,payload_hash,correlation,clock,supersedes_evidence_id
      FROM outcome_evidence WHERE action_id=$1 ORDER BY seq`, [actionId])).rows;
  }

  async resolutions(scope: TenantScope, actionId: string): Promise<Record<string, unknown>[] | null> {
    if (!(await this.actionDetail(scope, actionId))) return null;
    return (await this.db.query(`SELECT full_document FROM outcome_resolutions WHERE action_id=$1 ORDER BY resolution_sequence,resolved_at`, [actionId])).rows.map((row) => row.full_document as Record<string, unknown>);
  }

  async receipt(scope: TenantScope, actionId: string): Promise<Record<string, unknown> | null> {
    if (!(await this.actionDetail(scope, actionId))) return null;
    const result = await this.db.query(`SELECT full_document FROM outcome_resolutions WHERE action_id=$1 ORDER BY resolution_sequence DESC NULLS LAST,resolved_at DESC LIMIT 1`, [actionId]);
    return (result.rows[0]?.full_document as Record<string, unknown> | undefined) ?? null;
  }

  async integrations(scope: TenantScope): Promise<Record<string, unknown>[]> {
    return (await this.db.query(`SELECT i.provider,i.configured,i.credential_ref,i.last_verified_at,
      (SELECT max(a.created_at) FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) WHERE s.organization_id=i.organization_id AND s.project_id=i.project_id AND s.environment_id=i.environment_id AND split_part(a.effect_name,'.',1)=i.provider) last_protected_action_at,
      (SELECT max(r.resolved_at) FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) JOIN outcome_resolutions r USING(action_id) WHERE s.organization_id=i.organization_id AND s.project_id=i.project_id AND s.environment_id=i.environment_id AND split_part(a.effect_name,'.',1)=i.provider) last_reconciliation_at
      FROM nyst_integrations i WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY provider`, [scope.organization_id, scope.project_id, scope.environment_id])).rows;
  }
  async configureIntegration(scope: TenantScope, provider: string, credentialRef: string): Promise<Record<string, unknown>> {
    await this.requireTenantScope(scope);
    if (!["github","okta","stripe"].includes(provider)) throw new Error("Unsupported integration provider");
    // `tenant:` added in v0.3.3 for credentials the CUSTOMER supplied through
    // the UI. Still a NAME and never a secret: it is a row id, and the value it
    // names lives encrypted in nyst_tenant_credentials.
    const ref=bounded(credentialRef,300,"credential reference"); if (!/^(?:env|vault|secret-manager|tenant):[A-Za-z0-9_./:-]{3,280}$/.test(ref)) throw new Error("Integration requires an opaque credential reference");
    /**
     * ROTATION INVALIDATES THE PREFLIGHT (v0.3.1 issue 11).
     *
     * Nothing extra is needed here. Each preflight records the reference it was
     * run against, and readiness requires that to equal the reference
     * configured now — so changing this value drops the integration back to
     * unverified, and changing it back restores the earlier verdict, which is
     * the right answer in both directions. No timestamp is involved, so no
     * comparison crosses a clock boundary.
     */
    const result=await this.db.query(`INSERT INTO nyst_integrations(integration_id,environment_id,project_id,organization_id,provider,credential_ref,configured)
      VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(environment_id,provider) DO UPDATE SET
        credential_ref=excluded.credential_ref,configured=true,last_verified_at=NULL
      WHERE nyst_integrations.project_id=excluded.project_id AND nyst_integrations.organization_id=excluded.organization_id
      RETURNING provider,configured,credential_ref,last_verified_at`,[randomUUID(),scope.environment_id,scope.project_id,scope.organization_id,provider,ref]); const row=result.rows[0];if(!row)throw new Error("Integration belongs to a different tenant scope");return row;
  }

  async offboardingRuns(scope: TenantScope): Promise<Record<string, unknown>[]> { return (await this.db.query(`SELECT r.run_id,r.business_key,r.intent->'subject' subject,r.okta_action_id,r.github_action_id,r.created_at,
      CASE WHEN r.okta_action_id IS NULL THEN 'running_okta'
        WHEN okta.effect_state NOT IN ('verified','satisfied_unattributed') OR okta.continuation_disposition<>'allowed' THEN 'blocked_okta'
        WHEN r.github_action_id IS NULL THEN 'running_github'
        WHEN github.effect_state IN ('verified','satisfied_unattributed') AND github.continuation_disposition='allowed' THEN 'complete'
        ELSE 'blocked_github' END status,
      CASE WHEN r.okta_action_id IS NOT NULL AND (okta.effect_state IS NULL OR okta.effect_state NOT IN ('verified','satisfied_unattributed') OR okta.continuation_disposition<>'allowed') THEN 'Okta effect is not currently safe for continuation.'
        WHEN r.github_action_id IS NOT NULL AND (github.effect_state IS NULL OR github.effect_state NOT IN ('verified','satisfied_unattributed') OR github.continuation_disposition<>'allowed') THEN 'GitHub effect is not currently complete.' ELSE NULL END blocking_reason
    FROM nyst_offboarding_scopes s JOIN outcome_offboarding_runs r USING(run_id)
    LEFT JOIN LATERAL (SELECT effect_state,continuation_disposition FROM outcome_resolutions WHERE action_id=r.okta_action_id ORDER BY resolution_sequence DESC NULLS LAST,resolved_at DESC LIMIT 1) okta ON true
    LEFT JOIN LATERAL (SELECT effect_state,continuation_disposition FROM outcome_resolutions WHERE action_id=r.github_action_id ORDER BY resolution_sequence DESC NULLS LAST,resolved_at DESC LIMIT 1) github ON true
    WHERE s.organization_id=$1 AND s.project_id=$2 AND s.environment_id=$3 ORDER BY r.created_at DESC LIMIT 100`, [scope.organization_id, scope.project_id, scope.environment_id])).rows; }

  async offboardingIntentForOktaAction(scope:TenantScope,actionId:string):Promise<Record<string,unknown>|null>{const result=await this.db.query(`SELECT r.intent FROM nyst_offboarding_scopes s JOIN outcome_offboarding_runs r USING(run_id) WHERE r.okta_action_id=$1 AND s.environment_id=$2 AND s.project_id=$3 AND s.organization_id=$4`,[actionId,scope.environment_id,scope.project_id,scope.organization_id]);return result.rows[0]?.intent as Record<string,unknown>??null;}

  async projectInfo(scope: TenantScope): Promise<Record<string, unknown> | null> { const result=await this.db.query(`SELECT o.name organization,o.slug organization_slug,p.name project,p.slug project_slug,e.name environment,e.slug environment_slug
    FROM nyst_organizations o JOIN nyst_projects p USING(organization_id) JOIN nyst_environments e USING(project_id,organization_id)
    WHERE o.organization_id=$1 AND p.project_id=$2 AND e.environment_id=$3`,[scope.organization_id,scope.project_id,scope.environment_id]);return result.rows[0]??null; }

  /**
   * Issue a continuation lease.
   *
   * v0.2.1 checked only the runtime continuation disposition here, so
   * `POST /v1/actions/:id/continuation-leases` granted automatic continuation
   * even when the action-bound policy set `auto_continuation = false`. That
   * was a direct I7 violation and a complete bypass of customer policy.
   *
   * The authority is now the INTERSECTION, checked in two places that must
   * both agree: `effectiveAuthority()` in the application, and the
   * SQL_AUTOMATIC_CONTINUATION_AUTHORITY predicate inside the statement so a
   * second process or a future code path cannot route around it.
   *
   * Emergency Freeze adds a further restriction to both statements in Phase 11.
   *
   * The policy consulted is the IMMUTABLE ACTION-BOUND version from
   * nyst_action_policy_bindings — never the current environment policy — so a
   * later policy edit cannot retroactively widen a historical action.
   */
  async issueContinuationLease(scope: TenantScope, actionId: string, resolutionId: string, resolutionSequence: number, evidenceSequence: number): Promise<{ lease: string; expires_at: string }> {
    const authority = await this.effectiveActionAuthority(scope, actionId, resolutionId);
    if (!authority) throw new Error("Continuation authorization is unavailable for this action in this tenant scope");
    if (!authority.automatic_continuation_allowed) {
      throw new Error(
        `Effective authority does not authorize automatic continuation (${authority.reductions.join(", ") || "runtime continuation blocked"}). ` +
        "Customer policy may only reduce Nyst authority; it is never unioned with it."
      );
    }
    const lease = `nyst_lease_${randomBytes(32).toString("base64url")}`; const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const result = await this.db.query(`INSERT INTO nyst_continuation_leases(lease_hash,action_id,resolution_id,organization_id,resolution_sequence,evidence_sequence,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7 FROM nyst_action_scopes s JOIN outcome_runtime rt USING(action_id)
      JOIN outcome_resolutions r ON r.action_id=s.action_id AND r.resolution_id=$3
      JOIN nyst_action_policy_bindings b ON b.action_id=s.action_id
      JOIN nyst_policy_versions p ON p.policy_version_id=b.policy_version_id
      WHERE s.action_id=$2 AND s.organization_id=$4 AND s.project_id=$8 AND s.environment_id=$9
        AND rt.resolution_sequence=$5 AND rt.evidence_sequence=$6
        AND ${SQL_AUTOMATIC_CONTINUATION_AUTHORITY}
      RETURNING lease_hash`, [digest(lease), actionId, resolutionId, scope.organization_id, resolutionSequence, evidenceSequence, expiresAt, scope.project_id, scope.environment_id]);
    if (!result.rows.length) throw new Error("Continuation authorization became stale, or the bound policy does not authorize it");
    return { lease, expires_at: expiresAt };
  }

  /**
   * Consume a continuation lease. The intersection is re-evaluated at
   * consumption time, not merely at issuance: a stale sequence or a policy
   * that no longer authorizes automatic continuation must still block it.
   */
  async consumeContinuationLease(scope: TenantScope, lease: string): Promise<{ action_id: string; resolution_id: string } | null> {
    if (!/^nyst_lease_[A-Za-z0-9_-]{40,100}$/.test(lease)) return null;
    const result = await this.db.query(`UPDATE nyst_continuation_leases l SET consumed_at=now()
      FROM nyst_action_scopes s,outcome_runtime rt,outcome_resolutions r,nyst_action_policy_bindings b,nyst_policy_versions p
      WHERE l.lease_hash=$1 AND l.consumed_at IS NULL AND l.expires_at>now()
        AND s.action_id=l.action_id AND s.organization_id=$2 AND s.project_id=$3 AND s.environment_id=$4
        AND rt.action_id=l.action_id AND rt.resolution_sequence=l.resolution_sequence AND rt.evidence_sequence=l.evidence_sequence
        AND r.resolution_id=l.resolution_id AND r.action_id=l.action_id
        AND b.action_id=l.action_id AND p.policy_version_id=b.policy_version_id
        AND ${SQL_AUTOMATIC_CONTINUATION_AUTHORITY}
      RETURNING l.action_id,l.resolution_id`, [digest(lease), scope.organization_id, scope.project_id, scope.environment_id]);
    const row = result.rows[0]; return row ? { action_id: String(row.action_id), resolution_id: String(row.resolution_id) } : null;
  }

  /**
   * THE canonical effective-authority read. Every automatic authority path
   * derives permission from this, so there is exactly one definition of what
   * Nyst is allowed to do next for a given action.
   */
  async effectiveActionAuthority(scope: TenantScope, actionId: string, resolutionId?: string): Promise<(ReturnType<typeof effectiveAuthority> & { policy_version_id: string; resolution_id: string }) | null> {
    const result = await this.db.query(`SELECT r.resolution_id,r.primary_directive,r.retry_disposition,r.continuation_disposition,r.recovery_disposition,
        p.policy_version_id,p.execution_mode,p.auto_continuation,p.auto_compensation,p.reconcile_timeout_seconds
      FROM nyst_action_scopes s
      JOIN nyst_action_policy_bindings b ON b.action_id=s.action_id
      JOIN nyst_policy_versions p ON p.policy_version_id=b.policy_version_id
      JOIN LATERAL(SELECT * FROM outcome_resolutions WHERE action_id=s.action_id
        AND ($5::uuid IS NULL OR resolution_id=$5::uuid)
        ORDER BY resolution_sequence DESC NULLS LAST,resolved_at DESC LIMIT 1) r ON true
      WHERE s.action_id=$1 AND s.environment_id=$2 AND s.project_id=$3 AND s.organization_id=$4`,
      [actionId, scope.environment_id, scope.project_id, scope.organization_id, resolutionId ?? null]);
    const row = result.rows[0]; if (!row) return null;
    const authority = effectiveAuthority(
      { primary: row.primary_directive as never, retry: row.retry_disposition as never, continuation: row.continuation_disposition as never, recovery: row.recovery_disposition as never },
      { policy_version_id: String(row.policy_version_id), execution_mode: row.execution_mode === "approval_required" ? "approval_required" : "automatic",
        retry_mode: "never", auto_continuation: row.auto_continuation === true, auto_compensation: row.auto_compensation === true,
        reconcile_timeout_seconds: Number(row.reconcile_timeout_seconds) },
    );
    return { ...authority, policy_version_id: String(row.policy_version_id), resolution_id: String(row.resolution_id) };
  }

  async environmentControl(scope: TenantScope): Promise<{ mode: EnvironmentMode; is_demo: boolean; onboarding_stage: number }> {
    const result = await this.db.query(`SELECT mode,is_demo,onboarding_stage FROM nyst_environments WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3`, [scope.environment_id, scope.project_id, scope.organization_id]);
    const row = result.rows[0]; if (!row) throw new Error("Resource belongs to a different tenant scope");
    return { mode: normalizeMode(row.mode), is_demo: row.is_demo === true, onboarding_stage: Number(row.onboarding_stage ?? 0) };
  }

  /**
   * Move an environment between Shadow, Canary and Enforced.
   *
   * COMMERCIAL ENTITLEMENT IS CHECKED HERE (v0.3.2 Phase 10), because this is
   * the API a customer actually calls. Before v0.3.2 nothing checked it
   * anywhere: the plan was never stored, so "Shadow Trial does not include
   * Enforced" was true only of the pricing page and a trial user could POST
   * straight here and get Enforced. Hiding the button is not enforcement.
   *
   * WHAT THIS CHECK IS NOT. It gates a COMMERCIAL feature and nothing else.
   * Passing it means the customer is allowed to ASK for Enforced. Whether
   * Enforced is SAFE is decided independently by readiness, policy, the
   * Autonomy Line, Freeze, Blast Radius and Authority -- none of which look at
   * the plan. Money decides what you may ask for, never what is safe.
   *
   * Moving back to SHADOW is never gated. A customer must always be able to
   * stop controlling things, including one whose trial just expired.
   */
  async setEnvironmentMode(scope: TenantScope, userId: string, mode: EnvironmentMode, reason: string, entitlements?: { mayEnable(organizationId: string, feature: "enforced_mode" | "canary_mode"): Promise<{ decision: "allowed" | "refused"; reason: string; remedy: string | null }> }): Promise<{ mode: EnvironmentMode }> {
    if (!['shadow','canary','enforced'].includes(mode)) throw new Error("Unsupported environment mode");
    if (entitlements && mode !== "shadow") {
      const feature = mode === "enforced" ? "enforced_mode" as const : "canary_mode" as const;
      const verdict = await entitlements.mayEnable(scope.organization_id, feature);
      if (verdict.decision !== "allowed") {
        // The REMEDY travels with the refusal. A commercial dead end that says
        // only "not included" leaves the customer with nothing to do next, and
        // it is the one refusal in this product that always has an answer.
        throw Object.assign(new Error(verdict.reason), {
          statusCode: 402, nyst_blocked_by: "entitlement",
          nyst_remedy: verdict.remedy ?? "Contact sales to enable this mode for your organization.",
        });
      }
    }
    const result = await this.db.query(`WITH changed AS (
      UPDATE nyst_environments SET mode=$4 WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND mode<>$4
      RETURNING mode AS new_mode,(SELECT mode FROM nyst_environments WHERE environment_id=$1) AS previous_mode
    ), audit AS (
      INSERT INTO nyst_environment_mode_audit(audit_id,environment_id,project_id,organization_id,previous_mode,new_mode,changed_by,reason)
      SELECT $5,$1,$2,$3,previous_mode,$4,$6,$7 FROM changed
    )
    -- Read the NEW mode from the CTE, not from the table.
    --
    -- Under READ COMMITTED a data-modifying CTE's writes are not visible to
    -- the rest of the same statement, so "SELECT mode FROM nyst_environments"
    -- here returns the value from before the UPDATE. This endpoint therefore
    -- reported the PREVIOUS mode after a successful change, and a client that
    -- read the response to confirm the switch was told the opposite of the
    -- truth. Same snapshot trap as the blast-radius admission gate.
    --
    -- The left join keeps the no-op case working: setting the mode it is
    -- already in updates nothing, so "changed" is empty and the current value
    -- from the table is both correct and unchanged.
    SELECT COALESCE(c.new_mode, e.mode) AS mode
      FROM nyst_environments e LEFT JOIN changed c ON true
     WHERE e.environment_id=$1 AND e.project_id=$2 AND e.organization_id=$3`,
      [scope.environment_id, scope.project_id, scope.organization_id, mode, randomUUID(), userId, bounded(reason, 500, "mode change reason")]);
    if (!result.rows.length) throw new Error("Resource belongs to a different tenant scope");
    return { mode: normalizeMode(result.rows[0]?.mode) };
  }

  async currentPolicy(scope: TenantScope, effectName?: string): Promise<ConservativePolicy> {
    const result = await this.db.query(`SELECT policy_version_id,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds
      FROM nyst_policy_versions WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND (effect_name=$4 OR effect_name IS NULL)
      ORDER BY (effect_name IS NOT NULL) DESC,version DESC LIMIT 1`, [scope.environment_id, scope.project_id, scope.organization_id, effectName ?? null]);
    const row = result.rows[0]; if (!row) throw new Error("No policy is configured for this environment");
    return { policy_version_id: String(row.policy_version_id), execution_mode: row.execution_mode === "approval_required" ? "approval_required" : "automatic", retry_mode: "never", auto_continuation: row.auto_continuation === true, auto_compensation: row.auto_compensation === true, reconcile_timeout_seconds: Number(row.reconcile_timeout_seconds) };
  }

  /**
   * WHICH immutable policy version would this exact workload bind right now?
   *
   * Readiness must ask the production question, not a weaker one. This calls
   * the same resolver `currentPolicy` uses for real execution — same ordering,
   * same specificity rules — and returns null when nothing would bind, rather
   * than throwing, because "no policy" is an answer readiness must display.
   */
  async effectivePolicyFor(scope: TenantScope, effectName: string): Promise<{ policy_version_id: string; effect_name: string | null; version: number; execution_mode: "automatic" | "approval_required" } | null> {
    const result = await this.db.query(`SELECT policy_version_id,effect_name,version,execution_mode
      FROM nyst_policy_versions WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND (effect_name=$4 OR effect_name IS NULL)
      ORDER BY (effect_name IS NOT NULL) DESC,version DESC LIMIT 1`, [scope.environment_id, scope.project_id, scope.organization_id, effectName]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      policy_version_id: String(row.policy_version_id),
      effect_name: row.effect_name === null ? null : String(row.effect_name),
      version: Number(row.version),
      execution_mode: row.execution_mode === "approval_required" ? "approval_required" : "automatic",
    };
  }

  async policyHistory(scope: TenantScope): Promise<Record<string, unknown>[]> {
    await this.requireTenantScope(scope);
    return (await this.db.query(`SELECT policy_version_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_at
      FROM nyst_policy_versions WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 ORDER BY effect_name NULLS FIRST,version DESC`, [scope.environment_id, scope.project_id, scope.organization_id])).rows;
  }

  async createPolicyVersion(scope: TenantScope, userId: string, input: { effect_name: string | null; execution_mode: "automatic" | "approval_required"; auto_continuation: boolean; auto_compensation: boolean; reconcile_timeout_seconds: number; template_id?: string | null }): Promise<Record<string, unknown>> {
    await this.requireTenantScope(scope);
    if (!['automatic','approval_required'].includes(input.execution_mode) || !Number.isInteger(input.reconcile_timeout_seconds) || input.reconcile_timeout_seconds < 30 || input.reconcile_timeout_seconds > 86400) throw new Error("Invalid conservative policy");
    const id = randomUUID();
    const result = await this.db.query(`INSERT INTO nyst_policy_versions(policy_version_id,environment_id,project_id,organization_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_by,template_id)
      SELECT $1,$2,$3,$4,$5,coalesce(max(version),0)+1,$6,'never',$7,$8,$9,$10,$11 FROM nyst_policy_versions
      WHERE environment_id=$2 AND (effect_name IS NOT DISTINCT FROM $5)
      RETURNING policy_version_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,template_id`,
      [id, scope.environment_id, scope.project_id, scope.organization_id, input.effect_name, input.execution_mode, input.auto_continuation, input.auto_compensation, input.reconcile_timeout_seconds, userId, input.template_id ?? null]);
    await this.audit(scope, userId, "policy.version_created", "policy", id, { effect_name: input.effect_name });
    return result.rows[0]!;
  }

  async bindActionControl(scope: TenantScope, actionId: string, policyVersionId: string, mode: EnvironmentMode): Promise<void> {
    const result = await this.db.query(`INSERT INTO nyst_action_policy_bindings(action_id,policy_version_id,environment_mode,reconcile_deadline_at)
      SELECT $1,p.policy_version_id,e.mode,now()+(p.reconcile_timeout_seconds::text||' seconds')::interval FROM nyst_policy_versions p JOIN nyst_environments e ON e.environment_id=p.environment_id
      JOIN nyst_action_scopes s ON s.action_id=$1 AND s.environment_id=e.environment_id AND s.project_id=e.project_id AND s.organization_id=e.organization_id
      WHERE p.policy_version_id=$2 AND e.environment_id=$3 AND e.project_id=$4 AND e.organization_id=$5 AND e.mode=$6
      ON CONFLICT(action_id) DO NOTHING RETURNING action_id`, [actionId, policyVersionId, scope.environment_id, scope.project_id, scope.organization_id, mode]);
    const check = await this.db.query(`SELECT 1 FROM nyst_action_policy_bindings WHERE action_id=$1 AND policy_version_id=$2 AND environment_mode=$3`, [actionId, policyVersionId, mode]);
    if (!result.rows.length && !check.rows.length) throw new Error("Action policy/mode binding is stale or belongs to another environment");
  }

  /**
   * Record a Shadow evaluation.
   *
   * v0.2.1 checked only that the effect was enabled, never the VERSION, and
   * derived the result with hand-written per-provider comparison logic that
   * could drift from Enforced. Both are fixed:
   *
   *   - the caller must name the EXACT version the environment has enabled;
   *     there is no implicit current/latest substitution;
   *   - derivation runs the shared EffectSpec pipeline (primitives A-E) via
   *     deriveShadowSemantics, so Shadow and Enforced cannot disagree;
   *   - the version is persisted, so a later environment version change never
   *     reinterprets a historical Shadow record.
   */
  async recordShadowEvaluation(scope: TenantScope, effectName: string, businessKey: string, observation: ShadowObservation, specVersion: string, agentId: string | null = null): Promise<Record<string, unknown>> {
    const control = await this.environmentControl(scope);
    if (control.mode !== "shadow") throw new Error("Shadow evaluations require a Shadow environment");
    const configured = await this.db.query(`SELECT enabled,spec_version FROM nyst_environment_effect_specs WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND effect_name=$4`,
      [scope.environment_id, scope.project_id, scope.organization_id, effectName]);
    const row = configured.rows[0];
    if (row?.enabled !== true) throw new Error("Shadow EffectSpec is unavailable or disabled for this environment");
    if (String(row.spec_version) !== specVersion) {
      throw new Error(`Shadow requires the exact enabled EffectSpec version. ${effectName} is enabled at ${String(row.spec_version)}; ${specVersion} was requested.`);
    }
    assertShadowObservationSchema(effectName, observation.provider_state ?? {});
    // A-E only. There is no provider dispatch on this path.
    const derivation = deriveShadowSemantics(effectName, specVersion, observation);
    const id = randomUUID();
    const result = await this.db.query(`INSERT INTO nyst_shadow_evaluations(shadow_evaluation_id,environment_id,project_id,organization_id,effect_name,spec_version,agent_id,business_key,observation,observed_ambiguous,attempted_retry,attempted_continuation,retry_would_have_been_blocked,continuation_would_have_been_blocked,assessment)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(environment_id,effect_name,business_key) DO UPDATE SET observation=excluded.observation,spec_version=excluded.spec_version,agent_id=excluded.agent_id,observed_ambiguous=excluded.observed_ambiguous,attempted_retry=excluded.attempted_retry,attempted_continuation=excluded.attempted_continuation,retry_would_have_been_blocked=excluded.retry_would_have_been_blocked,continuation_would_have_been_blocked=excluded.continuation_would_have_been_blocked,assessment=excluded.assessment
      WHERE nyst_shadow_evaluations.project_id=excluded.project_id AND nyst_shadow_evaluations.organization_id=excluded.organization_id
      RETURNING shadow_evaluation_id,effect_name,spec_version,business_key,assessment,created_at`,
      [id, scope.environment_id, scope.project_id, scope.organization_id, bounded(effectName, 200, "effect"), bounded(specVersion, 200, "spec version"), agentId,
       bounded(businessKey, 463, "business key"), observation, derivation.observed_ambiguous, observation.attempted_retry, observation.attempted_continuation,
       derivation.retry_would_have_been_blocked, derivation.continuation_would_have_been_blocked, derivation]);
    if (!result.rows.length) throw new Error("Shadow record belongs to a different tenant scope");
    const stored = result.rows[0]!;
    const shadowId = String(stored.shadow_evaluation_id);
    // Shadow interventions are counterfactual. The schema itself forbids a
    // Shadow row from carrying an Enforced prevention kind.
    if (derivation.retry_would_have_been_blocked) {
      await this.recordIntervention(scope, { kind: "shadow_retry_would_have_been_blocked", shadow_evaluation_id: shadowId, agent_id: agentId,
        effect_name: effectName, mode: "shadow", intervention_key: `shadow_retry:${shadowId}`,
        summary: "Enforced Mode would have blocked this retry. Shadow did not control the action.",
        detail: { effect_state: derivation.effect_state, spec_version: specVersion } });
    }
    if (derivation.continuation_would_have_been_blocked) {
      await this.recordIntervention(scope, { kind: "shadow_continuation_would_have_been_blocked", shadow_evaluation_id: shadowId, agent_id: agentId,
        effect_name: effectName, mode: "shadow", intervention_key: `shadow_continuation:${shadowId}`,
        summary: "Enforced Mode would have held this continuation. Shadow did not control the action.",
        detail: { effect_state: derivation.effect_state, spec_version: specVersion } });
    }
    return stored;
  }

  /**
   * THE canonical metric service.
   *
   * Overview, the Protection Report, and the impact API all call this. v0.2.1
   * had `overview()` and `impactMetrics()` computing differently-named,
   * differently-defined versions of the same idea, and the Overview card read
   * a field the backend never produced, so real Enforced prevention rendered
   * as 0.
   *
   * Grounding rules encoded in the SQL below:
   *   - demo environments are excluded;
   *   - Failure Lab runs live in their own table and are never counted;
   *   - "prevented" counts come only from durable Canary/Enforced intervention
   *     records; Shadow can only ever contribute to "detected";
   *   - every count is DISTINCT on the logical subject, so a scheduler run,
   *     a repeated observation, or a page refresh cannot inflate it.
   */
  async canonicalMetrics(scope: TenantScope, rangeLabel: MetricRange["label"] = "all", from?: string, to?: string, now: Date = new Date()): Promise<CanonicalMetrics> {
    const control = await this.environmentControl(scope);
    const range = resolveRange(rangeLabel, from, to, now);
    if (control.is_demo) {
      // A demo environment has no production truth to report. Returning a
      // fully-typed zeroed contract is honest; inventing numbers is not.
      return { ...emptyMetrics(control.mode, range) };
    }
    const params = [scope.environment_id, scope.project_id, scope.organization_id, range.from, range.sql_upper_bound];
    const result = await this.db.query(`WITH scoped_actions AS (
        SELECT s.action_id,s.agent_id,a.effect_name,coalesce(a.dispatch_plan->>'provider',split_part(a.effect_name,'.',1)) provider,a.created_at
        FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id)
        JOIN nyst_environments env ON env.environment_id=s.environment_id AND env.project_id=s.project_id AND env.organization_id=s.organization_id
        WHERE s.environment_id=$1 AND s.project_id=$2 AND s.organization_id=$3 AND env.is_demo=false
          AND a.created_at>=$4::timestamptz AND ($5::timestamptz IS NULL OR a.created_at<=$5::timestamptz)
      ), active_evidence AS (
        SELECT e.* FROM outcome_evidence e JOIN scoped_actions s USING(action_id)
        WHERE NOT EXISTS(SELECT 1 FROM outcome_evidence correction WHERE correction.action_id=e.action_id AND correction.supersedes_evidence_id=e.evidence_id)
      ), ambiguous AS (
        SELECT DISTINCT action_id FROM active_evidence WHERE kind='transport_error' OR strength='transport_only'
      ), scoped_interventions AS (
        SELECT i.* FROM nyst_intervention_events i
        WHERE i.environment_id=$1 AND i.project_id=$2 AND i.organization_id=$3
          AND ($5::timestamptz IS NULL OR i.occurred_at<=$5::timestamptz) AND i.occurred_at>=$4::timestamptz
      ), latest AS (
        SELECT DISTINCT ON(t.action_id) t.* FROM nyst_resolution_transitions t JOIN scoped_actions s USING(action_id)
        ORDER BY t.action_id,t.resolution_sequence DESC,t.transition_id DESC
      ), durations AS (
        SELECT extract(epoch FROM (t.occurred_at-s.created_at))*1000 duration_ms FROM latest t JOIN scoped_actions s USING(action_id)
        WHERE t.effect_state IN('verified','not_applied','compensated','satisfied_unattributed')
      ) SELECT
        (SELECT count(*)::int FROM scoped_actions) consequential_actions,
        (SELECT count(*)::int FROM ambiguous) ambiguous_executions,
        (SELECT count(DISTINCT action_id)::int FROM scoped_interventions WHERE kind='retry_blocked' AND mode IN('canary','enforced')) unsafe_retries_prevented_enforced,
        (SELECT count(DISTINCT action_id)::int FROM scoped_interventions WHERE kind='continuation_blocked' AND mode IN('canary','enforced')) unsafe_continuations_prevented_enforced,
        (SELECT count(DISTINCT shadow_evaluation_id)::int FROM scoped_interventions WHERE kind='shadow_retry_would_have_been_blocked') unsafe_retries_detected_shadow,
        (SELECT count(DISTINCT shadow_evaluation_id)::int FROM scoped_interventions WHERE kind='shadow_continuation_would_have_been_blocked') unsafe_continuations_detected_shadow,
        (SELECT count(DISTINCT action_id)::int FROM scoped_interventions WHERE kind='auto_resolved') auto_resolved,
        (SELECT count(DISTINCT action_id)::int FROM scoped_interventions WHERE kind='human_review_opened') human_escalations,
        (SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms) FROM durations) median_reconciliation_duration_ms,
        (SELECT coalesce(jsonb_object_agg(key,count),'{}'::jsonb) FROM (SELECT provider key,count(*)::int count FROM scoped_actions GROUP BY provider) q) provider_breakdown,
        (SELECT coalesce(jsonb_object_agg(key,count),'{}'::jsonb) FROM (SELECT effect_name key,count(*)::int count FROM scoped_actions GROUP BY effect_name) q) effect_breakdown,
        (SELECT coalesce(jsonb_object_agg(key,count),'{}'::jsonb) FROM (
          SELECT coalesce(ag.name,'unattributed') key,count(*)::int count FROM scoped_actions sa
          LEFT JOIN nyst_agents ag ON ag.agent_id=sa.agent_id GROUP BY coalesce(ag.name,'unattributed')) q) agent_breakdown`, params);

    const row = result.rows[0];
    if (!row) throw new Error("Nyst metric contract violation: the canonical metrics query returned no row.");

    const interventions = await this.db.query(`SELECT i.intervention_id,i.kind,i.action_id,i.shadow_evaluation_id,i.agent_id,ag.name agent_name,i.effect_name,i.mode,i.summary,i.occurred_at
      FROM nyst_intervention_events i LEFT JOIN nyst_agents ag ON ag.agent_id=i.agent_id
      WHERE i.environment_id=$1 AND i.project_id=$2 AND i.organization_id=$3 AND ($5::timestamptz IS NULL OR i.occurred_at<=$5::timestamptz) AND i.occurred_at>=$4::timestamptz
      ORDER BY i.occurred_at DESC,i.intervention_id DESC LIMIT 12`, params);

    return {
      mode: control.mode,
      range,
      consequential_actions: requireMetricInt(row, "consequential_actions"),
      ambiguous_executions: requireMetricInt(row, "ambiguous_executions"),
      unsafe_retries_prevented_enforced: requireMetricInt(row, "unsafe_retries_prevented_enforced"),
      unsafe_retries_detected_shadow: requireMetricInt(row, "unsafe_retries_detected_shadow"),
      unsafe_continuations_prevented_enforced: requireMetricInt(row, "unsafe_continuations_prevented_enforced"),
      unsafe_continuations_detected_shadow: requireMetricInt(row, "unsafe_continuations_detected_shadow"),
      auto_resolved: requireMetricInt(row, "auto_resolved"),
      human_escalations: requireMetricInt(row, "human_escalations"),
      median_reconciliation_duration_ms: optionalMetricNumber(row, "median_reconciliation_duration_ms"),
      recent_interventions: interventions.rows.map((item): InterventionSummary => ({
        intervention_id: String(item.intervention_id),
        kind: item.kind as InterventionKind,
        action_id: item.action_id ? String(item.action_id) : null,
        shadow_evaluation_id: item.shadow_evaluation_id ? String(item.shadow_evaluation_id) : null,
        agent_id: item.agent_id ? String(item.agent_id) : null,
        agent_name: item.agent_name ? String(item.agent_name) : null,
        effect_name: String(item.effect_name),
        mode: item.mode as EnvironmentMode,
        summary: String(item.summary),
        occurred_at: new Date(String(item.occurred_at)).toISOString(),
      })),
      provider_breakdown: requireBreakdown(row, "provider_breakdown"),
      effect_breakdown: requireBreakdown(row, "effect_breakdown"),
      agent_breakdown: requireBreakdown(row, "agent_breakdown"),
      metric_definitions: METRIC_DEFINITIONS,
    };
  }

  /**
   * Back-compatible alias. Kept so existing API consumers keep working, but it
   * now returns the SAME canonical contract rather than a second definition.
   */
  async impactMetrics(scope: TenantScope): Promise<CanonicalMetrics> { return this.canonicalMetrics(scope); }

  /** Overview reads the canonical contract. There is no second definition. */
  async overview(scope: TenantScope): Promise<CanonicalMetrics> { return this.canonicalMetrics(scope); }

  /** The raw facts one provider's readiness and capability manifest are both built from. */
  private async integrationFacts(scope:TenantScope,provider:string,now:Date):Promise<{
    credentialRef:string|null;configured:boolean;enabledEffects:string[];
    lastStatus:PreflightStatus|null;lastAt:string|null;scopeResult:unknown;accountIdentity:string|null;
    resourceCoverage:string[];attestations:CapabilityAttestation[];stale:boolean;
  }>{
    const row=(await this.db.query(`SELECT i.credential_ref,i.configured,p.status last_status,p.performed_at last_at,
        p.scope_result last_scope_result,p.account_identity last_account_identity,p.resource_result last_resource_result,
        (SELECT coalesce(array_agg(effect_name ORDER BY effect_name),ARRAY[]::text[]) FROM nyst_environment_effect_specs
          WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND enabled AND split_part(effect_name,'.',1)=$4) enabled_effects
      FROM (SELECT 1) one
      -- disconnected_at IS NULL: a disconnected integration is not an
      -- integration. Without this the row keeps answering and readiness
      -- keeps saying ready for a connection the customer switched off.
      LEFT JOIN nyst_integrations i ON i.environment_id=$1 AND i.project_id=$2 AND i.organization_id=$3 AND i.provider=$4 AND i.disconnected_at IS NULL
      LEFT JOIN LATERAL (SELECT status,performed_at,scope_result,account_identity,resource_result
        FROM nyst_integration_preflights
        WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND provider=$4
          -- A preflight proves the credential it was RUN AGAINST. If the
          -- integration now points somewhere else, that verdict says nothing
          -- about the credential in use, so readiness drops rather than
          -- inheriting it for the rest of the twelve-hour window (issue 11).
          --
          -- Compared by IDENTITY, not by time. The first attempt compared
          -- performed_at against the integration's configured-at stamp, and the
          -- existing readiness tests caught it at once: performed_at comes from
          -- the APPLICATION clock and the integration row is stamped by the
          -- DATABASE clock, so a preflight run milliseconds after a configure
          -- could compare as earlier and a freshly verified integration
          -- reported unverified. Identity also correctly treats rotating away
          -- and back to the same reference as still verified.
          --
          -- The lateral now also carries the full tenant tuple; it was the one
          -- scoping query in this subsystem that did not.
          AND credential_ref IS NOT DISTINCT FROM i.credential_ref
        ORDER BY performed_at DESC LIMIT 1) p ON true`,
      [scope.environment_id,scope.project_id,scope.organization_id,provider])).rows[0]??{};
    const attestations=(await this.db.query(`SELECT c.capability,u.email attested_by,c.attested_at
      FROM nyst_capability_attestations c JOIN nyst_users u ON u.user_id=c.attested_by
      WHERE c.environment_id=$1 AND c.project_id=$2 AND c.organization_id=$3 AND c.provider=$4 AND c.revoked_at IS NULL`,
      [scope.environment_id,scope.project_id,scope.organization_id,provider])).rows
      .map(item=>({capability:String(item.capability),attested_by:String(item.attested_by),attested_at:new Date(String(item.attested_at)).toISOString()}));
    const lastAt=row.last_at?new Date(String(row.last_at)).toISOString():null;
    const resource=row.last_resource_result&&typeof row.last_resource_result==="object"
      ? Object.values(row.last_resource_result as Record<string,unknown>).filter((item):item is string=>typeof item==="string") : [];
    return {
      credentialRef:typeof row.credential_ref==="string"?row.credential_ref:null,
      configured:row.configured===true&&typeof row.credential_ref==="string",
      enabledEffects:Array.isArray(row.enabled_effects)?row.enabled_effects.map(String):[],
      lastStatus:(row.last_status as PreflightStatus|undefined)??null,
      lastAt, scopeResult:row.last_scope_result,
      accountIdentity:row.last_account_identity?String(row.last_account_identity):null,
      resourceCoverage:resource, attestations, stale:isPreflightStale(lastAt,now),
    };
  }

  /**
   * The durable CapabilityManifest for one provider connection.
   *
   * There is no `connected: true` anywhere in this product. Each required
   * capability carries one of six states and the reason it is in that state,
   * and an attestation is always labelled as a claim rather than an
   * observation.
   */
  async capabilityManifest(scope:TenantScope,provider:string,now:Date=new Date()):Promise<ProviderCapabilityManifest>{
    if(!["github","okta","stripe"].includes(provider))throw new Error("Unsupported integration provider");
    return this.composeCapabilityManifest(provider,await this.integrationFacts(scope,provider,now));
  }

  private composeCapabilityManifest(provider:string,facts:Awaited<ReturnType<ProductRepository["integrationFacts"]>>):ProviderCapabilityManifest{
    const observed=observedCapabilities(provider,facts.scopeResult);
    const verifiedPreflight=facts.lastStatus==="verified_ready";
    const raw=facts.scopeResult&&typeof facts.scopeResult==="object"?(facts.scopeResult as {scopes?:unknown}).scopes:undefined;
    const scopes=Array.isArray(raw)?raw.filter((item):item is string=>typeof item==="string"):[];
    return buildCapabilityManifest({
      provider, account_identity:facts.accountIdentity,
      required:requiredCapabilityRecords(facts.enabledEffects),
      // Nothing is observed until a preflight actually succeeded. A failed
      // preflight tells us about the credential, not about its capabilities.
      granted_scopes:verifiedPreflight?scopes:[],
      verified_capabilities:verifiedPreflight?observed.verified:[],
      refused_capabilities:facts.lastStatus==="insufficient_permission"?requiredCapabilities(facts.enabledEffects):[],
      attestations:facts.attestations,
      resource_coverage:facts.resourceCoverage,
      observed_at:facts.lastAt, stale:facts.stale,
    });
  }

  async integrationReadiness(scope:TenantScope,provider:string,secrets:SecretProvider,now:Date=new Date()):Promise<IntegrationReadiness>{
    if(!["github","okta","stripe"].includes(provider))throw new Error("Unsupported integration provider");
    const facts=await this.integrationFacts(scope,provider,now);
    const credential=facts.configured?await probeCredentialAvailability(secrets,facts.credentialRef):{available:false,category:"credential_unavailable" as const};
    const manifest=this.composeCapabilityManifest(provider,facts);
    return composeReadiness({
      provider, available:true, enabled:facts.enabledEffects.length>0, configured:facts.configured,
      credential_available:credential.available, credential_failure:credential.category,
      last_preflight_at:facts.lastAt, last_preflight_status:facts.lastStatus,
      enabled_effect_specs:facts.enabledEffects,
      // Capability sufficiency compares what the enabled workloads REQUIRE
      // against what was actually observed or explicitly attested. A credential
      // that resolves and authenticates can still be unable to perform the
      // consequence, and that must not read as Ready.
      required_capabilities:requiredCapabilities(facts.enabledEffects),
      granted_capabilities:sufficientCapabilities(manifest),
      capability_manifest:manifest,
      now,
    });
  }

  /**
   * Record an operator's claim that a credential holds a capability Nyst could
   * not observe. This is a claim, not evidence, and is stored and shown as such.
   */
  async attestCapability(scope:TenantScope,userId:string,provider:string,capability:string,justification:string):Promise<Record<string,unknown>>{
    if(!["github","okta","stripe"].includes(provider))throw Object.assign(new Error("Unsupported integration provider"),{statusCode:400});
    await this.requireTenantScope(scope);
    const known=new Set(Object.values(CAPABILITY_MANIFEST).flat().map(item=>item.capability));
    if(!known.has(capability))throw Object.assign(new Error("Unknown capability token"),{statusCode:400});
    if(!capability.startsWith(`${provider}:`))throw Object.assign(new Error("That capability does not belong to this provider"),{statusCode:400});
    if(justification.trim().length<10)throw Object.assign(new Error("An attestation requires a justification of at least 10 characters"),{statusCode:400});
    const inserted=await this.db.query(`INSERT INTO nyst_capability_attestations(attestation_id,environment_id,project_id,organization_id,provider,capability,attested_by,justification)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (environment_id,provider,capability) WHERE revoked_at IS NULL DO NOTHING
      RETURNING attestation_id,capability,attested_at`,
      [randomUUID(),scope.environment_id,scope.project_id,scope.organization_id,provider,capability,userId,justification.trim()]);
    if(!inserted.rows[0])throw Object.assign(new Error("A live attestation for that capability already exists"),{statusCode:409});
    return {...inserted.rows[0]!,attested_not_observed:true};
  }

  /** Withdraw an attestation. The row survives; only a withdrawal is recorded. */
  async revokeCapabilityAttestation(scope:TenantScope,userId:string,attestationId:string):Promise<boolean>{
    await this.requireTenantScope(scope);
    const result=await this.db.query(`UPDATE nyst_capability_attestations SET revoked_at=now(),revoked_by=$4
      WHERE attestation_id=$1 AND environment_id=$2 AND organization_id=$3 AND revoked_at IS NULL RETURNING attestation_id`,
      [attestationId,scope.environment_id,scope.organization_id,userId]);
    return result.rows.length>0;
  }

  /**
   * Run and persist a bounded READ-ONLY provider preflight.
   *
   * Invariant I20: preflight may never mutate provider state. The persisted
   * row carries a CHECK constraint fixing provider_mutation_performed=false,
   * and runPreflight throws if a probe self-reports a mutation.
   */
  /**
   * Stop Nyst using a provider connection (v0.3.2 Phase 11).
   *
   * WHAT THIS DOES: blocks NEW provider work, and invalidates readiness -- a
   * disconnected integration is not ready, so nothing that requires it can be
   * admitted.
   *
   * WHAT THIS DOES NOT DO, stated plainly because a control that looks like a
   * kill switch and is not one is worse than none: it does not stop work
   * ALREADY ADMITTED. The integration is consulted at admission, and the
   * scheduler, recovery worker and provider clients read the environment
   * directly. Emergency Freeze is the thing that stops in-flight consequence.
   *
   * HISTORY IS RETAINED. Evidence, receipts, WorldFacts and audit rows all
   * survive. Disconnecting a provider today does not make yesterday's
   * observations untrue -- it makes them STALE, so an outcome that depends on
   * fresh evidence correctly becomes INDETERMINATE instead of quietly keeping
   * a verdict nothing supports any more.
   */
  async disconnectIntegration(scope: TenantScope, userId: string, provider: string, reason: string): Promise<{ disconnected: boolean }> {
    await this.requireTenantScope(scope);
    if (!["github","okta","stripe"].includes(provider)) throw Object.assign(new Error("Unsupported integration provider"), { statusCode: 400 });
    if (reason.trim().length < 5) {
      throw Object.assign(new Error("Disconnecting an integration requires a reason a person can read"), { statusCode: 400 });
    }
    const result = await this.db.query(
      `UPDATE nyst_integrations
         SET disconnected_at=now(), disconnected_by=$5, disconnect_reason=$6, configured=false
       WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND provider=$4 AND disconnected_at IS NULL
       RETURNING integration_id`,
      [scope.environment_id, scope.project_id, scope.organization_id, provider, userId, reason.trim()]);
    return { disconnected: result.rows.length === 1 };
  }

  /**
   * Reconnect. A deliberate act that clears the disconnection entirely.
   *
   * It does NOT restore readiness: the credential must be preflighted again,
   * because nothing here knows whether it still works. That is the same rule
   * rotation follows.
   */
  async reconnectIntegration(scope: TenantScope, provider: string, credentialRef: string): Promise<Record<string, unknown>> {
    await this.db.query(
      `UPDATE nyst_integrations SET disconnected_at=NULL, disconnected_by=NULL, disconnect_reason=NULL
       WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND provider=$4`,
      [scope.environment_id, scope.project_id, scope.organization_id, provider]);
    return this.configureIntegration(scope, provider, credentialRef);
  }

  async runIntegrationPreflight(scope:TenantScope,provider:string,secrets:SecretProvider,probe:PreflightProbe,now:Date=new Date()):Promise<Record<string,unknown>>{
    if(!["github","okta","stripe"].includes(provider))throw new Error("Unsupported integration provider");
    await this.requireTenantScope(scope);
    const row=(await this.db.query(`SELECT credential_ref,configured FROM nyst_integrations WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND provider=$4 AND disconnected_at IS NULL`,
      [scope.environment_id,scope.project_id,scope.organization_id,provider])).rows[0];
    const reference=row?.configured===true&&typeof row.credential_ref==="string"?row.credential_ref:null;
    const record=await runPreflight(provider,reference,secrets,probe,now);
    // The reference this preflight actually tested is recorded alongside it, so
    // readiness can tell whether the verdict says anything about the credential
    // configured NOW. See 0030 for why that is an identity check rather than a
    // timestamp comparison (v0.3.1 issue 11).
    const stored=await this.db.query(`INSERT INTO nyst_integration_preflights(preflight_id,environment_id,project_id,organization_id,provider,status,account_identity,scope_result,resource_result,failure_detail,provider_mutation_performed,performed_at,credential_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12) RETURNING preflight_id,provider,status,account_identity,scope_result,resource_result,failure_detail,provider_mutation_performed,performed_at`,
      [randomUUID(),scope.environment_id,scope.project_id,scope.organization_id,provider,record.status,record.account_identity,record.scope_result,record.resource_result,record.failure_detail,record.performed_at,reference]);
    if(record.status==="verified_ready"){
      await this.db.query(`UPDATE nyst_integrations SET last_verified_at=$5 WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND provider=$4`,
        [scope.environment_id,scope.project_id,scope.organization_id,provider,record.performed_at]);
    }
    return { ...stored.rows[0]!, read_only_preflight_performed: true };
  }

  /** Every configured provider's readiness in one call, for the Integrations page. */
  async integrationsReadiness(scope:TenantScope,secrets:SecretProvider,now:Date=new Date()):Promise<IntegrationReadiness[]>{
    return Promise.all((["github","okta","stripe"] as const).map((provider)=>this.integrationReadiness(scope,provider,secrets,now)));
  }

  async preflightHistory(scope:TenantScope,provider:string,limit=10):Promise<Record<string,unknown>[]>{
    return (await this.db.query(`SELECT preflight_id,provider,status,account_identity,scope_result,resource_result,failure_detail,provider_mutation_performed,performed_at
      FROM nyst_integration_preflights WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND provider=$4 ORDER BY performed_at DESC LIMIT $5`,
      [scope.environment_id,scope.project_id,scope.organization_id,provider,Math.min(Math.max(1,limit),50)])).rows;
  }

  /*
   * `markIntegrationVerified` was REMOVED in v0.3.1 (issue 11).
   *
   * It set last_verified_at=now() with no preflight, and had zero callers, so
   * it was never a live bypass. But it was a mark-ready-without-verifying
   * primitive sitting in the codebase waiting for someone to reach for it, and
   * this product's whole claim is that "ready" means verified. Verification
   * comes from `runIntegrationPreflight` and nowhere else.
   */

  async recordResolutionTransition(actionId:string,resolutionValue:unknown,origin:"action_commit"|"scheduler"|"manual_reconcile"|"recovery_worker"|"human_review"|"compensation"|"backfill"):Promise<boolean>{
    const resolution=resolutionValue as OutcomeResolution;if(!resolution?.effect||!resolution.control||!resolution.runtime||!resolution.trust)throw new Error("Canonical OutcomeResolution required");
    const eventType=resolution.effect.state==="pending"?"action.pending":"effect.resolved";const transitionId=randomUUID();const eventId=randomUUID();
    const payload={event_schema_version:1,event_id:eventId,event_type:eventType,timestamp:resolution.trust.resolved_at,action_id:actionId,effect_name:resolution.effect_name,spec_version:resolution.control.spec_version,resolution_id:resolution.resolution_id,resolution_sequence:resolution.runtime.resolution_sequence,evidence_sequence:resolution.runtime.evidence_sequence,effect_state:resolution.effect.state,control:{primary:resolution.control.primary,retry:resolution.control.retry,continuation:resolution.control.continuation,recovery:resolution.control.recovery},receipt_ref:`/v1/actions/${actionId}/receipt`};
    const result=await this.db.query(`WITH scoped AS (
        SELECT s.*,b.environment_mode FROM nyst_action_scopes s JOIN nyst_action_policy_bindings b USING(action_id) WHERE s.action_id=$2
      ), transition AS (
        INSERT INTO nyst_resolution_transitions(transition_id,action_id,resolution_id,environment_id,project_id,organization_id,origin,event_type,effect_state,primary_directive,retry_disposition,continuation_disposition,recovery_disposition,resolution_sequence,evidence_sequence,receipt_ref,occurred_at)
        SELECT $1,$2,$3,environment_id,project_id,organization_id,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 FROM scoped
        ON CONFLICT(action_id,resolution_id) DO NOTHING RETURNING *
      ), controls AS (
        INSERT INTO nyst_control_events(control_event_id,transition_id,action_id,environment_id,project_id,organization_id,event_kind)
        SELECT k.id,t.transition_id,t.action_id,t.environment_id,t.project_id,t.organization_id,k.kind FROM transition t CROSS JOIN LATERAL(VALUES
          ($17::uuid,'retry_blocked'::text,t.retry_disposition='forbidden' AND EXISTS(SELECT 1 FROM outcome_evidence e WHERE e.action_id=t.action_id AND (e.kind='transport_error' OR e.strength='transport_only'))),
          ($18::uuid,'continuation_blocked'::text,t.continuation_disposition='blocked' AND EXISTS(SELECT 1 FROM outcome_evidence e WHERE e.action_id=t.action_id AND (e.kind='transport_error' OR e.strength='transport_only')))
        ) k(id,kind,active) WHERE k.active ON CONFLICT DO NOTHING RETURNING control_event_id
      ), webhook AS (
        INSERT INTO nyst_webhook_events(webhook_event_id,webhook_endpoint_id,action_id,resolution_id,resolution_sequence,evidence_sequence,event_type,payload,occurred_at,event_schema_version)
        SELECT $15,w.webhook_endpoint_id,t.action_id,t.resolution_id,t.resolution_sequence,t.evidence_sequence,t.event_type,$16,t.occurred_at,1 FROM transition t JOIN nyst_webhook_endpoints w ON w.environment_id=t.environment_id AND w.project_id=t.project_id AND w.organization_id=t.organization_id AND w.enabled
        ON CONFLICT(webhook_endpoint_id,action_id,resolution_id,event_type) DO NOTHING RETURNING webhook_event_id
      ) SELECT transition_id FROM transition`,[transitionId,actionId,resolution.resolution_id,origin,eventType,resolution.effect.state,resolution.control.primary,resolution.control.retry,resolution.control.continuation,resolution.control.recovery,resolution.runtime.resolution_sequence,resolution.runtime.evidence_sequence,`/v1/actions/${actionId}/receipt`,resolution.trust.resolved_at,eventId,payload,randomUUID(),randomUUID()]);
    // Durable intervention records (1K). Keyed on the LOGICAL intervention, so
    // scheduler runs, repeated observations, and webhook retries collapse onto
    // one row instead of inflating the count. Only a controlling mode
    // (canary/enforced) may record a prevention; Shadow physically cannot,
    // because a Shadow row has no action-bound policy binding and the schema
    // check constraint forbids the kind.
    await this.recordInterventionsForTransition(actionId,resolution);
    return result.rows.length===1;
  }

  /**
   * A bound policy reconciliation deadline expired.
   *
   * v0.2.1 deleted the job row, but `scheduler.sync()` re-derives jobs from
   * `outcome_runtime.next_check_at`, so the very next sync — or any process
   * restart — resurrected automatic reconciliation on an action that had
   * already been escalated to a human.
   *
   * Suppression is now a durable product-level fact in
   * `nyst_reconciliation_suppressions`, which `sync()` consults. Note what is
   * deliberately NOT done here:
   *   - the external EffectState is not touched (I14: a policy timeout can
   *     change control behaviour but can never change external truth);
   *   - `outcome_runtime.next_check_at` is preserved as historical runtime
   *     evidence, it simply stops being an authority to schedule work.
   * Human Review can still request a NEW read-only re-observation.
   */
  /**
   * Derive the durable interventions implied by a transition.
   *
   * An intervention is recorded only when Nyst ACTUALLY controlled the action
   * (canary/enforced) AND the action was genuinely ambiguous — a forbidden
   * retry on an unambiguous action is not a prevention, it is just policy.
   */
  private async recordInterventionsForTransition(actionId:string,resolution:OutcomeResolution):Promise<void>{
    const context=(await this.db.query(`SELECT s.environment_id,s.project_id,s.organization_id,s.agent_id,a.effect_name,b.environment_mode,
        EXISTS(SELECT 1 FROM outcome_evidence e WHERE e.action_id=s.action_id AND (e.kind='transport_error' OR e.strength='transport_only')
          AND NOT EXISTS(SELECT 1 FROM outcome_evidence c WHERE c.action_id=e.action_id AND c.supersedes_evidence_id=e.evidence_id)) ambiguous
      FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) JOIN nyst_action_policy_bindings b USING(action_id)
      WHERE s.action_id=$1`,[actionId])).rows[0];
    if(!context)return;
    const mode=normalizeMode(context.environment_mode);
    if(mode==="shadow")return; // Shadow never prevents anything.
    if(context.ambiguous!==true)return;
    const scope={environment_id:String(context.environment_id),project_id:String(context.project_id),organization_id:String(context.organization_id)};
    const base={action_id:actionId,agent_id:context.agent_id?String(context.agent_id):null,effect_name:String(context.effect_name),mode} as const;
    if(resolution.control.retry==="forbidden"){
      await this.recordIntervention(scope,{...base,kind:"retry_blocked",intervention_key:`retry_blocked:${actionId}`,
        summary:"Nyst blocked an unsafe retry after execution became ambiguous.",
        detail:{effect_state:resolution.effect.state,reason_code:resolution.control.reason_code}});
    }
    if(resolution.control.continuation==="blocked"){
      await this.recordIntervention(scope,{...base,kind:"continuation_blocked",intervention_key:`continuation_blocked:${actionId}`,
        summary:"Nyst held an unsafe downstream continuation until the external effect was established.",
        detail:{effect_state:resolution.effect.state,reason_code:resolution.control.reason_code}});
    }
  }

  async escalateOverdueReconciliations(nowIso=new Date().toISOString(),environmentId:string|null=null):Promise<number>{
    const overdue=await this.db.query(`SELECT s.action_id,s.environment_id,s.project_id,s.organization_id,s.agent_id,a.effect_name,b.environment_mode,r.resolution_id
      FROM nyst_action_scopes s JOIN nyst_action_policy_bindings b USING(action_id) JOIN outcome_actions a ON a.action_id=s.action_id
      JOIN LATERAL(SELECT resolution_id,effect_state,primary_directive FROM outcome_resolutions WHERE action_id=s.action_id ORDER BY resolution_sequence DESC NULLS LAST,resolution_id DESC LIMIT 1) r ON true
      WHERE b.reconcile_deadline_at<=$1 AND ($2::uuid IS NULL OR s.environment_id=$2::uuid)
        AND r.effect_state IN('pending','unprovable') AND NOT EXISTS(SELECT 1 FROM nyst_human_reviews h WHERE h.action_id=s.action_id)`,[nowIso,environmentId]);
    let count=0;
    for(const row of overdue.rows){
      const reviewId=randomUUID();
      const inserted=await this.db.query(`WITH review AS (
          INSERT INTO nyst_human_reviews(human_review_id,action_id,environment_id,project_id,organization_id,status,reason)
          VALUES($1,$2,$3,$4,$5,'open','Policy reconciliation deadline expired; external truth is unchanged and human review is required.') ON CONFLICT(action_id) DO NOTHING RETURNING *
        ), suppression AS (
          INSERT INTO nyst_reconciliation_suppressions(action_id,environment_id,project_id,organization_id,reason,source)
          SELECT action_id,environment_id,project_id,organization_id,'Policy reconciliation deadline expired and the action was escalated to human review.','policy_deadline' FROM review
          ON CONFLICT(action_id) DO NOTHING
        ), stopped AS (DELETE FROM nyst_reconciliation_jobs WHERE action_id=(SELECT action_id FROM review))
        SELECT human_review_id FROM review`,[reviewId,row.action_id,row.environment_id,row.project_id,row.organization_id]);
      if(inserted.rows.length){
        count++;
        await this.recordIntervention({ environment_id:String(row.environment_id), project_id:String(row.project_id), organization_id:String(row.organization_id) },
          { kind:"human_review_opened", action_id:String(row.action_id), agent_id:row.agent_id?String(row.agent_id):null,
            effect_name:String(row.effect_name), mode:normalizeMode(row.environment_mode),
            intervention_key:`human_review_opened:${row.action_id}`,
            summary:"Policy reconciliation deadline reached; Nyst stopped automatic reconciliation and escalated.",
            detail:{ source:"policy_deadline", resolution_id:String(row.resolution_id) } });
        await this.queueLifecycleWebhookByAction(String(row.action_id),"human_review.required");
      }
    }
    return count;
  }

  /** Lift a suppression. Explicit, audited, and never automatic. */
  async liftReconciliationSuppression(scope:TenantScope,userId:string,actionId:string):Promise<boolean>{
    const result=await this.db.query(`DELETE FROM nyst_reconciliation_suppressions WHERE action_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4 RETURNING action_id`,
      [actionId,scope.environment_id,scope.project_id,scope.organization_id]);
    if(result.rows.length) await this.audit(scope,userId,"reconciliation.suppression_lifted","action",actionId,{});
    return result.rows.length===1;
  }

  async reconciliationSuppressed(actionId:string):Promise<boolean>{
    return (await this.db.query(`SELECT 1 FROM nyst_reconciliation_suppressions WHERE action_id=$1`,[actionId])).rows.length>0;
  }

  /**
   * Record ONE logical intervention.
   *
   * `intervention_key` is the logical identity. Scheduler runs, repeated
   * observations, webhook retries, and page refreshes all collapse onto the
   * same key, so a single intervention can never be counted twice. Returns
   * true only when this call created the record.
   */
  async recordIntervention(scope:TenantScope,input:{kind:InterventionKind;action_id?:string|null;shadow_evaluation_id?:string|null;agent_id?:string|null;effect_name:string;mode:EnvironmentMode;intervention_key:string;summary:string;detail?:Record<string,unknown>}):Promise<boolean>{
    const result=await this.db.query(`INSERT INTO nyst_intervention_events(intervention_id,intervention_key,environment_id,project_id,organization_id,action_id,shadow_evaluation_id,agent_id,effect_name,mode,kind,summary,detail)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(intervention_key) DO NOTHING RETURNING intervention_id`,
      [randomUUID(),bounded(input.intervention_key,400,"intervention key"),scope.environment_id,scope.project_id,scope.organization_id,
       input.action_id??null,input.shadow_evaluation_id??null,input.agent_id??null,bounded(input.effect_name,200,"effect"),input.mode,input.kind,
       bounded(input.summary,400,"intervention summary"),input.detail??{}]);
    return result.rows.length===1;
  }

  async queueLifecycleWebhookByAction(actionId:string,eventType:"continuation.authorized"|"human_review.required"|"recovery.completed"|"compensation.completed"):Promise<void>{
    const eventId=randomUUID();await this.db.query(`WITH current AS (
        SELECT r.*,s.environment_id,s.project_id,s.organization_id,a.spec_version action_spec_version FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id)
        JOIN LATERAL(SELECT * FROM outcome_resolutions WHERE action_id=s.action_id ORDER BY resolution_sequence DESC NULLS LAST,resolution_id DESC LIMIT 1) r ON true WHERE s.action_id=$1
      ) INSERT INTO nyst_webhook_events(webhook_event_id,webhook_endpoint_id,action_id,resolution_id,resolution_sequence,evidence_sequence,event_type,payload,occurred_at,event_schema_version)
      SELECT $2::uuid,w.webhook_endpoint_id,c.action_id,c.resolution_id,c.resolution_sequence,(c.full_document->'runtime'->>'evidence_sequence')::int,$3::text,
        jsonb_build_object('event_schema_version',1,'event_id',$2::text,'event_type',$3::text,'timestamp',now(),'organization_id',c.organization_id,'project_id',c.project_id,'environment_id',c.environment_id,'action_id',c.action_id,'effect_name',c.effect_name,'spec_version',c.action_spec_version,'resolution_sequence',c.resolution_sequence,'effect_state',c.effect_state,'control',jsonb_build_object('primary',c.primary_directive,'retry',c.retry_disposition,'continuation',c.continuation_disposition,'recovery',c.recovery_disposition),'receipt_ref','/v1/actions/'||c.action_id||'/receipt'),now(),1
      FROM current c JOIN nyst_webhook_endpoints w ON w.environment_id=c.environment_id AND w.project_id=c.project_id AND w.organization_id=c.organization_id AND w.enabled
      ON CONFLICT(webhook_endpoint_id,action_id,resolution_id,event_type) DO NOTHING`,[actionId,eventId,eventType]);
  }

  async configureWebhook(scope: TenantScope, userId: string, target: string, secretRef: string): Promise<Record<string, unknown>> {
    await this.requireTenantScope(scope); const url = validateWebhookTarget(target); if (!/^env:[A-Z][A-Z0-9_]{2,100}$/.test(secretRef)) throw new Error("Webhook signing key must be an environment reference");
    const id=randomUUID(); const result=await this.db.query(`INSERT INTO nyst_webhook_endpoints(webhook_endpoint_id,environment_id,project_id,organization_id,target_url,signing_secret_ref,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(environment_id) DO UPDATE SET target_url=excluded.target_url,signing_secret_ref=excluded.signing_secret_ref,enabled=true
      WHERE nyst_webhook_endpoints.project_id=excluded.project_id AND nyst_webhook_endpoints.organization_id=excluded.organization_id
      RETURNING webhook_endpoint_id,target_url,signing_secret_ref,enabled,created_at`, [id,scope.environment_id,scope.project_id,scope.organization_id,url.toString(),secretRef,userId]);
    if(!result.rows.length)throw new Error("Webhook belongs to another tenant scope"); await this.audit(scope,userId,"webhook.configured","webhook",String(result.rows[0]!.webhook_endpoint_id),{target_host:url.hostname}); return result.rows[0]!;
  }

  async webhookStatus(scope: TenantScope): Promise<Record<string, unknown>[]> { await this.requireTenantScope(scope); return (await this.db.query(`SELECT w.webhook_endpoint_id,w.target_url,w.signing_secret_ref,w.enabled,w.created_at,
      (SELECT max(e.occurred_at) FROM nyst_webhook_events e WHERE e.webhook_endpoint_id=w.webhook_endpoint_id) last_event_at,
      (SELECT max(a.attempted_at) FROM nyst_webhook_attempts a JOIN nyst_webhook_events e USING(webhook_event_id) WHERE e.webhook_endpoint_id=w.webhook_endpoint_id) last_attempt_at,
      (SELECT a.response_status FROM nyst_webhook_attempts a JOIN nyst_webhook_events e USING(webhook_event_id) WHERE e.webhook_endpoint_id=w.webhook_endpoint_id ORDER BY a.attempted_at DESC,a.webhook_attempt_id DESC LIMIT 1) last_response_status,
      (SELECT a.error_code FROM nyst_webhook_attempts a JOIN nyst_webhook_events e USING(webhook_event_id) WHERE e.webhook_endpoint_id=w.webhook_endpoint_id ORDER BY a.attempted_at DESC,a.webhook_attempt_id DESC LIMIT 1) last_error_code,
      (SELECT count(*)::int FROM nyst_webhook_attempts a JOIN nyst_webhook_events e USING(webhook_event_id) WHERE e.webhook_endpoint_id=w.webhook_endpoint_id) delivery_attempt_count
      FROM nyst_webhook_endpoints w WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3`,[scope.environment_id,scope.project_id,scope.organization_id])).rows; }

  async setWebhookEnabled(scope:TenantScope,userId:string,enabled:boolean):Promise<Record<string,unknown>>{const result=await this.db.query(`UPDATE nyst_webhook_endpoints SET enabled=$4 WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 RETURNING webhook_endpoint_id,target_url,signing_secret_ref,enabled`,[scope.environment_id,scope.project_id,scope.organization_id,enabled]);const row=result.rows[0];if(!row)throw new Error("Webhook is not configured in this tenant scope");await this.audit(scope,userId,enabled?"webhook.enabled":"webhook.disabled","webhook",String(row.webhook_endpoint_id),{});return row;}

  async queueWebhookTest(scope:TenantScope):Promise<Record<string,unknown>>{const eventId=randomUUID();const result=await this.db.query(`WITH current AS (
      SELECT s.action_id,r.resolution_id,r.resolution_sequence,rt.evidence_sequence,a.effect_name action_effect_name,a.spec_version action_spec_version,r.effect_state,r.primary_directive,r.retry_disposition,r.continuation_disposition,r.recovery_disposition
      FROM nyst_action_scopes s JOIN outcome_actions a ON a.action_id=s.action_id JOIN LATERAL(SELECT * FROM outcome_resolutions WHERE action_id=s.action_id ORDER BY resolution_sequence DESC LIMIT 1) r ON true JOIN outcome_runtime rt ON rt.action_id=s.action_id
      WHERE s.environment_id=$1 AND s.project_id=$2 AND s.organization_id=$3 ORDER BY a.created_at DESC LIMIT 1
    ) INSERT INTO nyst_webhook_events(webhook_event_id,webhook_endpoint_id,action_id,resolution_id,resolution_sequence,evidence_sequence,event_type,payload,occurred_at,event_schema_version)
      SELECT $4::uuid,w.webhook_endpoint_id,c.action_id,c.resolution_id,c.resolution_sequence,c.evidence_sequence,'webhook.test',jsonb_build_object('event_schema_version',1,'event_id',$4::text,'event_type','webhook.test','timestamp',now(),'organization_id',$3,'project_id',$2,'environment_id',$1,'action_id',c.action_id,'effect_name',c.action_effect_name,'spec_version',c.action_spec_version,'resolution_id',c.resolution_id,'resolution_sequence',c.resolution_sequence,'evidence_sequence',c.evidence_sequence,'effect_state',c.effect_state,'control',jsonb_build_object('primary',c.primary_directive,'retry',c.retry_disposition,'continuation',c.continuation_disposition,'recovery',c.recovery_disposition),'receipt_ref','/v1/actions/'||c.action_id||'/receipt'),now(),1 FROM current c JOIN nyst_webhook_endpoints w ON w.environment_id=$1 AND w.project_id=$2 AND w.organization_id=$3 AND w.enabled RETURNING webhook_event_id,event_type,occurred_at`,[scope.environment_id,scope.project_id,scope.organization_id,eventId]);if(!result.rows.length)throw Object.assign(new Error("A test delivery needs an enabled webhook endpoint and at least one resolved action in this environment."),{statusCode:409});return result.rows[0]!;}

  async queueDecisionWebhook(scope: TenantScope, actionId: string, resolution: Record<string, unknown>, eventType: string): Promise<void> {
    const resolutionId=String(resolution.resolution_id??""); const runtime=resolution.runtime&&typeof resolution.runtime==='object'?resolution.runtime as Record<string,unknown>:{};
    if(!/^[0-9a-f-]{36}$/i.test(resolutionId)||!['effect.resolved','continuation.authorized','human_review.required','compensation.completed'].includes(eventType))return;
    const eventId=randomUUID();
    await this.db.query(`INSERT INTO nyst_webhook_events(webhook_event_id,webhook_endpoint_id,action_id,resolution_id,resolution_sequence,evidence_sequence,event_type,payload,occurred_at)
      SELECT $1,w.webhook_endpoint_id,$2,$3,$4,$5,$6,$7,now() FROM nyst_webhook_endpoints w JOIN nyst_action_scopes s ON s.action_id=$2 AND s.environment_id=w.environment_id AND s.project_id=w.project_id AND s.organization_id=w.organization_id
      WHERE w.environment_id=$8 AND w.enabled=true ON CONFLICT(webhook_endpoint_id,action_id,resolution_id,event_type) DO NOTHING`,[eventId,actionId,resolutionId,Number(runtime.resolution_sequence??1),Number(runtime.evidence_sequence??0),eventType,{event_id:eventId,event_type:eventType,action_id:actionId,resolution_id:resolutionId,resolution_sequence:Number(runtime.resolution_sequence??1),evidence_sequence:Number(runtime.evidence_sequence??0),environment_id:scope.environment_id},scope.environment_id]);
  }

  /**
   * Authorize a recovery operation.
   *
   * Authority is the intersection of runtime disposition and the IMMUTABLE
   * ACTION-BOUND policy, checked both in the application and in SQL. The row
   * starts at dispatch_state `definitely_not_sent`, which is what later makes
   * a crash safe to reason about.
   */
  async authorizeRecovery(scope:TenantScope,actionId:string,resolutionId:string,operation:"authorized_continuation"|"supported_compensation"):Promise<Record<string,unknown>>{
    const authority=await this.effectiveActionAuthority(scope,actionId,resolutionId);
    if(!authority)throw new Error("Recovery authorization is unavailable for this action in this tenant scope");
    const permitted=operation==="authorized_continuation"?authority.automatic_continuation_allowed:authority.automatic_compensation_allowed;
    if(!permitted)throw new Error(`Runtime resolution and bound conservative policy do not authorize this recovery (${authority.reductions.join(", ")||"runtime disposition does not permit it"})`);
    const id=randomUUID();const operationKey=`recovery:${actionId}:${resolutionId}:${operation}`;
    const result=await this.db.query(`INSERT INTO nyst_recovery_executions(recovery_execution_id,action_id,resolution_id,policy_version_id,operation,status,dispatch_state,resolution_sequence,evidence_sequence,downstream_operation_key)
      SELECT $1,s.action_id,r.resolution_id,b.policy_version_id,$5,'authorized','definitely_not_sent',r.resolution_sequence,rt.evidence_sequence,$8
      FROM nyst_action_scopes s JOIN nyst_action_policy_bindings b USING(action_id) JOIN nyst_policy_versions p USING(policy_version_id)
      JOIN outcome_resolutions r ON r.action_id=s.action_id AND r.resolution_id=$2
      JOIN outcome_runtime rt ON rt.action_id=s.action_id AND rt.resolution_sequence=r.resolution_sequence
      WHERE s.action_id=$3 AND s.environment_id=$4 AND s.project_id=$6 AND s.organization_id=$7
        AND (($5='authorized_continuation' AND ${SQL_AUTOMATIC_CONTINUATION_AUTHORITY}) OR ($5='supported_compensation' AND ${SQL_AUTOMATIC_COMPENSATION_AUTHORITY}))
      ON CONFLICT(action_id,resolution_id,operation) DO UPDATE SET action_id=excluded.action_id
      RETURNING recovery_execution_id,action_id,resolution_id,operation,status,dispatch_state,recovery_operation_id,created_at,downstream_operation_key`,
      [id,resolutionId,actionId,scope.environment_id,operation,scope.project_id,scope.organization_id,operationKey]);
    if(!result.rows.length)throw new Error("Runtime resolution and bound conservative policy do not authorize this recovery");
    return result.rows[0]!;
  }

  /**
   * Claim a recovery for execution.
   *
   * Two distinct eligibility paths, because recovery MAY cause an external
   * consequence and an expired lease is NOT permission to run again:
   *
   *  1. FRESH  — status 'authorized'. Requires full effective authority,
   *     non-stale resolution/evidence sequences, and a live deadline.
   *  2. RECLAIM — status 'executing'/'observing' whose lease expired. Always
   *     eligible so nothing can strand (I12), but the caller is told the
   *     durable `dispatch_state` and whether authority is still valid, and
   *     must act accordingly:
   *
   *       definitely_not_sent + authority valid  -> may resume the send
   *       definitely_not_sent + authority stale  -> cancel
   *       attempted / may_have_been_sent / ambiguous -> OBSERVE ONLY, never resend
   *       completed                              -> no-op
   *
   * Lease expiry is compared using the DATABASE clock (`now()`), not an
   * application clock, so cross-process ownership survives a node whose wall
   * clock moves backwards (I13, Phase 3).
   */
  async claimRecovery(options:{leaseMs?:number;environment_id?:string}={}):Promise<Record<string,unknown>|null>{
    const token=randomUUID();const leaseMs=options.leaseMs??30_000;const environmentId=options.environment_id??null;
    const result=await this.db.query(`WITH eligible AS (
        SELECT re.recovery_execution_id,
          (rt.resolution_sequence=re.resolution_sequence AND rt.evidence_sequence=re.evidence_sequence
            AND b.policy_version_id=re.policy_version_id AND b.reconcile_deadline_at>now()
            AND ((re.operation='authorized_continuation' AND ${SQL_AUTOMATIC_CONTINUATION_AUTHORITY})
              OR (re.operation='supported_compensation' AND ${SQL_AUTOMATIC_COMPENSATION_AUTHORITY}))) authority_valid,
          re.status,re.claim_token,re.claimed_until,re.dispatch_state,re.created_at
        FROM nyst_recovery_executions re
        JOIN outcome_runtime rt ON rt.action_id=re.action_id
        JOIN outcome_resolutions r ON r.resolution_id=re.resolution_id AND r.action_id=re.action_id
        JOIN nyst_action_policy_bindings b ON b.action_id=re.action_id
        JOIN nyst_policy_versions p ON p.policy_version_id=b.policy_version_id
        JOIN nyst_action_scopes sc ON sc.action_id=re.action_id
        WHERE $3::uuid IS NULL OR sc.environment_id=$3::uuid
      ), candidate AS (
        SELECT e.recovery_execution_id,e.authority_valid FROM eligible e
        WHERE (e.status='authorized' AND e.claim_token IS NULL AND e.authority_valid)
           OR (e.status IN ('executing','observing') AND e.claimed_until IS NOT NULL AND e.claimed_until<=now())
        ORDER BY e.created_at,e.recovery_execution_id LIMIT 1
      ) UPDATE nyst_recovery_executions r
        SET status=CASE WHEN r.dispatch_state='definitely_not_sent' THEN 'executing' WHEN r.dispatch_state='completed' THEN 'completed' ELSE 'observing' END,
            claim_token=$1,claimed_until=now()+($2::text||' milliseconds')::interval,attempt=r.attempt+1,attempted_at=now()
        FROM candidate c,nyst_action_scopes s,outcome_actions a
        WHERE r.recovery_execution_id=c.recovery_execution_id AND s.action_id=r.action_id AND a.action_id=r.action_id
          -- Re-read the claim state inside the UPDATE so two concurrent workers
          -- cannot both win: the second sees the first worker's fresh lease.
          AND (r.claim_token IS NULL OR (r.claimed_until IS NOT NULL AND r.claimed_until<=now()))
        RETURNING r.recovery_execution_id,r.action_id,r.resolution_id,r.operation,r.claim_token,r.downstream_operation_key,
          r.recovery_operation_id,r.dispatch_state,r.status,r.attempt,r.resolution_sequence,r.evidence_sequence,r.policy_version_id,
          s.environment_id,s.project_id,s.organization_id,s.agent_id,a.effect_name,a.spec_version,c.authority_valid`,[token,leaseMs,environmentId]);
    return result.rows[0]??null;
  }

  /**
   * Record where an attempt stopped relative to the provider send.
   *
   * This is the durable dispatch boundary. It is written BEFORE the send
   * (`before_send`) and again after, so a process that dies mid-send still
   * leaves behind the fact that a send may have started.
   */
  /**
   * THE recovery dispatch gate. Nothing external may run unless this returns true.
   *
   * The defect this replaces: the worker called `recordRecoveryDispatch` for
   * the before-send marker and DISCARDED its boolean, then invoked the external
   * executor unconditionally. So a worker whose lease had expired, whose claim
   * another worker had already taken, would still reach the provider — a
   * duplicate external consequence, which is invariant S1, the first thing Nyst
   * promises never to do.
   *
   * Everything is verified in ONE statement, and the same statement advances the
   * boundary to may_have_been_sent. There is no window between "I checked that I
   * still own this" and "I recorded that I am about to send", because those are
   * the same write. Verified together:
   *
   *   - the recovery execution still exists
   *   - the claim token is still ours (nobody reclaimed)
   *   - the lease has not expired by DATABASE time, not application time
   *   - the status is still executing
   *   - the dispatch state is still definitely_not_sent
   *   - the action, recovery operation, policy version, resolution sequence and
   *     evidence sequence are all still the ones we were authorized against
   *
   * A false return means: do not send. Ever. The caller must return.
   */
  async beginRecoveryDispatch(input: {
    recovery_execution_id: string; claim_token: string; attempt: number;
    action_id: string; recovery_operation_id: string; policy_version_id: string;
    resolution_sequence: number; evidence_sequence: number;
    detail?: Record<string, unknown>;
  }): Promise<boolean> {
    const result = await this.db.query(`WITH eligible AS (
        SELECT r.recovery_execution_id
          FROM nyst_recovery_executions r
          JOIN outcome_runtime rt ON rt.action_id = r.action_id
         WHERE r.recovery_execution_id = $1
           AND r.claim_token = $2::uuid
           AND r.claimed_until > now()          -- database time; a paused worker's clock is irrelevant
           AND r.status = 'executing'
           AND r.dispatch_state = 'definitely_not_sent'
           AND r.action_id = $4::uuid
           AND r.recovery_operation_id = $5::uuid
           AND r.policy_version_id = $6::uuid
           AND rt.resolution_sequence = $7
           AND rt.evidence_sequence = $8
           FOR UPDATE OF r
      ), attempt_record AS (
        INSERT INTO nyst_recovery_dispatch_attempts(dispatch_attempt_id,recovery_execution_id,attempt,claim_token,phase,detail)
        SELECT $9,$1,$3,$2,'before_send',$10 FROM eligible
        ON CONFLICT(recovery_execution_id,attempt,phase) DO NOTHING
        RETURNING recovery_execution_id
      )
      UPDATE nyst_recovery_executions SET dispatch_state='may_have_been_sent'
       WHERE recovery_execution_id IN (SELECT recovery_execution_id FROM eligible)
      RETURNING recovery_execution_id`,
      [input.recovery_execution_id, input.claim_token, input.attempt, input.action_id,
       input.recovery_operation_id, input.policy_version_id, input.resolution_sequence,
       input.evidence_sequence, randomUUID(), input.detail ?? {}]);
    return result.rows.length === 1;
  }

  async recordRecoveryDispatch(recoveryId:string,claimToken:string,attempt:number,phase:"claimed"|"before_send"|"after_send"|"observed"|"failed_before_send"|"failed_after_send"|"cancelled",dispatchState:"definitely_not_sent"|"attempted"|"may_have_been_sent"|"ambiguous"|"completed",detail:Record<string,unknown>={}):Promise<boolean>{
    const result=await this.db.query(`WITH attempt_record AS (
        INSERT INTO nyst_recovery_dispatch_attempts(dispatch_attempt_id,recovery_execution_id,attempt,claim_token,phase,detail)
        SELECT $1,$2,$3,$4,$5,$7 FROM nyst_recovery_executions WHERE recovery_execution_id=$2 AND claim_token=$4
        ON CONFLICT(recovery_execution_id,attempt,phase) DO NOTHING RETURNING recovery_execution_id
      ) UPDATE nyst_recovery_executions SET dispatch_state=$6
        WHERE recovery_execution_id=$2 AND claim_token=$4
          -- the boundary only ever advances; it can never be walked back to a
          -- weaker claim such as definitely_not_sent after a send began
          AND array_position(ARRAY['definitely_not_sent','attempted','may_have_been_sent','ambiguous','completed'],$6)
            >= array_position(ARRAY['definitely_not_sent','attempted','may_have_been_sent','ambiguous','completed'],dispatch_state)
        RETURNING recovery_execution_id`,[randomUUID(),recoveryId,attempt,claimToken,phase,dispatchState,detail]);
    return result.rows.length===1;
  }

  /**
   * Complete a recovery.
   *
   * ABA protection: completion requires the CURRENT claim token AND the
   * expected action, recovery operation identity, policy version, resolution
   * sequence, and evidence sequence. A worker that pauses past its lease and
   * wakes after another worker legitimately reclaimed and finished cannot
   * alter anything.
   */
  async completeRecovery(recoveryId:string,claimToken:string,successful:boolean,resultValue:Record<string,unknown>={},expected:{action_id?:string;recovery_operation_id?:string;policy_version_id?:string;resolution_sequence?:number;evidence_sequence?:number}={}):Promise<boolean>{
    const result=await this.db.query(`UPDATE nyst_recovery_executions SET
        status=$3,dispatch_state=CASE WHEN $3='completed' THEN 'completed' ELSE dispatch_state END,
        completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END,
        claim_token=NULL,claimed_until=NULL,result=$4,
        needs_review_reason=CASE WHEN $3='needs_review' THEN $5 ELSE needs_review_reason END
      WHERE recovery_execution_id=$1 AND claim_token=$2 AND status IN ('executing','observing')
        AND ($6::uuid IS NULL OR action_id=$6::uuid)
        AND ($7::uuid IS NULL OR recovery_operation_id=$7::uuid)
        AND ($8::uuid IS NULL OR policy_version_id=$8::uuid)
        AND ($9::int IS NULL OR resolution_sequence=$9::int)
        AND ($10::int IS NULL OR evidence_sequence=$10::int)
      RETURNING recovery_execution_id,action_id,status`,
      [recoveryId,claimToken,successful?'completed':'needs_review',resultValue,
       typeof resultValue.reason==="string"?String(resultValue.reason).slice(0,500):"Automatic recovery could not be completed safely.",
       expected.action_id??null,expected.recovery_operation_id??null,expected.policy_version_id??null,
       expected.resolution_sequence??null,expected.evidence_sequence??null]);
    const row=result.rows[0];
    if(!row)return false;
    const actionId=String(row.action_id);
    const scoped=(await this.db.query(`SELECT s.environment_id,s.project_id,s.organization_id,s.agent_id,a.effect_name,b.environment_mode
      FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) JOIN nyst_action_policy_bindings b USING(action_id) WHERE s.action_id=$1`,[actionId])).rows[0];
    if(successful&&scoped){
      await this.db.query(`INSERT INTO nyst_control_events(control_event_id,transition_id,action_id,environment_id,project_id,organization_id,event_kind)
        SELECT $1,t.transition_id,t.action_id,t.environment_id,t.project_id,t.organization_id,'automatic_recovery_completed' FROM nyst_resolution_transitions t WHERE t.action_id=$2 ORDER BY t.resolution_sequence DESC LIMIT 1 ON CONFLICT DO NOTHING`,[randomUUID(),actionId]);
      await this.recordIntervention({environment_id:String(scoped.environment_id),project_id:String(scoped.project_id),organization_id:String(scoped.organization_id)},
        {kind:"auto_resolved",action_id:actionId,agent_id:scoped.agent_id?String(scoped.agent_id):null,effect_name:String(scoped.effect_name),
         mode:normalizeMode(scoped.environment_mode),intervention_key:`auto_resolved:${actionId}`,
         summary:"Nyst resolved the ambiguity automatically through an authorized recovery.",detail:{recovery_execution_id:recoveryId}});
      await this.queueLifecycleWebhookByAction(actionId,"recovery.completed");
    } else if(scoped){
      await this.recordIntervention({environment_id:String(scoped.environment_id),project_id:String(scoped.project_id),organization_id:String(scoped.organization_id)},
        {kind:"recovery_needs_review",action_id:actionId,agent_id:scoped.agent_id?String(scoped.agent_id):null,effect_name:String(scoped.effect_name),
         mode:normalizeMode(scoped.environment_mode),intervention_key:`recovery_needs_review:${recoveryId}`,
         summary:"An automatic recovery could not be completed safely and needs human review.",detail:{recovery_execution_id:recoveryId}});
      await this.openHumanReviewForRecovery(actionId,"An automatic recovery could not be completed safely; the external recovery consequence is unproven.");
    }
    return true;
  }

  /** Cancel a recovery that never crossed the dispatch boundary and is now stale. */
  async cancelRecovery(recoveryId:string,claimToken:string,reason:string):Promise<boolean>{
    const result=await this.db.query(`UPDATE nyst_recovery_executions SET status='cancelled',claim_token=NULL,claimed_until=NULL,
        needs_review_reason=$3,result=jsonb_build_object('cancelled_reason',$3::text)
      WHERE recovery_execution_id=$1 AND claim_token=$2 AND status IN ('executing','observing') AND dispatch_state='definitely_not_sent'
      RETURNING recovery_execution_id`,[recoveryId,claimToken,bounded(reason,500,"cancellation reason")]);
    return result.rows.length===1;
  }

  /** Park a recovery for human review without ever resending an ambiguous consequence. */
  async recoveryNeedsReview(recoveryId:string,claimToken:string,reason:string):Promise<boolean>{
    return this.completeRecovery(recoveryId,claimToken,false,{reason:bounded(reason,500,"review reason")});
  }

  private async openHumanReviewForRecovery(actionId:string,reason:string):Promise<void>{
    await this.db.query(`INSERT INTO nyst_human_reviews(human_review_id,action_id,environment_id,project_id,organization_id,status,reason)
      SELECT $1,s.action_id,s.environment_id,s.project_id,s.organization_id,'open',$2 FROM nyst_action_scopes s WHERE s.action_id=$3
      ON CONFLICT(action_id) DO NOTHING`,[randomUUID(),bounded(reason,1000,"review reason"),actionId]);
  }

  async runFailureLab(scope: TenantScope, userId: string, scenario: FailureScenario, effectName: string, seed: number): Promise<Record<string, unknown>> {
    const control=await this.environmentControl(scope); if(!control.is_demo&&control.mode!=="shadow")throw new Error("Failure Lab is isolated to Demo or Shadow environments");
    const result=await runFailureLabEngine(scenario,effectName,seed); const id=randomUUID(); await this.db.query(`INSERT INTO nyst_failure_lab_runs(failure_lab_run_id,environment_id,project_id,organization_id,scenario,effect_name,seed,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,scope.environment_id,scope.project_id,scope.organization_id,scenario,effectName,seed,result,userId]); return {failure_lab_run_id:id,...result};
  }

  async failureLabRuns(scope: TenantScope): Promise<Record<string, unknown>[]> { await this.requireTenantScope(scope); return (await this.db.query(`SELECT failure_lab_run_id,scenario,effect_name,seed,result,created_at FROM nyst_failure_lab_runs WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 ORDER BY created_at DESC LIMIT 20`,[scope.environment_id,scope.project_id,scope.organization_id])).rows; }

  async openHumanReview(scope: TenantScope, actionId: string, reason: string): Promise<Record<string, unknown>> {
    const result=await this.db.query(`INSERT INTO nyst_human_reviews(human_review_id,action_id,environment_id,project_id,organization_id,status,reason)
      SELECT $1,s.action_id,s.environment_id,s.project_id,s.organization_id,'open',$6 FROM nyst_action_scopes s JOIN LATERAL(SELECT primary_directive FROM outcome_resolutions WHERE action_id=s.action_id ORDER BY resolution_sequence DESC LIMIT 1) r ON true
      WHERE s.action_id=$2 AND s.environment_id=$3 AND s.project_id=$4 AND s.organization_id=$5 AND r.primary_directive IN ('hold','escalate') ON CONFLICT(action_id) DO UPDATE SET reason=excluded.reason RETURNING human_review_id,action_id,status,reason,opened_at`,[randomUUID(),actionId,scope.environment_id,scope.project_id,scope.organization_id,bounded(reason,1000,"review reason")]);
    if(!result.rows.length)throw new Error("Only held or escalated actions may enter human review");
    const context=(await this.db.query(`SELECT s.agent_id,a.effect_name,b.environment_mode FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) JOIN nyst_action_policy_bindings b USING(action_id) WHERE s.action_id=$1`,[actionId])).rows[0];
    if(context)await this.recordIntervention(scope,{kind:"human_review_opened",action_id:actionId,agent_id:context.agent_id?String(context.agent_id):null,
      effect_name:String(context.effect_name),mode:normalizeMode(context.environment_mode),intervention_key:`human_review_opened:${actionId}`,
      summary:"Nyst escalated to human review because it could not proceed safely on its own.",detail:{reason:bounded(reason,400,"review reason")}});
    await this.queueLifecycleWebhookByAction(actionId,"human_review.required"); return result.rows[0]!;
  }

  async humanReviews(scope: TenantScope): Promise<Record<string, unknown>[]> { return (await this.db.query(`SELECT h.human_review_id,h.action_id,h.status,h.reason,h.opened_at,h.reviewed_at,a.effect_name,s.display_business_key FROM nyst_human_reviews h JOIN nyst_action_scopes s USING(action_id) JOIN outcome_actions a USING(action_id) WHERE h.environment_id=$1 AND h.project_id=$2 AND h.organization_id=$3 ORDER BY h.opened_at DESC`,[scope.environment_id,scope.project_id,scope.organization_id])).rows; }

  /**
   * HUMAN REVIEW SAFETY (Phase 15).
   *
   * A reviewer may ONLY select operations that are already safe under the
   * runtime and EffectSpec semantics. Explicitly impossible, by construction
   * rather than by convention:
   *
   *   - force retry            there is no operation that sets retry=allowed
   *   - force continuation     continuation still requires effective authority
   *   - rewrite EffectState    resolutions are DB-immutable and append-only
   *   - manufacture evidence   evidence is written only by observers
   *   - bypass bound policy    compensation re-checks the action-bound policy
   *   - override provider truth  re-observation is read-only
   *
   * The permitted set is derived from effectiveAuthority, so it can never
   * exceed what Nyst would already have done on its own.
   */
  async updateHumanReview(scope: TenantScope, userId: string, reviewId: string, operation: HumanReviewOperation): Promise<Record<string, unknown>> {
    const review = (await this.db.query(
      `SELECT human_review_id,action_id,status FROM nyst_human_reviews
       WHERE human_review_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4`,
      [reviewId, scope.environment_id, scope.project_id, scope.organization_id])).rows[0];
    if (!review) throw new Error("Review is unavailable or already handled");

    const authority = await this.effectiveActionAuthority(scope, String(review.action_id));
    const permitted = authority ? permittedHumanReviewOperations(authority) : (["acknowledge", "request_reobservation", "cancel"] as const);
    if (!permitted.includes(operation)) {
      throw Object.assign(new Error(
        `Human review may not ${operation} this action. Permitted operations are: ${permitted.join(", ")}. ` +
        "A reviewer can only choose operations that are already safe under the runtime and EffectSpec semantics."), { statusCode: 409 });
    }

    if (operation === "authorize_compensation") {
      // Routed through the SAME authorization path automatic recovery uses, so
      // the action-bound policy and runtime disposition are re-checked. A human
      // cannot authorize a compensation Nyst would have refused.
      const latest = (await this.db.query(`SELECT resolution_id FROM outcome_resolutions WHERE action_id=$1 ORDER BY resolution_sequence DESC NULLS LAST,resolved_at DESC LIMIT 1`, [review.action_id])).rows[0];
      if (!latest) throw new Error("No resolution exists to compensate");
      await this.authorizeRecovery(scope, String(review.action_id), String(latest.resolution_id), "supported_compensation");
      await this.audit(scope, userId, "review.compensation_authorized", "action", String(review.action_id), {});
    }

    const status = operation === "acknowledge" ? "acknowledged"
      : operation === "request_reobservation" ? "reobservation_requested"
      : operation === "cancel" ? "cancelled" : "compensation_authorized";
    const jobId = randomUUID();
    const result = await this.db.query(`WITH changed AS (
        UPDATE nyst_human_reviews SET status=$6,reviewed_by=$5,reviewed_at=now()
        WHERE human_review_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4 AND status='open' RETURNING *
      ), job AS (
        INSERT INTO nyst_reobservation_jobs(reobservation_job_id,human_review_id,action_id,environment_id,project_id,organization_id)
        SELECT $7,human_review_id,action_id,environment_id,project_id,organization_id FROM changed WHERE $8='request_reobservation'
        ON CONFLICT(human_review_id) DO NOTHING
      ) SELECT human_review_id,action_id,status,reviewed_at FROM changed`,
      [reviewId, scope.environment_id, scope.project_id, scope.organization_id, userId, status, jobId, operation]);
    if (!result.rows.length) throw new Error("Review is unavailable or already handled");
    await this.audit(scope, userId, `review.${operation}`, "action", String(review.action_id), {});
    return { ...result.rows[0]!, permitted_operations: permitted };
  }

  /** What a reviewer is allowed to do with this action, and why. */
  async humanReviewOptions(scope: TenantScope, actionId: string): Promise<{ permitted: readonly HumanReviewOperation[]; forbidden: readonly string[]; reasons: readonly string[] }> {
    const authority = await this.effectiveActionAuthority(scope, actionId);
    const permitted = authority ? permittedHumanReviewOperations(authority) : (["acknowledge", "request_reobservation", "cancel"] as const);
    return {
      permitted,
      // Stated explicitly so the UI can show them as unavailable rather than
      // simply omitting them, which would leave a reviewer wondering.
      forbidden: ["force_retry", "force_continuation", "set_effect_state", "author_evidence", "bypass_policy", "override_provider_truth"],
      reasons: [
        "Retry is never offered: Nyst forbids an automatic retry of a consequential action under any policy.",
        authority?.automatic_continuation_allowed
          ? "Continuation is already authorized by the effective authority; a reviewer does not need to force it."
          : "Continuation is not offered because the effective authority does not permit it, and a reviewer cannot widen authority.",
        "EffectState is derived from evidence and is immutable in the database; there is no operation that writes it directly.",
      ],
    };
  }

  /**
   * Claim a re-observation job.
   *
   * Re-observation is READ-ONLY, so unlike recovery an expired claim is always
   * safe to reclaim — there is no external consequence that could be
   * duplicated (I19). Attempts are counted and bounded so a permanently
   * failing observation escalates instead of spinning forever.
   *
   * Expiry uses the DATABASE clock so ownership is correct across processes.
   */
  async claimReobservation(options:{leaseMs?:number;maxAttempts?:number;environment_id?:string}={}):Promise<Record<string,unknown>|null>{
    const token=randomUUID();const leaseMs=options.leaseMs??30_000;const maxAttempts=options.maxAttempts??10;const environmentId=options.environment_id??null;
    const result=await this.db.query(`WITH candidate AS (
        SELECT reobservation_job_id FROM nyst_reobservation_jobs
        WHERE (status='requested' OR (status='executing' AND claimed_until IS NOT NULL AND claimed_until<=now()))
          AND attempt < $3 AND ($4::uuid IS NULL OR environment_id=$4::uuid)
        ORDER BY requested_at,reobservation_job_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE nyst_reobservation_jobs j
        SET status='executing',claim_token=$1,claimed_until=now()+($2::text||' milliseconds')::interval,attempt=j.attempt+1
        FROM candidate c WHERE j.reobservation_job_id=c.reobservation_job_id
        RETURNING j.reobservation_job_id,j.action_id,j.human_review_id,j.claim_token,j.attempt,j.environment_id,j.project_id,j.organization_id`,
      [token,leaseMs,maxAttempts,environmentId]);
    if(result.rows.length)return result.rows[0]!;
    // Nothing claimable. Anything that exhausted its attempts must not stay
    // invisible, so park it for a human rather than leaving it 'executing'.
    await this.db.query(`UPDATE nyst_reobservation_jobs SET status='needs_review',claim_token=NULL,claimed_until=NULL,last_error_code='attempts_exhausted'
      WHERE status IN ('requested','executing') AND attempt >= $1 AND (claimed_until IS NULL OR claimed_until<=now())
        AND ($2::uuid IS NULL OR environment_id=$2::uuid)`,[maxAttempts,environmentId]);
    return null;
  }

  /** Completion requires the CURRENT claim token; a stale claimant is rejected. */
  async completeReobservation(jobId:string,claimToken:string,successful:boolean,errorCode:string|null=null):Promise<boolean>{
    const result=await this.db.query(`UPDATE nyst_reobservation_jobs SET status=$3,
        completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END,
        claim_token=NULL,claimed_until=NULL,last_error_code=$4
      WHERE reobservation_job_id=$1 AND claim_token=$2 AND status='executing' RETURNING reobservation_job_id`,
      [jobId,claimToken,successful?'completed':'requested',errorCode?bounded(errorCode,100,"error code"):null]);
    return result.rows.length===1;
  }

  async onboardingProgress(scope:TenantScope):Promise<Record<string,unknown>>{const result=await this.db.query(`SELECT e.mode,e.is_demo,e.onboarding_stage,
      (e.is_demo OR EXISTS(SELECT 1 FROM nyst_environment_mode_audit m WHERE m.environment_id=e.environment_id)) mode_chosen,
      (e.is_demo OR EXISTS(SELECT 1 FROM nyst_integrations i WHERE i.environment_id=e.environment_id AND i.project_id=e.project_id AND i.organization_id=e.organization_id AND i.configured) OR EXISTS(SELECT 1 FROM nyst_environment_effect_specs f WHERE f.environment_id=e.environment_id AND f.project_id=e.project_id AND f.organization_id=e.organization_id AND f.enabled AND f.effect_name='fake.repository_permission_change')) integration_configured,
      EXISTS(SELECT 1 FROM nyst_environment_effect_specs s WHERE s.environment_id=e.environment_id AND s.project_id=e.project_id AND s.organization_id=e.organization_id AND s.enabled) effect_enabled,
      EXISTS(SELECT 1 FROM nyst_api_keys k WHERE k.environment_id=e.environment_id AND k.project_id=e.project_id AND k.organization_id=e.organization_id AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>now())) api_key_created,
      EXISTS(SELECT 1 FROM nyst_action_scopes s WHERE s.environment_id=e.environment_id AND s.project_id=e.project_id AND s.organization_id=e.organization_id) first_action,
      EXISTS(SELECT 1 FROM nyst_action_scopes s JOIN outcome_resolutions r USING(action_id) WHERE s.environment_id=e.environment_id AND s.project_id=e.project_id AND s.organization_id=e.organization_id) lifecycle_observed,
      EXISTS(SELECT 1 FROM nyst_action_scopes s JOIN outcome_resolutions r USING(action_id) WHERE s.environment_id=e.environment_id AND s.project_id=e.project_id AND s.organization_id=e.organization_id AND r.full_document->'trust'->'signature' IS NOT NULL) receipt_created
      FROM nyst_environments e WHERE e.environment_id=$1 AND e.project_id=$2 AND e.organization_id=$3`,[scope.environment_id,scope.project_id,scope.organization_id]);const row=result.rows[0];if(!row)throw new Error("Resource belongs to a different tenant scope");const completed=[true,true,row.mode_chosen===true,row.integration_configured===true,row.effect_enabled===true,row.api_key_created===true,Number(row.onboarding_stage)>=7,row.first_action===true,row.lifecycle_observed===true,row.receipt_created===true];const stage=completed.findIndex(value=>!value);return {mode:row.mode,is_demo:row.is_demo===true,completed,stage:stage<0?10:stage};}

  async attestSdkInstalled(scope:TenantScope):Promise<void>{const progress=await this.onboardingProgress(scope);const completed=progress.completed as boolean[];if(!completed.slice(0,6).every(Boolean))throw new Error("Complete provider, EffectSpec, and API-key setup before SDK attestation");const result=await this.db.query(`UPDATE nyst_environments SET onboarding_stage=GREATEST(onboarding_stage,7) WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 RETURNING environment_id`,[scope.environment_id,scope.project_id,scope.organization_id]);if(!result.rows.length)throw new Error("Resource belongs to a different tenant scope");}

  private async audit(scope:TenantScope,userId:string,eventType:string,targetType:string,targetId:string,detail:Record<string,unknown>):Promise<void>{await this.db.query(`INSERT INTO nyst_audit_events(audit_event_id,organization_id,project_id,environment_id,actor_user_id,event_type,target_type,target_id,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),scope.organization_id,scope.project_id,scope.environment_id,userId,eventType,targetType,targetId,detail]);}

  /**
   * Run a control-plane operation at most once per (environment, operation,
   * idempotency key). See idempotency.ts for the exact replay/conflict rules.
   */
  async idempotent<T>(scope:TenantScope,operation:IdempotentOperation,key:string|null,body:unknown,operationFn:()=>Promise<T>):Promise<{value:T;replayed:boolean}>{
    return withIdempotency(this.db,scope,operation,key,body,operationFn);
  }

  /** Maintenance sweep. Never called on the request hot path. */
  async pruneIdempotencyKeys():Promise<number>{return pruneIdempotencyKeys(this.db);}


  /* ==================================================================
   * AGENT REGISTRY (Phase 6)
   *
   * Purpose: every consequential action must be able to answer
   * WHO OR WHAT CAUSED THIS?
   *
   * Deliberately lightweight. Not an agent builder, not a marketplace,
   * not orchestration.
   * ================================================================== */

  async createAgent(scope: TenantScope, userId: string, input: { name: string; slug: string; owner: string; description?: string; framework?: string; tags?: readonly string[] }): Promise<Record<string, unknown>> {
    await this.requireTenantScope(scope);
    const tags = (input.tags ?? []).slice(0, 12).map((tag) => bounded(tag, 40, "agent tag"));
    const result = await this.db.query(`INSERT INTO nyst_agents(agent_id,organization_id,project_id,environment_id,slug,name,owner,description,framework,tags,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING agent_id,slug,name,owner,description,framework,status,tags,created_at`,
      [randomUUID(), scope.organization_id, scope.project_id, scope.environment_id, slug(input.slug),
       bounded(input.name, 120, "agent name"), bounded(input.owner, 120, "agent owner"),
       input.description ? bounded(input.description, 1000, "agent description") : "",
       input.framework ? bounded(input.framework, 80, "agent framework") : "unspecified", JSON.stringify(tags), userId]);
    await this.audit(scope, userId, "agent.created", "agent", String(result.rows[0]!.agent_id), { slug: input.slug });
    return result.rows[0]!;
  }

  async agents(scope: TenantScope): Promise<Record<string, unknown>[]> {
    return (await this.db.query(`SELECT a.agent_id,a.slug,a.name,a.owner,a.description,a.framework,a.status,a.tags,a.created_at,
        (SELECT count(*)::int FROM nyst_action_scopes s WHERE s.agent_id=a.agent_id) action_count,
        (SELECT max(act.created_at) FROM nyst_action_scopes s JOIN outcome_actions act USING(action_id) WHERE s.agent_id=a.agent_id) last_action_at,
        (SELECT count(*)::int FROM nyst_intervention_events i WHERE i.agent_id=a.agent_id) intervention_count,
        (SELECT coalesce(array_agg(DISTINCT act.effect_name),ARRAY[]::text[]) FROM nyst_action_scopes s JOIN outcome_actions act USING(action_id) WHERE s.agent_id=a.agent_id) effect_names,
        (SELECT coalesce(array_agg(c.effect_name ORDER BY c.effect_name),ARRAY[]::text[]) FROM nyst_canary_rules c WHERE c.agent_id=a.agent_id AND c.enabled) canary_effects
      FROM nyst_agents a WHERE a.environment_id=$1 AND a.project_id=$2 AND a.organization_id=$3 ORDER BY a.created_at`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows;
  }

  async agentDetail(scope: TenantScope, agentId: string): Promise<Record<string, unknown> | null> {
    if (!UUID_PATTERN.test(agentId)) return null;
    return (await this.agents(scope)).find((agent) => String(agent.agent_id) === agentId) ?? null;
  }

  async setAgentStatus(scope: TenantScope, userId: string, agentId: string, status: "active" | "paused" | "retired"): Promise<Record<string, unknown>> {
    if (!["active", "paused", "retired"].includes(status)) throw new Error("Unsupported Agent status");
    const result = await this.db.query(`UPDATE nyst_agents SET status=$5 WHERE agent_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4 RETURNING agent_id,slug,name,status`,
      [agentId, scope.environment_id, scope.project_id, scope.organization_id, status]);
    if (!result.rows.length) throw new Error("Agent belongs to a different tenant scope");
    await this.audit(scope, userId, "agent.status_changed", "agent", agentId, { status });
    return result.rows[0]!;
  }

  /**
   * Resolve the Agent a caller is acting as, FAILING CLOSED.
   *
   * - an Agent-bound API key may only ever act as its own Agent;
   * - an Agent id from another tenant is rejected as if it did not exist,
   *   so the endpoint cannot be used to probe for valid ids;
   * - a retired Agent cannot take new consequential actions.
   */
  async resolveActingAgent(principal: ProductPrincipal, requestedAgentId: string | null): Promise<string | null> {
    const boundAgentId = principal.agent_id ?? null;
    if (boundAgentId && requestedAgentId && requestedAgentId !== boundAgentId) {
      throw Object.assign(new Error("This API key is bound to a different Agent"), { statusCode: 403 });
    }
    const agentId = boundAgentId ?? requestedAgentId;
    if (!agentId) return null;
    if (!UUID_PATTERN.test(agentId)) throw Object.assign(new Error("Invalid Agent identifier"), { statusCode: 400 });
    const result = await this.db.query(`SELECT status FROM nyst_agents WHERE agent_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4`,
      [agentId, principal.environment_id, principal.project_id, principal.organization_id]);
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error("Unknown Agent for this environment"), { statusCode: 404 });
    if (row.status === "retired") throw Object.assign(new Error("A retired Agent cannot take new consequential actions"), { statusCode: 409 });
    return agentId;
  }

  /* ==================================================================
   * CANARY (Phase 8) — deterministic, explicitly scoped enforcement.
   * ================================================================== */

  async createCanaryRule(scope: TenantScope, userId: string, agentId: string, effectName: string, reason = ""): Promise<Record<string, unknown>> {
    await this.requireTenantScope(scope);
    if (!UUID_PATTERN.test(agentId)) throw new Error("Invalid Agent identifier");
    const id = randomUUID();
    const result = await this.db.query(`WITH rule AS (
        INSERT INTO nyst_canary_rules(canary_rule_id,environment_id,project_id,organization_id,agent_id,effect_name,created_by,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(environment_id,agent_id,effect_name) DO UPDATE SET enabled=true
        RETURNING canary_rule_id,environment_id,agent_id,effect_name,enabled,created_at
      ), logged AS (
        INSERT INTO nyst_canary_rule_audit(audit_id,canary_rule_id,environment_id,agent_id,effect_name,change,reason,changed_by)
        SELECT $9,canary_rule_id,environment_id,agent_id,effect_name,'created',$8,$7 FROM rule
      ) SELECT * FROM rule`,
      [id, scope.environment_id, scope.project_id, scope.organization_id, agentId, bounded(effectName, 200, "effect"), userId, bounded(reason || "Canary scope opened", 500, "reason"), randomUUID()]);
    if (!result.rows.length) throw new Error("Canary scope belongs to a different tenant scope");
    return result.rows[0]!;
  }

  async setCanaryRuleEnabled(scope: TenantScope, userId: string, ruleId: string, enabled: boolean, reason = ""): Promise<Record<string, unknown>> {
    const result = await this.db.query(`WITH rule AS (
        UPDATE nyst_canary_rules SET enabled=$5 WHERE canary_rule_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4
        RETURNING canary_rule_id,environment_id,agent_id,effect_name,enabled
      ), logged AS (
        INSERT INTO nyst_canary_rule_audit(audit_id,canary_rule_id,environment_id,agent_id,effect_name,change,reason,changed_by)
        SELECT $6,canary_rule_id,environment_id,agent_id,effect_name,CASE WHEN $5 THEN 'enabled' ELSE 'disabled' END,$7,$8 FROM rule
      ) SELECT * FROM rule`,
      [ruleId, scope.environment_id, scope.project_id, scope.organization_id, enabled, randomUUID(), bounded(reason || "Canary scope changed", 500, "reason"), userId]);
    if (!result.rows.length) throw new Error("Canary rule belongs to a different tenant scope");
    return result.rows[0]!;
  }

  async canaryRules(scope: TenantScope): Promise<Record<string, unknown>[]> {
    return (await this.db.query(`SELECT c.canary_rule_id,c.agent_id,a.name agent_name,c.effect_name,c.enabled,c.reason,c.created_at
      FROM nyst_canary_rules c JOIN nyst_agents a USING(agent_id)
      WHERE c.environment_id=$1 AND c.project_id=$2 AND c.organization_id=$3 ORDER BY a.name,c.effect_name`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows;
  }

  /**
   * The mode THIS action executes under.
   *
   * shadow      -> Nyst never controls the action.
   * enforced    -> Nyst controls every action in the environment.
   * canary      -> Nyst controls ONLY the explicitly listed
   *                (Agent + EffectSpec) slices. Everything else in a Canary
   *                environment is evaluated as Shadow. Deterministic: the same
   *                Agent and effect always resolve the same way, with no
   *                sampling and no randomness.
   */
  async resolveExecutionMode(scope: TenantScope, agentId: string | null, effectName: string): Promise<{ mode: EnvironmentMode; environment_mode: EnvironmentMode; canary_rule_id: string | null; reason: string }> {
    const control = await this.environmentControl(scope);
    if (control.mode !== "canary") {
      return { mode: control.mode, environment_mode: control.mode, canary_rule_id: null,
        reason: control.mode === "enforced" ? "The environment is Enforced; every consequential action routes through Nyst control."
          : "The environment is in Shadow; Nyst evaluates but does not control this action." };
    }
    if (!agentId) {
      return { mode: "shadow", environment_mode: "canary", canary_rule_id: null,
        reason: "Canary enforcement is scoped to a specific Agent and EffectSpec. This action declared no Agent, so it is evaluated as Shadow." };
    }
    const rule = (await this.db.query(`SELECT canary_rule_id FROM nyst_canary_rules
      WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND agent_id=$4 AND effect_name=$5 AND enabled`,
      [scope.environment_id, scope.project_id, scope.organization_id, agentId, effectName])).rows[0];
    return rule
      ? { mode: "canary", environment_mode: "canary", canary_rule_id: String(rule.canary_rule_id),
          reason: "This exact Agent and EffectSpec are inside the Canary enforcement scope." }
      : { mode: "shadow", environment_mode: "canary", canary_rule_id: null,
          reason: "This Agent and EffectSpec are outside the Canary enforcement scope, so the action is evaluated as Shadow." };
  }


  /* ==================================================================
   * BLAST RADIUS (Phase 10) and EMERGENCY FREEZE (Phase 11)
   * ================================================================== */

  async createBlastRadiusBudget(scope: TenantScope, userId: string, input: {
    agent_id?: string | null; effect_name?: string | null; window_seconds: number;
    max_actions_per_window?: number | null; max_amount_minor_per_action?: number | null;
    max_amount_minor_per_window?: number | null; currency?: string | null;
  }): Promise<Record<string, unknown>> {
    await this.requireTenantScope(scope);
    if (input.agent_id && !UUID_PATTERN.test(input.agent_id)) throw new Error("Invalid Agent identifier");
    for (const value of [input.max_amount_minor_per_action, input.max_amount_minor_per_window]) {
      if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new Error("Monetary limits are integer minor units");
      }
    }
    const result = await this.db.query(`INSERT INTO nyst_blast_radius_budgets(budget_id,environment_id,project_id,organization_id,agent_id,effect_name,window_seconds,max_actions_per_window,max_amount_minor_per_action,max_amount_minor_per_window,currency,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(environment_id,agent_id,effect_name) DO UPDATE SET window_seconds=excluded.window_seconds,
        max_actions_per_window=excluded.max_actions_per_window,max_amount_minor_per_action=excluded.max_amount_minor_per_action,
        max_amount_minor_per_window=excluded.max_amount_minor_per_window,currency=excluded.currency,enabled=true
      RETURNING budget_id,agent_id,effect_name,window_seconds,max_actions_per_window,max_amount_minor_per_action,max_amount_minor_per_window,currency,enabled`,
      [randomUUID(), scope.environment_id, scope.project_id, scope.organization_id, input.agent_id ?? null,
       input.effect_name ? bounded(input.effect_name, 200, "effect") : null, input.window_seconds,
       input.max_actions_per_window ?? null, input.max_amount_minor_per_action ?? null,
       input.max_amount_minor_per_window ?? null, input.currency ?? null, userId]);
    await this.audit(scope, userId, "blast_radius.configured", "budget", String(result.rows[0]!.budget_id), {});
    return result.rows[0]!;
  }

  async blastRadiusBudgets(scope: TenantScope): Promise<Record<string, unknown>[]> {
    return (await this.db.query(`SELECT b.budget_id,b.agent_id,a.name agent_name,b.effect_name,b.window_seconds,
        b.max_actions_per_window,b.max_amount_minor_per_action,b.max_amount_minor_per_window,b.currency,b.enabled,
        (SELECT count(*)::int FROM nyst_consequence_admissions ca WHERE ca.environment_id=b.environment_id AND ca.admitted
          AND (b.agent_id IS NULL OR ca.agent_id=b.agent_id) AND (b.effect_name IS NULL OR ca.effect_name=b.effect_name)
          AND ca.decided_at > now() - make_interval(secs => b.window_seconds)) used_actions,
        (SELECT coalesce(sum(ca.amount_minor),0)::bigint FROM nyst_consequence_admissions ca WHERE ca.environment_id=b.environment_id AND ca.admitted
          AND (b.agent_id IS NULL OR ca.agent_id=b.agent_id) AND (b.effect_name IS NULL OR ca.effect_name=b.effect_name)
          AND ca.decided_at > now() - make_interval(secs => b.window_seconds)) used_amount_minor
      FROM nyst_blast_radius_budgets b LEFT JOIN nyst_agents a USING(agent_id)
      WHERE b.environment_id=$1 AND b.project_id=$2 AND b.organization_id=$3 ORDER BY b.created_at`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows;
  }

  async blastRadiusDecisions(scope: TenantScope, limit = 25): Promise<Record<string, unknown>[]> {
    return (await this.db.query(`SELECT decision_id,budget_id,agent_id,effect_name,decision,limit_kind,observed_value,limit_value,window_seconds,business_key,reason,decided_at
      FROM nyst_blast_radius_decisions WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3
      ORDER BY decided_at DESC LIMIT $4`, [scope.environment_id, scope.project_id, scope.organization_id, Math.min(Math.max(1, limit), 200)])).rows;
  }

  /**
   * Activate an Emergency Freeze.
   *
   * Becomes effective the instant the row commits; admission consults it in
   * the same statement that admits a consequence, so nothing can slip past the
   * boundary. Read-only observation and reconciliation are unaffected.
   */
  /**
   * Activate an Emergency Freeze.
   *
   * Crosses the SAME environment authority boundary that consequence admission
   * crosses, so the two have one total order. Once this returns, any admission
   * that has not already crossed the boundary will queue behind it and then
   * observe the committed freeze. That is the guarantee an operator is relying
   * on when they hit this control during an incident.
   */
  async activateFreeze(scope: TenantScope, userId: string, input: { scope_agent_id?: string | null; scope_effect_name?: string | null; reason?: string }): Promise<Record<string, unknown>> {
    await this.requireTenantScope(scope);
    if (input.scope_agent_id && !UUID_PATTERN.test(input.scope_agent_id)) throw new Error("Invalid Agent identifier");
    const result = await this.withEnvironmentAuthority(scope, async (client) => client.query(
      `WITH crossed AS (
         UPDATE nyst_environment_authority SET authority_sequence=authority_sequence+1, updated_at=now()
         WHERE environment_id=$2 RETURNING authority_sequence
       )
       INSERT INTO nyst_freezes(freeze_id,environment_id,project_id,organization_id,scope_agent_id,scope_effect_name,reason,activated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING freeze_id,scope_agent_id,scope_effect_name,reason,activated_by,activated_at,
         (SELECT authority_sequence FROM crossed) authority_sequence`,
      [randomUUID(), scope.environment_id, scope.project_id, scope.organization_id,
       input.scope_agent_id ?? null, input.scope_effect_name ? bounded(input.scope_effect_name, 200, "effect") : null,
       input.reason ? bounded(input.reason, 500, "freeze reason") : "", userId])).catch((error: unknown) => {
      if (String(error).includes("nyst_freezes_one_active")) throw new Error("An Emergency Freeze is already active for this exact scope");
      throw error;
    });
    await this.audit(scope, userId, "freeze.activated", "freeze", String(result.rows[0]!.freeze_id), { scope_agent_id: input.scope_agent_id ?? null, scope_effect_name: input.scope_effect_name ?? null });
    return result.rows[0]!;
  }

  /** Release a freeze. Requires an explicit authorized actor; never automatic. */
  async releaseFreeze(scope: TenantScope, userId: string, freezeId: string, reason: string): Promise<Record<string, unknown>> {
    // Release crosses the same boundary as activation and admission. A release
    // that raced an in-flight admission would otherwise be just as ambiguous
    // as the activation case, in the more dangerous direction.
    const result = await this.withEnvironmentAuthority(scope, async (client) => client.query(
      `WITH crossed AS (
         UPDATE nyst_environment_authority SET authority_sequence=authority_sequence+1, updated_at=now()
         WHERE environment_id=$2 RETURNING authority_sequence
       )
       UPDATE nyst_freezes SET released_at=now(),released_by=$5,release_reason=$6
       WHERE freeze_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4 AND released_at IS NULL
       RETURNING freeze_id,scope_agent_id,scope_effect_name,activated_at,released_at,released_by,
         (SELECT authority_sequence FROM crossed) authority_sequence`,
      [freezeId, scope.environment_id, scope.project_id, scope.organization_id, userId, bounded(reason || "Released", 500, "release reason")]));
    if (!result.rows.length) throw new Error("No active freeze with that identity exists in this tenant scope");
    await this.audit(scope, userId, "freeze.released", "freeze", freezeId, {});
    return result.rows[0]!;
  }

  async freezes(scope: TenantScope): Promise<{ active: Record<string, unknown>[]; history: Record<string, unknown>[] }> {
    const rows = (await this.db.query(`SELECT f.freeze_id,f.scope_agent_id,a.name scope_agent_name,f.scope_effect_name,f.reason,
        f.activated_at,u.display_name activated_by_name,f.released_at,f.release_reason
      FROM nyst_freezes f LEFT JOIN nyst_agents a ON a.agent_id=f.scope_agent_id LEFT JOIN nyst_users u ON u.user_id=f.activated_by
      WHERE f.environment_id=$1 AND f.project_id=$2 AND f.organization_id=$3 ORDER BY f.activated_at DESC LIMIT 50`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows;
    return { active: rows.filter((row) => row.released_at === null), history: rows };
  }

  /**
   * Is ANY freeze active in this environment? Used only by the environment-wide
   * banner, which is a true statement about the environment.
   *
   * This is NOT the question a workload label may ask. See `freezeCoverage`.
   */
  async freezeState(scope: TenantScope): Promise<{ frozen: boolean; freezes: Record<string, unknown>[] }> {
    const { active } = await this.freezes(scope);
    return { frozen: active.length > 0, freezes: active };
  }

  /**
   * Would a freeze actually block THIS Agent and THIS EffectSpec right now?
   *
   * Uses the identical predicate admission uses, imported from admission.ts,
   * so readiness and the gate can never diverge. Go-Live previously called
   * `freezeState` and therefore labelled every workload in the environment
   * Frozen as soon as one narrowly scoped freeze existed.
   */
  async freezeCoverage(scope: TenantScope, agentId: string | null, effectName: string | null): Promise<{ frozen: boolean; freeze_id: string | null; scope_description: string | null }> {
    const row = (await this.db.query(
      `SELECT freeze_id,scope_agent_id,scope_effect_name FROM nyst_freezes
       WHERE ${FREEZE_COVERAGE_PREDICATE} ORDER BY activated_at, freeze_id LIMIT 1`,
      [scope.environment_id, agentId, effectName])).rows[0];
    if (!row) return { frozen: false, freeze_id: null, scope_description: null };
    return {
      frozen: true, freeze_id: String(row.freeze_id),
      scope_description: row.scope_agent_id === null && row.scope_effect_name === null
        ? "the whole environment"
        : [row.scope_agent_id ? "this Agent" : null, row.scope_effect_name ? `EffectSpec ${String(row.scope_effect_name)}` : null].filter(Boolean).join(" and "),
    };
  }

  /**
   * The single admission gate. Records the decision, and on a HOLD also records
   * a durable intervention and opens Human Review, because a blocked
   * consequence is exactly the kind of event an operator must see.
   */
  async admitConsequence(scope: TenantScope, request: AdmissionRequest): Promise<AdmissionDecision> {
    const decision = await admitConsequence(this.db, scope, request);
    if (!decision.admitted) {
      await this.recordIntervention(scope, {
        kind: decision.blocked_by === "freeze" ? "freeze_blocked" : "blast_radius_hold",
        agent_id: request.agent_id ?? null, effect_name: request.effect_name,
        mode: normalizeMode((await this.environmentControl(scope)).mode),
        intervention_key: `${decision.blocked_by}:${scope.environment_id}:${request.effect_name}:${request.business_key}`,
        summary: decision.reason,
        detail: { limit_kind: decision.limit_kind, observed_value: decision.observed_value, limit_value: decision.limit_value, window_seconds: decision.window_seconds },
        action_id: null,
      });
    }
    return decision;
  }

  async linkAdmission(admissionId: string, actionId: string): Promise<void> { await linkAdmissionToAction(this.db, admissionId, actionId); }

  async admissionHistory(scope: TenantScope, limit = 25): Promise<Record<string, unknown>[]> {
    return (await this.db.query(`SELECT admission_id,agent_id,effect_name,business_key,amount_minor,currency,admitted,blocked_by,reason,decided_at
      FROM nyst_consequence_admissions WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3
      ORDER BY decided_at DESC LIMIT $4`, [scope.environment_id, scope.project_id, scope.organization_id, Math.min(Math.max(1, limit), 200)])).rows;
  }

  /* ==================================================================
   * POLICY TEMPLATES (Phase 12)
   * ================================================================== */

  /**
   * Create a policy version from a built-in template.
   *
   * Templates use the EXISTING policy engine — they are ordinary versioned
   * policies with sensible starting values. There is no second policy engine
   * and no policy DSL. A customer may then make a template STRICTER; nothing
   * can make it weaker than the Nyst safety floor, because the floor is
   * applied by the runtime, not by the policy.
   */
  async createPolicyFromTemplate(scope: TenantScope, userId: string, templateId: PolicyTemplateId, effectName: string | null): Promise<Record<string, unknown>> {
    const template = POLICY_TEMPLATES.find((item) => item.template_id === templateId);
    if (!template) throw new Error("Unknown policy template");
    // Written at INSERT time: a policy version is immutable once created, so
    // the template provenance has to be part of the original row.
    const created = await this.createPolicyVersion(scope, userId, { effect_name: effectName, ...template.policy, template_id: templateId });
    return { ...created, template_name: template.name };
  }

  async policyTemplates(): Promise<typeof POLICY_TEMPLATES> { return POLICY_TEMPLATES; }


  /* ==================================================================
   * PROTECTION REPORT (Phase 9)
   * ================================================================== */

  /** Assemble the buyer-facing report entirely from persisted records. */
  async protectionReport(scope: TenantScope, secrets: SecretProvider, rangeLabel: MetricRange["label"] = "7d", from?: string, to?: string, now: Date = new Date()): Promise<ProtectionReport> {
    const [metrics, info, readiness] = await Promise.all([
      this.canonicalMetrics(scope, rangeLabel, from, to, now),
      this.projectInfo(scope),
      this.integrationsReadiness(scope, secrets, now),
    ]);

    const unresolved = Number((await this.db.query(
      `SELECT count(*)::int c FROM nyst_human_reviews WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND status='open'`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows[0]!.c);

    // Highest-risk incident: the most severe UNRESOLVED state Nyst currently
    // holds, ranked by how little it can prove. Chosen from persisted rows.
    const incident = (await this.db.query(`SELECT s.action_id,a.effect_name,ag.name agent_name,r.effect_state,r.primary_directive,r.resolved_at,
        r.retry_disposition,r.continuation_disposition,
        (a.input->>'amount_minor')::bigint amount_minor,a.input->>'currency' currency
      FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) LEFT JOIN nyst_agents ag ON ag.agent_id=s.agent_id
      JOIN LATERAL(SELECT * FROM outcome_resolutions WHERE action_id=s.action_id ORDER BY resolution_sequence DESC NULLS LAST,resolved_at DESC LIMIT 1) r ON true
      JOIN nyst_environments env ON env.environment_id=s.environment_id AND env.is_demo=false
      WHERE s.environment_id=$1 AND s.project_id=$2 AND s.organization_id=$3
        AND r.effect_state IN ('unprovable','pending','satisfied_unattributed')
      ORDER BY CASE r.effect_state WHEN 'unprovable' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, r.resolved_at DESC LIMIT 1`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows[0];

    const highest: HighestRiskIncident | null = incident ? {
      action_id: String(incident.action_id),
      effect_name: String(incident.effect_name),
      agent_name: incident.agent_name ? String(incident.agent_name) : null,
      effect_state: String(incident.effect_state),
      control_decision: String(incident.primary_directive),
      occurred_at: new Date(String(incident.resolved_at)).toISOString(),
      explanation: incidentExplanation(String(incident.effect_state), String(incident.retry_disposition), String(incident.continuation_disposition)),
      exposure: incident.amount_minor !== null && incident.amount_minor !== undefined && typeof incident.currency === "string"
        ? { amount_minor: Number(incident.amount_minor), currency: String(incident.currency) } : null,
    } : null;

    const byAgent = (await this.db.query(`SELECT coalesce(ag.name,'unattributed') agent,count(*)::int actions,
        (SELECT count(*)::int FROM nyst_intervention_events i WHERE i.environment_id=$1 AND i.agent_id IS NOT DISTINCT FROM s.agent_id) interventions
      FROM nyst_action_scopes s LEFT JOIN nyst_agents ag ON ag.agent_id=s.agent_id
      WHERE s.environment_id=$1 AND s.project_id=$2 AND s.organization_id=$3
      GROUP BY coalesce(ag.name,'unattributed'),s.agent_id ORDER BY actions DESC LIMIT 20`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows
      .map((row) => ({ agent: String(row.agent), actions: Number(row.actions), interventions: Number(row.interventions) }));

    const byEffect = (await this.db.query(`SELECT a.effect_name,count(*)::int actions,
        (SELECT count(*)::int FROM nyst_intervention_events i WHERE i.environment_id=$1 AND i.effect_name=a.effect_name) interventions
      FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id)
      WHERE s.environment_id=$1 AND s.project_id=$2 AND s.organization_id=$3
      GROUP BY a.effect_name ORDER BY actions DESC LIMIT 20`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows
      .map((row) => ({ effect_name: String(row.effect_name), actions: Number(row.actions), interventions: Number(row.interventions) }));

    // Financial exposure is reported ONLY for actions that BOTH carry an
    // authoritative amount AND actually had a duplicate risk prevented. It is
    // an exposure figure, never a claimed saving.
    const exposure = (await this.db.query(`SELECT a.input->>'currency' currency,
        sum((a.input->>'amount_minor')::bigint) amount_minor, count(*)::int action_count
      FROM nyst_intervention_events i JOIN nyst_action_scopes s ON s.action_id=i.action_id JOIN outcome_actions a ON a.action_id=i.action_id
      WHERE i.environment_id=$1 AND i.project_id=$2 AND i.organization_id=$3
        AND i.kind='retry_blocked' AND i.mode IN ('canary','enforced')
        AND a.input ? 'amount_minor' AND a.input ? 'currency'
      GROUP BY a.input->>'currency' ORDER BY 2 DESC LIMIT 1`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows[0];

    return buildProtectionReport({
      metrics,
      environment: { organization: String(info?.organization ?? ""), project: String(info?.project ?? ""), environment: String(info?.environment ?? "") },
      readiness, unresolved_incidents: unresolved, highest_risk_incident: highest,
      risk_by_agent: byAgent, risk_by_effect: byEffect,
      demonstrated_financial_exposure: exposure && exposure.currency
        ? { currency: String(exposure.currency), amount_minor: Number(exposure.amount_minor), action_count: Number(exposure.action_count) } : null,
      generated_at: now.toISOString(),
    });
  }


  /* ==================================================================
   * GO-LIVE READINESS (Phase 13)
   * ================================================================== */

  async goLiveReadiness(scope: TenantScope, secrets: SecretProvider, agentId: string | null, effectName: string, descriptors: readonly EffectSpecDescriptor[], now: Date = new Date()): Promise<GoLiveReadiness> {
    const descriptor = descriptors.find((item) => item.effect_name === effectName);
    const provider = descriptor?.provider ?? effectName.split(".")[0] ?? "unknown";
    const credentialFree = provider === "fake";

    const [enabled, agent, execution, frozen, policy, webhook] = await Promise.all([
      this.db.query(`SELECT spec_version,enabled FROM nyst_environment_effect_specs WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND effect_name=$4`,
        [scope.environment_id, scope.project_id, scope.organization_id, effectName]),
      agentId ? this.db.query(`SELECT agent_id,name,status FROM nyst_agents WHERE agent_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4`,
        [agentId, scope.environment_id, scope.project_id, scope.organization_id]) : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
      this.resolveExecutionMode(scope, agentId, effectName),
      // The SCOPED question, not "is anything frozen anywhere". Phase 1E.
      this.freezeCoverage(scope, agentId, effectName),
      // Phase 1F: ask the production resolver WHICH immutable policy this exact
      // workload would bind, not whether some policy row exists somewhere in
      // the environment. The old query returned true for an environment holding
      // only a policy for an unrelated EffectSpec.
      this.effectivePolicyFor(scope, effectName),
      this.db.query(`SELECT enabled FROM nyst_webhook_endpoints WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3`,
        [scope.environment_id, scope.project_id, scope.organization_id]),
    ]);

    const integration = credentialFree || !["github", "okta", "stripe"].includes(provider)
      ? null
      : await this.integrationReadiness(scope, provider, secrets, now);

    const agentRow = agent.rows[0];
    return evaluateGoLiveReadiness({
      agent_id: agentId,
      agent_name: agentRow ? String(agentRow.name) : null,
      agent_status: agentRow ? (String(agentRow.status) as "active" | "paused" | "retired") : null,
      effect_name: effectName,
      spec_version: enabled.rows[0]?.spec_version ? String(enabled.rows[0]!.spec_version) : null,
      spec_enabled: enabled.rows[0]?.enabled === true,
      environment_mode: execution.environment_mode,
      execution_mode: execution.mode,
      integration,
      credential_free_effect: credentialFree,
      policy_bound: policy !== null,
      policy_description: policy
        ? `Policy version ${policy.version}${policy.effect_name ? ` for ${policy.effect_name}` : " (environment fallback)"}, ${policy.execution_mode.replace("_", " ")}.`
        : null,
      frozen: frozen.frozen,
      freeze_scope_description: frozen.scope_description,
      // Every registered EffectSpec in this build carries an authoritative
      // observation method; an unregistered one does not.
      observation_semantics_available: descriptor !== undefined,
      recovery_behavior_known: descriptor !== undefined,
      webhook_required: false,
      webhook_configured: webhook.rows[0]?.enabled === true,
    });
  }

  /** Readiness for every Agent x enabled EffectSpec pair in this environment. */
  async goLiveMatrix(scope: TenantScope, secrets: SecretProvider, descriptors: readonly EffectSpecDescriptor[], now: Date = new Date()): Promise<GoLiveReadiness[]> {
    const agents = await this.agents(scope);
    const enabled = (await this.db.query(`SELECT effect_name FROM nyst_environment_effect_specs WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND enabled ORDER BY effect_name`,
      [scope.environment_id, scope.project_id, scope.organization_id])).rows.map((row) => String(row.effect_name));
    const out: GoLiveReadiness[] = [];
    for (const agent of agents.length ? agents : [{ agent_id: null }]) {
      for (const effectName of enabled) {
        out.push(await this.goLiveReadiness(scope, secrets, agent.agent_id ? String(agent.agent_id) : null, effectName, descriptors, now));
      }
    }
    return out;
  }

  /* ==================================================================
   * INCIDENT INBOX (Phase 14) — "Needs Attention"
   *
   * Sourced from the DURABLE human review and intervention state that
   * already exists. There is deliberately no second incident database.
   * ================================================================== */

  async needsAttention(scope: TenantScope): Promise<Record<string, unknown>[]> {
    const reviews = (await this.db.query(`SELECT h.human_review_id,h.action_id,h.status,h.reason,h.opened_at,
        a.effect_name,a.spec_version,ag.name agent_name,s.display_business_key,b.environment_mode,
        r.effect_state,r.primary_directive,r.retry_disposition,r.continuation_disposition,r.recovery_disposition,
        extract(epoch FROM (now()-h.opened_at))::bigint age_seconds,
        EXISTS(SELECT 1 FROM nyst_reobservation_jobs j WHERE j.human_review_id=h.human_review_id AND j.status IN ('requested','executing')) reobservation_in_flight,
        EXISTS(SELECT 1 FROM nyst_reconciliation_suppressions sup WHERE sup.action_id=h.action_id) automatic_reconciliation_suppressed
      FROM nyst_human_reviews h
      JOIN nyst_action_scopes s USING(action_id) JOIN outcome_actions a USING(action_id)
      LEFT JOIN nyst_agents ag ON ag.agent_id=s.agent_id
      LEFT JOIN nyst_action_policy_bindings b ON b.action_id=h.action_id
      JOIN LATERAL(SELECT * FROM outcome_resolutions WHERE action_id=h.action_id ORDER BY resolution_sequence DESC NULLS LAST,resolved_at DESC LIMIT 1) r ON true
      WHERE h.environment_id=$1 AND h.project_id=$2 AND h.organization_id=$3 AND h.status IN ('open','reobservation_requested')
      ORDER BY h.opened_at DESC LIMIT 100`, [scope.environment_id, scope.project_id, scope.organization_id])).rows;

    // Held consequences never became actions, so they cannot have a review row.
    // Their durable intervention IS the incident, and it belongs in the same
    // inbox rather than in a place nobody looks.
    const held = (await this.db.query(`SELECT i.intervention_id,i.kind,i.effect_name,i.summary,i.detail,i.occurred_at,ag.name agent_name,i.mode,
        extract(epoch FROM (now()-i.occurred_at))::bigint age_seconds
      FROM nyst_intervention_events i LEFT JOIN nyst_agents ag ON ag.agent_id=i.agent_id
      WHERE i.environment_id=$1 AND i.project_id=$2 AND i.organization_id=$3
        AND i.kind IN ('blast_radius_hold','freeze_blocked') AND i.action_id IS NULL
      ORDER BY i.occurred_at DESC LIMIT 50`, [scope.environment_id, scope.project_id, scope.organization_id])).rows;

    const incidents = reviews.map((row) => {
      const state = String(row.effect_state);
      return {
        incident_id: String(row.human_review_id),
        source: "human_review" as const,
        action_id: String(row.action_id),
        title: incidentTitle(state, String(row.effect_name)),
        agent: row.agent_name ? String(row.agent_name) : "unattributed",
        effect_name: String(row.effect_name),
        spec_version: String(row.spec_version),
        mode: normalizeMode(row.environment_mode),
        age_seconds: Number(row.age_seconds),
        effect_state: state,
        control_decision: String(row.primary_directive),
        what_happened: String(row.reason),
        what_nyst_knows: knownFacts(state, String(row.retry_disposition), String(row.continuation_disposition)),
        what_nyst_does_not_know: unknownFacts(state),
        why_nyst_stopped: whyStopped(state, String(row.primary_directive)),
        automatic_reconciliation_suppressed: row.automatic_reconciliation_suppressed === true,
        safe_actions: safeActions({
          status: String(row.status),
          reobservationInFlight: row.reobservation_in_flight === true,
          recovery: String(row.recovery_disposition),
        }),
      };
    });

    const heldIncidents = held.map((row) => ({
      incident_id: String(row.intervention_id),
      source: "held_consequence" as const,
      action_id: null,
      title: row.kind === "freeze_blocked" ? "Consequence blocked by Emergency Freeze" : "Consequence held by Blast Radius",
      agent: row.agent_name ? String(row.agent_name) : "unattributed",
      effect_name: String(row.effect_name),
      spec_version: null,
      mode: normalizeMode(row.mode),
      age_seconds: Number(row.age_seconds),
      effect_state: "not_applied",
      control_decision: "hold",
      what_happened: String(row.summary),
      what_nyst_knows: ["The consequence was never dispatched, so no external effect occurred from this attempt."],
      what_nyst_does_not_know: ["Whether the caller will retry once the hold is lifted."],
      why_nyst_stopped: String(row.summary),
      automatic_reconciliation_suppressed: false,
      safe_actions: ["acknowledge"],
    }));

    // Oldest first: the thing that has been waiting longest needs attention most.
    return [...incidents, ...heldIncidents].sort((left, right) => Number(right.age_seconds) - Number(left.age_seconds));
  }

  /* ==================================================================
   * PROOF PACK (Phase 18)
   * ================================================================== */

  async proofPack(scope: TenantScope, actionId: string, verifyReceipt?: (receipt: unknown) => boolean, now: Date = new Date()): Promise<ProofPack | null> {
    const detail = await this.actionDetail(scope, actionId);
    if (!detail) return null;

    const [info, evidence, resolutions, interventions, recovery, review, receipt, events, agent, policy, runtime] = await Promise.all([
      this.projectInfo(scope),
      this.evidence(scope, actionId),
      this.db.query(`SELECT resolution_sequence,effect_state,primary_directive,retry_disposition,continuation_disposition,recovery_disposition,resolved_at,resolution_id
        FROM outcome_resolutions WHERE action_id=$1 ORDER BY resolution_sequence NULLS FIRST,resolved_at`, [actionId]),
      this.db.query(`SELECT kind,mode,summary,detail,occurred_at FROM nyst_intervention_events WHERE action_id=$1 ORDER BY occurred_at`, [actionId]),
      this.db.query(`SELECT operation,status,dispatch_state,attempt,needs_review_reason,created_at,completed_at FROM nyst_recovery_executions WHERE action_id=$1 ORDER BY created_at`, [actionId]),
      this.db.query(`SELECT human_review_id,status,reason,opened_at,reviewed_at FROM nyst_human_reviews WHERE action_id=$1`, [actionId]),
      this.receipt(scope, actionId),
      this.db.query(`SELECT event_type,occurred_at,delivered_at FROM nyst_webhook_events WHERE action_id=$1 ORDER BY occurred_at`, [actionId]),
      this.db.query(`SELECT ag.agent_id,ag.name,ag.owner,ag.framework FROM nyst_action_scopes s JOIN nyst_agents ag USING(agent_id) WHERE s.action_id=$1`, [actionId]),
      this.db.query(`SELECT p.policy_version_id,p.version,p.execution_mode,p.retry_mode,p.auto_continuation,p.auto_compensation,p.reconcile_timeout_seconds,p.template_id,
          b.environment_mode,b.reconcile_deadline_at,b.bound_at FROM nyst_action_policy_bindings b JOIN nyst_policy_versions p USING(policy_version_id) WHERE b.action_id=$1`, [actionId]),
      this.db.query(`SELECT dispatch_status,dispatch_attempts FROM outcome_runtime WHERE action_id=$1`, [actionId]),
    ]);

    const latest = resolutions.rows.at(-1);
    const action = detail as Record<string, unknown>;
    const plan = (action.dispatch_plan ?? null) as Record<string, unknown> | null;
    const correlation = (plan?.correlation ?? null) as { method?: unknown; value?: unknown } | null;
    const policyRow = policy.rows[0];
    const verified = receipt && verifyReceipt ? verifyReceipt(receipt) : null;

    return {
      proof_pack_version: 1,
      generated_at: now.toISOString(),
      provenance: "assembled_from_persisted_records",
      action: {
        action_id: actionId,
        business_key: String(action.display_business_key ?? action.business_key ?? ""),
        effect_name: String(action.effect_name ?? ""),
        spec_version: String(action.spec_version ?? ""),
        input_hash: String(action.input_hash ?? ""),
        internal_state: String(action.internal_state ?? ""),
        created_at: String(action.created_at ?? ""),
      },
      agent: agent.rows[0] ? { agent_id: String(agent.rows[0]!.agent_id), name: String(agent.rows[0]!.name), owner: String(agent.rows[0]!.owner), framework: String(agent.rows[0]!.framework) } : null,
      environment: { organization: String(info?.organization ?? ""), project: String(info?.project ?? ""), environment: String(info?.environment ?? ""),
        mode: policyRow ? String(policyRow.environment_mode) : "unknown" },
      policy: policyRow ? {
        policy_version_id: String(policyRow.policy_version_id), version: Number(policyRow.version),
        execution_mode: String(policyRow.execution_mode), retry_mode: String(policyRow.retry_mode),
        auto_continuation: policyRow.auto_continuation === true, auto_compensation: policyRow.auto_compensation === true,
        reconcile_timeout_seconds: Number(policyRow.reconcile_timeout_seconds),
        template_id: policyRow.template_id ? String(policyRow.template_id) : null,
        bound_at: String(policyRow.bound_at ?? ""), reconcile_deadline_at: String(policyRow.reconcile_deadline_at ?? ""),
      } : null,
      intent: action.input ?? null,
      dispatch_boundary: {
        correlation_method: correlation?.method ? String(correlation.method) : null,
        correlation_value: correlation?.value ? String(correlation.value) : null,
        idempotency_key: plan?.idempotency_key ? String(plan.idempotency_key) : null,
        provider: plan?.provider ? String(plan.provider) : null,
        operation: plan?.operation ? String(plan.operation) : null,
        dispatch_status: runtime.rows[0]?.dispatch_status ? String(runtime.rows[0]!.dispatch_status) : null,
        dispatch_attempts: runtime.rows[0]?.dispatch_attempts === undefined ? null : Number(runtime.rows[0]!.dispatch_attempts),
      },
      evidence: (evidence ?? []) as ReadonlyArray<Record<string, unknown>>,
      resolution_history: resolutions.rows,
      current: latest ? {
        effect_state: String(latest.effect_state),
        control: { primary: String(latest.primary_directive), retry: String(latest.retry_disposition), continuation: String(latest.continuation_disposition), recovery: String(latest.recovery_disposition) },
        reason_code: String(((receipt?.control ?? {}) as Record<string, unknown>).reason_code ?? ""),
        explanation: String(((receipt?.control ?? {}) as Record<string, unknown>).explanation ?? ""),
      } : null,
      interventions: interventions.rows,
      recovery_history: recovery.rows,
      human_review: review.rows[0] ?? null,
      receipt: receipt ? sanitizeForProduct(receipt) as Record<string, unknown> : null,
      receipt_verification: {
        verified,
        note: verified === null
          ? "No verifier was supplied, so the signature was not checked in this bundle."
          : verified
            ? "The Ed25519 software signature over the canonical receipt verified successfully. This is tamper evidence, not hardware attestation."
            : "SIGNATURE VERIFICATION FAILED. Treat this receipt as untrustworthy and investigate.",
      },
      webhook_events: events.rows,
      attestations: PROOF_PACK_ATTESTATIONS,
    };
  }

  /** Operational health across every queue and worker. Never tenant-scoped. */
  async operationalHealth(now: Date = new Date()): Promise<OperationalHealth> { return operationalHealth(this.db, now); }

  /** Called by each worker loop so the product can tell a dead worker from an idle one. */
  async recordWorkerHeartbeat(kind: WorkerKind, instance: string): Promise<void> { return recordWorkerHeartbeat(this.db, kind, instance); }

  private async requireTenantScope(scope: TenantScope): Promise<void> {
    const result = await this.db.query(`SELECT 1 FROM nyst_environments WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3`, [scope.environment_id, scope.project_id, scope.organization_id]);
    if (!result.rows.length) throw new Error("Resource belongs to a different tenant scope");
  }
}

export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function bounded(value: string, max: number, label: string): string { if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${label}`); return value; }
function slug(value: string): string { const out = bounded(value, 63, "slug").toLowerCase(); if (!/^[a-z][a-z0-9-]{1,62}$/.test(out)) throw new Error("Invalid slug"); return out; }
function normalizedEmail(value: string): string { const out = bounded(value, 320, "email").trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out)) throw new Error("Invalid email"); return out; }
function validDate(value: string): string { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error("Invalid date filter"); return date.toISOString(); }

/** Deterministic causal explanation from the persisted resolution alone. */
function incidentExplanation(state: string, retry: string, continuation: string): string {
  const cause = state === "unprovable"
    ? "Nyst cannot determine what happened externally: the evidence it holds does not support any terminal claim."
    : state === "pending"
      ? "The external effect has not settled: the provider may still be converging, or an observation is outstanding."
      : "The desired external state exists, but the provider cannot attribute it to this exact Nyst action.";
  return `${cause} Retry is ${retry}; continuation is ${continuation}.`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Narrow a persisted mode string to the EnvironmentMode union, failing closed on Shadow. */
function normalizeMode(value: unknown): EnvironmentMode {
  return value === "shadow" ? "shadow" : value === "canary" ? "canary" : "enforced";
}

/* --------------------------------------------------------------------------
 * Incident narration. Every string below is derived from persisted state; none
 * of it is a template filled with plausible-sounding detail.
 * -------------------------------------------------------------------------- */

function incidentTitle(state: string, effectName: string): string {
  switch (state) {
    case "unprovable": return `${effectName} outcome unprovable`;
    case "pending": return `${effectName} still unresolved`;
    case "satisfied_unattributed": return `${effectName} goal present but unattributed`;
    case "not_applied": return `${effectName} did not take effect`;
    default: return `${effectName} needs attention`;
  }
}

function knownFacts(state: string, retry: string, continuation: string): string[] {
  const facts = [`Retry is ${retry}. Continuation is ${continuation}.`];
  switch (state) {
    case "satisfied_unattributed":
      facts.push("The desired external state exists right now.", "Nyst read it back from the provider's system of record.");
      break;
    case "pending":
      facts.push("The provider has not yet settled into a state Nyst can call terminal.");
      break;
    case "unprovable":
      facts.push("Nyst holds evidence about the request, but none of it establishes what happened externally.");
      break;
    case "not_applied":
      facts.push("Nyst has affirmative evidence that the intended effect is absent.");
      break;
  }
  return facts;
}

function unknownFacts(state: string): string[] {
  switch (state) {
    case "satisfied_unattributed":
      return ["Whether THIS action caused the observed state. The provider offers no action-correlated read-back, so another actor may have produced it."];
    case "pending":
      return ["The final external state.", "Whether the provider will converge or has silently failed."];
    case "unprovable":
      return ["Whether the external effect occurred at all.", "Whether a retry would duplicate it."];
    case "not_applied":
      return ["Whether the original dispatch left the process, which is what determines if a retry is safe."];
    default:
      return ["The full external state."];
  }
}

function whyStopped(state: string, primary: string): string {
  if (primary === "hold") return "Nyst is holding because continuing would depend on an external fact it cannot yet establish.";
  if (primary === "escalate") return "Nyst escalated because no safe automatic path remains: proceeding would require guessing.";
  if (state === "satisfied_unattributed") return "Nyst will not claim credit for a state it cannot attribute, and will not repeat a mutation that may already have happened.";
  return "Nyst stopped rather than take an action whose safety it could not establish.";
}

/**
 * The operations a human may take. Every one is read-only, an acknowledgement,
 * or an operation the runtime already permits. There is no force-continue,
 * no manual EffectState edit, and no evidence authoring.
 */
function safeActions(input: { status: string; reobservationInFlight: boolean; recovery: string }): string[] {
  const actions: string[] = ["acknowledge"];
  if (!input.reobservationInFlight && input.status === "open") actions.push("request_reobservation");
  if (input.recovery === "compensate") actions.push("authorize_supported_compensation");
  actions.push("cancel_workflow");
  return actions;
}
