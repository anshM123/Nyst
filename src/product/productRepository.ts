import { createHash, randomBytes, randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type { ActionFilters, EffectSpecDescriptor, ProductContext, ProductPrincipal, TenantScope } from "./types.js";
import { assessEffectShadow, validateWebhookTarget, type ConservativePolicy, type EnvironmentMode, type FailureScenario, type ShadowObservation } from "./controlPlane.js";
import type { OutcomeResolution } from "../model/resolution.js";
import { runFailureLabEngine } from "./failureLabEngine.js";

export interface ProductDb {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const SESSION_HOURS = 12;
const ALLOWED_API_SCOPES = new Set(["actions:read", "actions:write", "receipts:read", "integrations:read"]);
const EXPECTED_PROVIDER_REFS: Readonly<Record<string, string>> = { github: "env:NYST_GITHUB_TOKEN", okta: "env:NYST_OKTA_ACCESS_TOKEN", stripe: "env:NYST_STRIPE_CREDENTIAL" };

export class ProductRepository {
  constructor(private readonly db: ProductDb) {}
  async health():Promise<void>{await this.db.query("SELECT 1")}

  async createBootstrap(input: { organization: string; organization_slug: string; project: string; project_slug: string; environment: string; environment_slug: string; email: string; display_name: string; password: string }): Promise<TenantScope & { user_id: string }> {
    const organizationId = randomUUID(); const projectId = randomUUID(); const environmentId = randomUUID(); const userId = randomUUID();
    const email = normalizedEmail(input.email); const passwordHash = await hash(input.password, 12);
    await this.db.query(`WITH organization AS (
      INSERT INTO nyst_organizations(organization_id,slug,name) VALUES($1,$5,$6) RETURNING organization_id
    ), project AS (
      INSERT INTO nyst_projects(project_id,organization_id,slug,name) SELECT $2,organization_id,$7,$8 FROM organization RETURNING project_id,organization_id
    ), environment AS (
      INSERT INTO nyst_environments(environment_id,project_id,organization_id,slug,name) SELECT $3,project_id,organization_id,$9,$10 FROM project
    ) INSERT INTO nyst_users(user_id,organization_id,email,display_name,password_hash) SELECT $4,organization_id,$11,$12,$13 FROM organization`,
      [organizationId, projectId, environmentId, userId, slug(input.organization_slug), bounded(input.organization, 120, "organization"), slug(input.project_slug), bounded(input.project, 120, "project"), slug(input.environment_slug), bounded(input.environment, 120, "environment"), email, bounded(input.display_name, 120, "display name"), passwordHash]);
    await this.db.query(`INSERT INTO nyst_policy_versions(policy_version_id,environment_id,project_id,organization_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_by)
      VALUES($1,$2,$3,$4,NULL,1,'automatic','never',false,false,300,$5)`, [randomUUID(), environmentId, projectId, organizationId, userId]);
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
    return { session, csrf, principal: { kind: "session", user_id: String(row.user_id), api_key_id: null,
      organization_id: String(row.organization_id), project_id: String(row.project_id), environment_id: String(row.environment_id), scopes: ["*"], csrf_hash: digest(csrf) } };
  }

  async authenticateSession(session: string): Promise<ProductPrincipal | null> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(session)) return null;
    const result = await this.db.query(`UPDATE nyst_sessions s SET last_seen_at=now() FROM nyst_users u
      WHERE s.session_hash=$1 AND s.user_id=u.user_id AND s.organization_id=u.organization_id
        AND s.expires_at>now() AND u.disabled_at IS NULL
      RETURNING u.user_id,s.organization_id,s.selected_project_id project_id,s.selected_environment_id environment_id,s.csrf_hash`, [digest(session)]);
    const row = result.rows[0]; if (!row) return null;
    return { kind: "session", user_id: String(row.user_id), api_key_id: null, organization_id: String(row.organization_id), project_id: String(row.project_id), environment_id: String(row.environment_id), scopes: ["*"], csrf_hash: String(row.csrf_hash) };
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
      project.environments.push({ environment_id: String(row.environment_id), environment_name: String(row.environment_name), environment_slug: String(row.environment_slug), mode: row.mode === "shadow" ? "shadow" : "enforced", is_demo: row.is_demo === true });
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

  async createEnvironment(scope: Pick<TenantScope, "organization_id" | "project_id">, name: string, environmentSlug: string): Promise<string> {
    const id = randomUUID();
    await this.db.query(`INSERT INTO nyst_environments(environment_id,project_id,organization_id,slug,name) VALUES($1,$2,$3,$4,$5)`, [id, scope.project_id, scope.organization_id, slug(environmentSlug), bounded(name, 120, "environment")]);
    await this.db.query(`INSERT INTO nyst_policy_versions(policy_version_id,environment_id,project_id,organization_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_by)
      SELECT $1,$2,$3,$4,NULL,1,'automatic','never',false,false,300,user_id FROM nyst_users
      WHERE organization_id=$4 AND disabled_at IS NULL ORDER BY created_at,user_id LIMIT 1`, [randomUUID(), id, scope.project_id, scope.organization_id]);
    return id;
  }

  async createApiKey(scope: TenantScope, name: string, scopes: readonly string[], expiresAt: string | null = null): Promise<{ api_key_id: string; key: string; prefix: string }> {
    if (!scopes.length || scopes.some((value) => !ALLOWED_API_SCOPES.has(value))) throw new Error("Unsupported API key scope");
    const id = randomUUID(); const prefix = `nyst_${randomBytes(6).toString("hex")}`; const key = `${prefix}.${randomBytes(32).toString("base64url")}`;
    await this.db.query(`INSERT INTO nyst_api_keys(api_key_id,organization_id,project_id,environment_id,name,prefix,secret_hash,scopes,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, scope.organization_id, scope.project_id, scope.environment_id, bounded(name, 120, "API key name"), prefix, digest(key), [...scopes], expiresAt]);
    return { api_key_id: id, key, prefix };
  }

  async authenticateApiKey(key: string): Promise<ProductPrincipal | null> {
    if (!/^nyst_[a-z0-9]{8,20}\.[A-Za-z0-9_-]{40,100}$/.test(key)) return null;
    const result = await this.db.query(`UPDATE nyst_api_keys SET last_used_at=now() WHERE secret_hash=$1 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now()) RETURNING api_key_id,organization_id,project_id,environment_id,scopes`, [digest(key)]);
    const row = result.rows[0]; if (!row) return null;
    return { kind: "api_key", user_id: null, api_key_id: String(row.api_key_id), organization_id: String(row.organization_id), project_id: String(row.project_id), environment_id: String(row.environment_id), scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [], csrf_hash: null };
  }

  async revokeApiKey(scope: TenantScope, keyId: string): Promise<boolean> {
    const result = await this.db.query(`UPDATE nyst_api_keys SET revoked_at=now() WHERE api_key_id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4 AND revoked_at IS NULL RETURNING api_key_id`, [keyId, scope.organization_id, scope.project_id, scope.environment_id]);
    return result.rows.length === 1;
  }

  async scopeAction(scope: TenantScope, actionId: string, displayBusinessKey: string): Promise<void> {
    const display = bounded(displayBusinessKey, 500, "business key");
    await this.db.query(`INSERT INTO nyst_action_scopes(action_id,environment_id,project_id,organization_id,display_business_key)
      SELECT a.action_id,$2::uuid,$3::uuid,$4::uuid,$5::text FROM outcome_actions a
      WHERE a.action_id=$1::uuid AND a.business_key=$2::uuid::text||':'||$5::text
      ON CONFLICT(action_id) DO NOTHING`, [actionId, scope.environment_id, scope.project_id, scope.organization_id, display]);
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

  async apiKeys(scope:TenantScope):Promise<Record<string,unknown>[]>{return (await this.db.query(`SELECT api_key_id,name,prefix,scopes,created_at,last_used_at,expires_at,revoked_at FROM nyst_api_keys WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY created_at DESC`,[scope.organization_id,scope.project_id,scope.environment_id])).rows;}

  async effectSpecStatuses(scope:TenantScope,descriptors:readonly EffectSpecDescriptor[],production:boolean):Promise<Record<string,unknown>[]>{
    await this.requireTenantScope(scope);const result=await this.db.query(`SELECT s.effect_name,s.spec_version,s.enabled,i.configured,i.credential_ref FROM nyst_environment_effect_specs s LEFT JOIN nyst_integrations i ON i.environment_id=s.environment_id AND i.project_id=s.project_id AND i.organization_id=s.organization_id AND i.provider=split_part(s.effect_name,'.',1) WHERE s.organization_id=$1 AND s.project_id=$2 AND s.environment_id=$3`,[scope.organization_id,scope.project_id,scope.environment_id]);const configured=new Map(result.rows.map(row=>[String(row.effect_name),row]));
    return descriptors.map(descriptor=>{const row=configured.get(descriptor.effect_name);const versionMatches=!!row&&String(row.spec_version)===descriptor.spec_version;const enabled=versionMatches&&row.enabled===true;const integrationReady=descriptor.provider==="fake"?!production:row?.configured===true&&row?.credential_ref===EXPECTED_PROVIDER_REFS[descriptor.provider];const ready=enabled&&integrationReady;const status=!row?"available":!versionMatches?"historical_version":!enabled?"disabled":ready?"ready":"blocked_missing_integration";return {...descriptor,available:true,enabled,ready,status,configured_spec_version:row?String(row.spec_version):null,integration_configured:row?.configured===true,credential_ref:row?.credential_ref??null}});
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
    if (credentialRef !== EXPECTED_PROVIDER_REFS[descriptor.provider]) throw Object.assign(new Error("Configured credential topology is unsupported by this provider runtime"), { statusCode: 409 });
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

  async overview(scope: TenantScope): Promise<Record<string, unknown>> {
    const params = [scope.organization_id, scope.project_id, scope.environment_id];
    const result = await this.db.query(`WITH latest AS (SELECT DISTINCT ON (r.action_id) r.* FROM outcome_resolutions r ORDER BY r.action_id,r.resolution_sequence DESC NULLS LAST,r.resolved_at DESC), scoped AS (
      SELECT a.action_id,a.created_at,a.effect_name,coalesce(a.dispatch_plan->>'provider',split_part(a.effect_name,'.',1)) provider,l.effect_state,l.primary_directive,l.retry_disposition
      FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) LEFT JOIN latest l USING(action_id)
      WHERE s.organization_id=$1 AND s.project_id=$2 AND s.environment_id=$3), marked AS (SELECT scoped.*,
        EXISTS(SELECT 1 FROM outcome_evidence e WHERE e.action_id=scoped.action_id AND e.strength='transport_only') ambiguous
        FROM scoped)
      SELECT count(*)::int total,
       coalesce(jsonb_object_agg(effect_state,state_count) FILTER(WHERE effect_state IS NOT NULL),'{}') states,
       coalesce(jsonb_object_agg(primary_directive,decision_count) FILTER(WHERE primary_directive IS NOT NULL),'{}') decisions,
       coalesce(jsonb_object_agg(coalesce(provider,'internal'),provider_count),'{}') providers,
       count(*) FILTER(WHERE ambiguous AND retry_disposition='forbidden')::int unsafe_retries_prevented,
       count(*) FILTER(WHERE ambiguous AND effect_state IN('verified','satisfied_unattributed','not_applied'))::int ambiguous_reconciled
      FROM (SELECT *,count(*) OVER(PARTITION BY effect_state) state_count,count(*) OVER(PARTITION BY primary_directive) decision_count,count(*) OVER(PARTITION BY provider) provider_count FROM marked) x`, params);
    const recent = await this.listActions(scope, { limit: 8 });
    return { ...(result.rows[0] ?? { total: 0, states: {}, decisions: {} }), recent };
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
    const ref=bounded(credentialRef,300,"credential reference"); if (!/^(?:env|vault|secret-manager):[A-Za-z0-9_./:-]{3,280}$/.test(ref)) throw new Error("Integration requires an opaque credential reference");
    const result=await this.db.query(`INSERT INTO nyst_integrations(integration_id,environment_id,project_id,organization_id,provider,credential_ref,configured)
      VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(environment_id,provider) DO UPDATE SET credential_ref=excluded.credential_ref,configured=true,last_verified_at=NULL
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

  async issueContinuationLease(scope: TenantScope, actionId: string, resolutionId: string, resolutionSequence: number, evidenceSequence: number): Promise<{ lease: string; expires_at: string }> {
    const lease = `nyst_lease_${randomBytes(32).toString("base64url")}`; const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const result = await this.db.query(`INSERT INTO nyst_continuation_leases(lease_hash,action_id,resolution_id,organization_id,resolution_sequence,evidence_sequence,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7 FROM nyst_action_scopes s JOIN outcome_runtime rt USING(action_id)
      JOIN outcome_resolutions r ON r.action_id=s.action_id AND r.resolution_id=$3
      WHERE s.action_id=$2 AND s.organization_id=$4 AND s.project_id=$8 AND s.environment_id=$9
        AND rt.resolution_sequence=$5 AND rt.evidence_sequence=$6 AND r.continuation_disposition='allowed'
      RETURNING lease_hash`, [digest(lease), actionId, resolutionId, scope.organization_id, resolutionSequence, evidenceSequence, expiresAt, scope.project_id, scope.environment_id]);
    if (!result.rows.length) throw new Error("Continuation authorization became stale before lease issuance");
    return { lease, expires_at: expiresAt };
  }

  async consumeContinuationLease(scope: TenantScope, lease: string): Promise<{ action_id: string; resolution_id: string } | null> {
    if (!/^nyst_lease_[A-Za-z0-9_-]{40,100}$/.test(lease)) return null;
    const result = await this.db.query(`UPDATE nyst_continuation_leases l SET consumed_at=now()
      FROM nyst_action_scopes s,outcome_runtime rt,outcome_resolutions r
      WHERE l.lease_hash=$1 AND l.consumed_at IS NULL AND l.expires_at>now()
        AND s.action_id=l.action_id AND s.organization_id=$2 AND s.project_id=$3 AND s.environment_id=$4
        AND rt.action_id=l.action_id AND rt.resolution_sequence=l.resolution_sequence AND rt.evidence_sequence=l.evidence_sequence
        AND r.resolution_id=l.resolution_id AND r.action_id=l.action_id AND r.continuation_disposition='allowed'
      RETURNING l.action_id,l.resolution_id`, [digest(lease), scope.organization_id, scope.project_id, scope.environment_id]);
    const row = result.rows[0]; return row ? { action_id: String(row.action_id), resolution_id: String(row.resolution_id) } : null;
  }

  async environmentControl(scope: TenantScope): Promise<{ mode: EnvironmentMode; is_demo: boolean; onboarding_stage: number }> {
    const result = await this.db.query(`SELECT mode,is_demo,onboarding_stage FROM nyst_environments WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3`, [scope.environment_id, scope.project_id, scope.organization_id]);
    const row = result.rows[0]; if (!row) throw new Error("Resource belongs to a different tenant scope");
    return { mode: row.mode === "shadow" ? "shadow" : "enforced", is_demo: row.is_demo === true, onboarding_stage: Number(row.onboarding_stage ?? 0) };
  }

  async setEnvironmentMode(scope: TenantScope, userId: string, mode: EnvironmentMode, reason: string): Promise<{ mode: EnvironmentMode }> {
    if (!['shadow','enforced'].includes(mode)) throw new Error("Unsupported environment mode");
    const result = await this.db.query(`WITH changed AS (
      UPDATE nyst_environments SET mode=$4 WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND mode<>$4
      RETURNING mode AS new_mode,(SELECT mode FROM nyst_environments WHERE environment_id=$1) AS previous_mode
    ), audit AS (
      INSERT INTO nyst_environment_mode_audit(audit_id,environment_id,project_id,organization_id,previous_mode,new_mode,changed_by,reason)
      SELECT $5,$1,$2,$3,CASE WHEN $4='shadow' THEN 'enforced' ELSE 'shadow' END,$4,$6,$7 FROM changed
    ) SELECT mode FROM nyst_environments WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3`,
      [scope.environment_id, scope.project_id, scope.organization_id, mode, randomUUID(), userId, bounded(reason, 500, "mode change reason")]);
    if (!result.rows.length) throw new Error("Resource belongs to a different tenant scope");
    return { mode: result.rows[0]?.mode === "shadow" ? "shadow" : "enforced" };
  }

  async currentPolicy(scope: TenantScope, effectName?: string): Promise<ConservativePolicy> {
    const result = await this.db.query(`SELECT policy_version_id,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds
      FROM nyst_policy_versions WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND (effect_name=$4 OR effect_name IS NULL)
      ORDER BY (effect_name IS NOT NULL) DESC,version DESC LIMIT 1`, [scope.environment_id, scope.project_id, scope.organization_id, effectName ?? null]);
    const row = result.rows[0]; if (!row) throw new Error("No policy is configured for this environment");
    return { policy_version_id: String(row.policy_version_id), execution_mode: row.execution_mode === "approval_required" ? "approval_required" : "automatic", retry_mode: "never", auto_continuation: row.auto_continuation === true, auto_compensation: row.auto_compensation === true, reconcile_timeout_seconds: Number(row.reconcile_timeout_seconds) };
  }

  async policyHistory(scope: TenantScope): Promise<Record<string, unknown>[]> {
    await this.requireTenantScope(scope);
    return (await this.db.query(`SELECT policy_version_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_at
      FROM nyst_policy_versions WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 ORDER BY effect_name NULLS FIRST,version DESC`, [scope.environment_id, scope.project_id, scope.organization_id])).rows;
  }

  async createPolicyVersion(scope: TenantScope, userId: string, input: { effect_name: string | null; execution_mode: "automatic" | "approval_required"; auto_continuation: boolean; auto_compensation: boolean; reconcile_timeout_seconds: number }): Promise<Record<string, unknown>> {
    await this.requireTenantScope(scope);
    if (!['automatic','approval_required'].includes(input.execution_mode) || !Number.isInteger(input.reconcile_timeout_seconds) || input.reconcile_timeout_seconds < 30 || input.reconcile_timeout_seconds > 86400) throw new Error("Invalid conservative policy");
    const id = randomUUID();
    const result = await this.db.query(`INSERT INTO nyst_policy_versions(policy_version_id,environment_id,project_id,organization_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds,created_by)
      SELECT $1,$2,$3,$4,$5,coalesce(max(version),0)+1,$6,'never',$7,$8,$9,$10 FROM nyst_policy_versions
      WHERE environment_id=$2 AND (effect_name IS NOT DISTINCT FROM $5)
      RETURNING policy_version_id,effect_name,version,execution_mode,retry_mode,auto_continuation,auto_compensation,reconcile_timeout_seconds`,
      [id, scope.environment_id, scope.project_id, scope.organization_id, input.effect_name, input.execution_mode, input.auto_continuation, input.auto_compensation, input.reconcile_timeout_seconds, userId]);
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

  async recordShadowEvaluation(scope: TenantScope, effectName: string, businessKey: string, observation: ShadowObservation): Promise<Record<string, unknown>> {
    const control = await this.environmentControl(scope); if (control.mode !== "shadow") throw new Error("Shadow evaluations require a Shadow environment");
    const configured=await this.db.query(`SELECT enabled FROM nyst_environment_effect_specs WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND effect_name=$4`,[scope.environment_id,scope.project_id,scope.organization_id,effectName]);
    if(configured.rows[0]?.enabled!==true)throw new Error("Shadow EffectSpec is unavailable or disabled for this environment");
    const assessment = assessEffectShadow(effectName,observation); const id = randomUUID();
    const result = await this.db.query(`INSERT INTO nyst_shadow_evaluations(shadow_evaluation_id,environment_id,project_id,organization_id,effect_name,business_key,observation,observed_ambiguous,attempted_retry,attempted_continuation,retry_would_have_been_blocked,continuation_would_have_been_blocked,assessment)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(environment_id,effect_name,business_key) DO UPDATE SET observation=excluded.observation,observed_ambiguous=excluded.observed_ambiguous,attempted_retry=excluded.attempted_retry,attempted_continuation=excluded.attempted_continuation,retry_would_have_been_blocked=excluded.retry_would_have_been_blocked,continuation_would_have_been_blocked=excluded.continuation_would_have_been_blocked,assessment=excluded.assessment
      WHERE nyst_shadow_evaluations.project_id=excluded.project_id AND nyst_shadow_evaluations.organization_id=excluded.organization_id
      RETURNING shadow_evaluation_id,effect_name,business_key,assessment,created_at`, [id, scope.environment_id, scope.project_id, scope.organization_id, bounded(effectName,200,"effect"), bounded(businessKey,463,"business key"), observation, assessment.observed_ambiguous, observation.attempted_retry, observation.attempted_continuation, assessment.retry_would_have_been_blocked, assessment.continuation_would_have_been_blocked, assessment]);
    if (!result.rows.length) throw new Error("Shadow record belongs to a different tenant scope"); return result.rows[0]!;
  }

  async impactMetrics(scope: TenantScope): Promise<Record<string, unknown>> {
    const control = await this.environmentControl(scope);
    const result = await this.db.query(`WITH scoped_actions AS (
        SELECT s.action_id,a.effect_name,coalesce(a.dispatch_plan->>'provider',split_part(a.effect_name,'.',1)) provider,a.created_at
        FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) JOIN nyst_environments env USING(environment_id,project_id,organization_id)
        WHERE s.environment_id=$1 AND s.project_id=$2 AND s.organization_id=$3 AND env.is_demo=false
      ), active_evidence AS (
        SELECT e.* FROM outcome_evidence e JOIN scoped_actions s USING(action_id)
        WHERE NOT EXISTS(SELECT 1 FROM outcome_evidence correction WHERE correction.action_id=e.action_id AND correction.supersedes_evidence_id=e.evidence_id)
      ), ambiguous AS (
        SELECT DISTINCT action_id FROM active_evidence WHERE kind='transport_error' OR strength='transport_only'
      ), latest AS (
        SELECT DISTINCT ON(t.action_id) t.* FROM nyst_resolution_transitions t JOIN scoped_actions s USING(action_id)
        ORDER BY t.action_id,t.resolution_sequence DESC,t.transition_id DESC
      ), durations AS (
        SELECT extract(epoch FROM (t.occurred_at-s.created_at))*1000 duration_ms FROM latest t JOIN scoped_actions s USING(action_id)
        WHERE t.effect_state IN('verified','not_applied','compensated','satisfied_unattributed')
      ) SELECT
        (SELECT count(*)::int FROM scoped_actions) consequential_actions,
        (SELECT count(*)::int FROM ambiguous) ambiguous_executions,
        (SELECT count(DISTINCT action_id)::int FROM nyst_control_events WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND event_kind='retry_blocked') unsafe_retries_prevented_enforced,
        (SELECT count(DISTINCT action_id)::int FROM nyst_control_events WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND event_kind='continuation_blocked') unsafe_continuations_prevented_enforced,
        (SELECT count(*)::int FROM nyst_shadow_evaluations WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND retry_would_have_been_blocked) unsafe_retries_detected_shadow,
        (SELECT count(DISTINCT action_id)::int FROM nyst_control_events WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND event_kind='automatic_recovery_completed') auto_resolved,
        (SELECT count(DISTINCT action_id)::int FROM nyst_human_reviews WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3) human_escalations,
        (SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms) FROM durations) median_reconciliation_duration,
        (SELECT coalesce(jsonb_object_agg(key,count),'{}') FROM (SELECT provider key,count(*)::int count FROM scoped_actions GROUP BY provider) q) provider_breakdown,
        (SELECT coalesce(jsonb_object_agg(key,count),'{}') FROM (SELECT effect_name key,count(*)::int count FROM scoped_actions GROUP BY effect_name) q) effect_breakdown`, [scope.environment_id, scope.project_id, scope.organization_id]);
    const recent=await this.listActions(scope,{limit:8});
    const metrics=result.rows[0]??{};return { mode: control.mode, ...metrics,unsafe_retry_detected_shadow:metrics.unsafe_retries_detected_shadow??0, recent, metric_definitions: {
      consequential_actions:"distinct durable non-demo logical actions", ambiguous_executions:"distinct actions with active transport_error or transport_only evidence",
      unsafe_retries_prevented_enforced:"distinct actions with persisted enforced retry_blocked control events", unsafe_retries_detected_shadow:"distinct Shadow records that report would-have-blocked retry; never prevention",
      unsafe_continuations_prevented_enforced:"distinct actions with persisted enforced continuation_blocked events", auto_resolved:"distinct actions with completed automatic recovery control events",
      human_escalations:"distinct actions with durable human review", median_reconciliation_duration:"median milliseconds from intent creation to current terminal resolution"
    } };
  }

  async testIntegration(scope:TenantScope,provider:string,env:NodeJS.ProcessEnv=process.env):Promise<Record<string,unknown>>{
    if(!["github","okta","stripe"].includes(provider))throw new Error("Unsupported integration provider");
    const result=await this.db.query(`SELECT integration_id,credential_ref,configured FROM nyst_integrations WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND provider=$4`,[scope.environment_id,scope.project_id,scope.organization_id,provider]);
    const row=result.rows[0];if(!row||row.configured!==true)throw new Error("Integration is not configured");
    const expected=EXPECTED_PROVIDER_REFS[provider];if(row.credential_ref!==expected)throw new Error("Credential reference does not match the supported provider topology");
    const variable=String(expected).slice(4);const available=typeof env[variable]==="string"&&env[variable]!.length>0;
    return {provider,configured:true,credential_reference_valid:true,credential_available_to_process:available,provider_mutation_performed:false,read_only_preflight_performed:false,status:available?"credential_ready":"credential_unavailable"};
  }

  async markIntegrationVerified(scope:TenantScope,provider:string):Promise<void>{const result=await this.db.query(`UPDATE nyst_integrations SET last_verified_at=now() WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 AND provider=$4 AND configured RETURNING integration_id`,[scope.environment_id,scope.project_id,scope.organization_id,provider]);if(!result.rows.length)throw new Error("Integration is unavailable in this tenant scope");}

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
    return result.rows.length===1;
  }

  async escalateOverdueReconciliations(nowIso=new Date().toISOString()):Promise<number>{
    const overdue=await this.db.query(`SELECT s.action_id,s.environment_id,s.project_id,s.organization_id,r.resolution_id
      FROM nyst_action_scopes s JOIN nyst_action_policy_bindings b USING(action_id)
      JOIN LATERAL(SELECT resolution_id,effect_state,primary_directive FROM outcome_resolutions WHERE action_id=s.action_id ORDER BY resolution_sequence DESC NULLS LAST,resolution_id DESC LIMIT 1) r ON true
      WHERE b.reconcile_deadline_at<=$1 AND r.effect_state IN('pending','unprovable') AND NOT EXISTS(SELECT 1 FROM nyst_human_reviews h WHERE h.action_id=s.action_id)`,[nowIso]);
    let count=0;for(const row of overdue.rows){const reviewId=randomUUID();const inserted=await this.db.query(`WITH review AS (
        INSERT INTO nyst_human_reviews(human_review_id,action_id,environment_id,project_id,organization_id,status,reason)
        VALUES($1,$2,$3,$4,$5,'open','Policy reconciliation deadline expired; external truth is unchanged and human review is required.') ON CONFLICT(action_id) DO NOTHING RETURNING *
      ), stopped AS (DELETE FROM nyst_reconciliation_jobs WHERE action_id=$2)
      SELECT human_review_id FROM review`,[reviewId,row.action_id,row.environment_id,row.project_id,row.organization_id]);if(inserted.rows.length){count++;await this.queueLifecycleWebhookByAction(String(row.action_id),"human_review.required");}}
    return count;
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
      SELECT $4::uuid,w.webhook_endpoint_id,c.action_id,c.resolution_id,c.resolution_sequence,c.evidence_sequence,'webhook.test',jsonb_build_object('event_schema_version',1,'event_id',$4::text,'event_type','webhook.test','timestamp',now(),'organization_id',$3,'project_id',$2,'environment_id',$1,'action_id',c.action_id,'effect_name',c.action_effect_name,'spec_version',c.action_spec_version,'resolution_id',c.resolution_id,'resolution_sequence',c.resolution_sequence,'evidence_sequence',c.evidence_sequence,'effect_state',c.effect_state,'control',jsonb_build_object('primary',c.primary_directive,'retry',c.retry_disposition,'continuation',c.continuation_disposition,'recovery',c.recovery_disposition),'receipt_ref','/v1/actions/'||c.action_id||'/receipt'),now(),1 FROM current c JOIN nyst_webhook_endpoints w ON w.environment_id=$1 AND w.project_id=$2 AND w.organization_id=$3 AND w.enabled RETURNING webhook_event_id,event_type,occurred_at`,[scope.environment_id,scope.project_id,scope.organization_id,eventId]);if(!result.rows.length)throw new Error("Webhook test requires an enabled endpoint and at least one resolved action");return result.rows[0]!;}

  async queueDecisionWebhook(scope: TenantScope, actionId: string, resolution: Record<string, unknown>, eventType: string): Promise<void> {
    const resolutionId=String(resolution.resolution_id??""); const runtime=resolution.runtime&&typeof resolution.runtime==='object'?resolution.runtime as Record<string,unknown>:{};
    if(!/^[0-9a-f-]{36}$/i.test(resolutionId)||!['effect.resolved','continuation.authorized','human_review.required','compensation.completed'].includes(eventType))return;
    const eventId=randomUUID();
    await this.db.query(`INSERT INTO nyst_webhook_events(webhook_event_id,webhook_endpoint_id,action_id,resolution_id,resolution_sequence,evidence_sequence,event_type,payload,occurred_at)
      SELECT $1,w.webhook_endpoint_id,$2,$3,$4,$5,$6,$7,now() FROM nyst_webhook_endpoints w JOIN nyst_action_scopes s ON s.action_id=$2 AND s.environment_id=w.environment_id AND s.project_id=w.project_id AND s.organization_id=w.organization_id
      WHERE w.environment_id=$8 AND w.enabled=true ON CONFLICT(webhook_endpoint_id,action_id,resolution_id,event_type) DO NOTHING`,[eventId,actionId,resolutionId,Number(runtime.resolution_sequence??1),Number(runtime.evidence_sequence??0),eventType,{event_id:eventId,event_type:eventType,action_id:actionId,resolution_id:resolutionId,resolution_sequence:Number(runtime.resolution_sequence??1),evidence_sequence:Number(runtime.evidence_sequence??0),environment_id:scope.environment_id},scope.environment_id]);
  }

  async authorizeRecovery(scope:TenantScope,actionId:string,resolutionId:string,operation:"authorized_continuation"|"supported_compensation"):Promise<Record<string,unknown>>{
    const id=randomUUID();const operationKey=`recovery:${actionId}:${resolutionId}:${operation}`;const result=await this.db.query(`INSERT INTO nyst_recovery_executions(recovery_execution_id,action_id,resolution_id,policy_version_id,operation,status,resolution_sequence,evidence_sequence,downstream_operation_key)
      SELECT $1,s.action_id,r.resolution_id,b.policy_version_id,$5,'authorized',r.resolution_sequence,rt.evidence_sequence,$8 FROM nyst_action_scopes s JOIN nyst_action_policy_bindings b USING(action_id) JOIN nyst_policy_versions p USING(policy_version_id) JOIN outcome_resolutions r ON r.action_id=s.action_id AND r.resolution_id=$2 JOIN outcome_runtime rt ON rt.action_id=s.action_id AND rt.resolution_sequence=r.resolution_sequence
      WHERE s.action_id=$3 AND s.environment_id=$4 AND s.project_id=$6 AND s.organization_id=$7 AND (($5='authorized_continuation' AND p.auto_continuation AND r.continuation_disposition='allowed') OR ($5='supported_compensation' AND p.auto_compensation AND r.primary_directive='compensate'))
      ON CONFLICT(action_id,resolution_id,operation) DO UPDATE SET action_id=excluded.action_id RETURNING recovery_execution_id,action_id,resolution_id,operation,status,created_at,downstream_operation_key`,[id,resolutionId,actionId,scope.environment_id,operation,scope.project_id,scope.organization_id,operationKey]);
    if(!result.rows.length)throw new Error("Runtime resolution and bound conservative policy do not authorize this recovery");return result.rows[0]!;
  }

  async claimRecovery():Promise<Record<string,unknown>|null>{const token=randomUUID();const result=await this.db.query(`WITH candidate AS (
      SELECT r.recovery_execution_id FROM nyst_recovery_executions r JOIN outcome_runtime rt ON rt.action_id=r.action_id JOIN outcome_resolutions resolution ON resolution.resolution_id=r.resolution_id AND resolution.action_id=r.action_id JOIN nyst_action_policy_bindings b ON b.action_id=r.action_id JOIN nyst_policy_versions p ON p.policy_version_id=b.policy_version_id
      WHERE r.status='authorized' AND r.claim_token IS NULL AND rt.resolution_sequence=r.resolution_sequence AND rt.evidence_sequence=r.evidence_sequence AND b.policy_version_id=r.policy_version_id AND b.reconcile_deadline_at>now()
        AND ((r.operation='authorized_continuation' AND p.auto_continuation AND resolution.continuation_disposition='allowed') OR (r.operation='supported_compensation' AND p.auto_compensation AND resolution.primary_directive='compensate'))
      ORDER BY r.created_at,r.recovery_execution_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE nyst_recovery_executions r SET status='executing',claim_token=$1,claimed_until=now()+interval '30 seconds',attempted_at=now() FROM candidate c,nyst_action_scopes s,outcome_actions a WHERE r.recovery_execution_id=c.recovery_execution_id AND s.action_id=r.action_id AND a.action_id=r.action_id
      RETURNING r.recovery_execution_id,r.action_id,r.resolution_id,r.operation,r.claim_token,r.downstream_operation_key,r.resolution_sequence,r.evidence_sequence,s.environment_id,s.project_id,s.organization_id,a.effect_name,a.spec_version`,[token]);return result.rows[0]??null;}

  async completeRecovery(recoveryId:string,claimToken:string,successful:boolean,resultValue:Record<string,unknown>={}):Promise<boolean>{const result=await this.db.query(`UPDATE nyst_recovery_executions SET status=$3,completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END,claim_token=NULL,claimed_until=NULL,result=$4 WHERE recovery_execution_id=$1 AND claim_token=$2 AND status='executing' RETURNING recovery_execution_id,action_id`,[recoveryId,claimToken,successful?'completed':'failed',resultValue]);if(successful&&result.rows[0]){const actionId=String(result.rows[0].action_id);await this.db.query(`INSERT INTO nyst_control_events(control_event_id,transition_id,action_id,environment_id,project_id,organization_id,event_kind)
      SELECT $1,t.transition_id,t.action_id,t.environment_id,t.project_id,t.organization_id,'automatic_recovery_completed' FROM nyst_resolution_transitions t WHERE t.action_id=$2 ORDER BY t.resolution_sequence DESC LIMIT 1 ON CONFLICT DO NOTHING`,[randomUUID(),actionId]);await this.queueLifecycleWebhookByAction(actionId,"recovery.completed");}return result.rows.length===1;}

  async runFailureLab(scope: TenantScope, userId: string, scenario: FailureScenario, effectName: string, seed: number): Promise<Record<string, unknown>> {
    const control=await this.environmentControl(scope); if(!control.is_demo&&control.mode!=="shadow")throw new Error("Failure Lab is isolated to Demo or Shadow environments");
    const result=await runFailureLabEngine(scenario,effectName,seed); const id=randomUUID(); await this.db.query(`INSERT INTO nyst_failure_lab_runs(failure_lab_run_id,environment_id,project_id,organization_id,scenario,effect_name,seed,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,scope.environment_id,scope.project_id,scope.organization_id,scenario,effectName,seed,result,userId]); return {failure_lab_run_id:id,...result};
  }

  async failureLabRuns(scope: TenantScope): Promise<Record<string, unknown>[]> { await this.requireTenantScope(scope); return (await this.db.query(`SELECT failure_lab_run_id,scenario,effect_name,seed,result,created_at FROM nyst_failure_lab_runs WHERE environment_id=$1 AND project_id=$2 AND organization_id=$3 ORDER BY created_at DESC LIMIT 20`,[scope.environment_id,scope.project_id,scope.organization_id])).rows; }

  async openHumanReview(scope: TenantScope, actionId: string, reason: string): Promise<Record<string, unknown>> {
    const result=await this.db.query(`INSERT INTO nyst_human_reviews(human_review_id,action_id,environment_id,project_id,organization_id,status,reason)
      SELECT $1,s.action_id,s.environment_id,s.project_id,s.organization_id,'open',$6 FROM nyst_action_scopes s JOIN LATERAL(SELECT primary_directive FROM outcome_resolutions WHERE action_id=s.action_id ORDER BY resolution_sequence DESC LIMIT 1) r ON true
      WHERE s.action_id=$2 AND s.environment_id=$3 AND s.project_id=$4 AND s.organization_id=$5 AND r.primary_directive IN ('hold','escalate') ON CONFLICT(action_id) DO UPDATE SET reason=excluded.reason RETURNING human_review_id,action_id,status,reason,opened_at`,[randomUUID(),actionId,scope.environment_id,scope.project_id,scope.organization_id,bounded(reason,1000,"review reason")]);
    if(!result.rows.length)throw new Error("Only held or escalated actions may enter human review");await this.queueLifecycleWebhookByAction(actionId,"human_review.required"); return result.rows[0]!;
  }

  async humanReviews(scope: TenantScope): Promise<Record<string, unknown>[]> { return (await this.db.query(`SELECT h.human_review_id,h.action_id,h.status,h.reason,h.opened_at,h.reviewed_at,a.effect_name,s.display_business_key FROM nyst_human_reviews h JOIN nyst_action_scopes s USING(action_id) JOIN outcome_actions a USING(action_id) WHERE h.environment_id=$1 AND h.project_id=$2 AND h.organization_id=$3 ORDER BY h.opened_at DESC`,[scope.environment_id,scope.project_id,scope.organization_id])).rows; }

  async updateHumanReview(scope: TenantScope,userId:string,reviewId:string,operation:"acknowledge"|"request_reobservation"):Promise<Record<string,unknown>>{const status=operation==='acknowledge'?'acknowledged':'reobservation_requested';const jobId=randomUUID();const result=await this.db.query(`WITH changed AS (
      UPDATE nyst_human_reviews SET status=$6,reviewed_by=$5,reviewed_at=now() WHERE human_review_id=$1 AND environment_id=$2 AND project_id=$3 AND organization_id=$4 AND status='open' RETURNING *
    ), job AS (
      INSERT INTO nyst_reobservation_jobs(reobservation_job_id,human_review_id,action_id,environment_id,project_id,organization_id)
      SELECT $7,human_review_id,action_id,environment_id,project_id,organization_id FROM changed WHERE $8='request_reobservation' ON CONFLICT(human_review_id) DO NOTHING
    ) SELECT human_review_id,action_id,status,reviewed_at FROM changed`,[reviewId,scope.environment_id,scope.project_id,scope.organization_id,userId,status,jobId,operation]);if(!result.rows.length)throw new Error("Review is unavailable or already handled");return result.rows[0]!;}

  async claimReobservation():Promise<Record<string,unknown>|null>{const token=randomUUID();const result=await this.db.query(`WITH candidate AS (SELECT reobservation_job_id FROM nyst_reobservation_jobs WHERE status='requested' ORDER BY requested_at,reobservation_job_id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE nyst_reobservation_jobs j SET status='executing',claim_token=$1,claimed_until=now()+interval '30 seconds' FROM candidate c WHERE j.reobservation_job_id=c.reobservation_job_id RETURNING j.reobservation_job_id,j.action_id,j.claim_token`,[token]);return result.rows[0]??null;}
  async completeReobservation(jobId:string,claimToken:string,successful:boolean):Promise<boolean>{const result=await this.db.query(`UPDATE nyst_reobservation_jobs SET status=$3,completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END,claim_token=NULL,claimed_until=NULL WHERE reobservation_job_id=$1 AND claim_token=$2 AND status='executing' RETURNING reobservation_job_id`,[jobId,claimToken,successful?'completed':'failed']);return result.rows.length===1;}

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
