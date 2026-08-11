import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyResolution } from "../src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { ProductRepository, digest, type ProductDb } from "../src/product/productRepository.js";
import { InMemoryOperationalMetrics, NystReconciliationScheduler } from "../src/product/scheduler.js";
import { buildProductServer } from "../src/product/server.js";
import type { TenantScope } from "../src/product/types.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { makeRuntimeHarness, runtimeInput } from "./runtimeHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Gate 8 product API, auth, tenant isolation, scheduler, and continuation leases", { skip: databaseUrl ? false : "DATABASE_URL not set — no database to test against" }, () => {
  let pool: (ProductDb & { end(): Promise<void> }); let store: Awaited<ReturnType<typeof createPostgresStore>>; let repository: ProductRepository;
  let tenantA: TenantScope & { user_id: string }; let tenantB: TenantScope & { user_id: string };
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (options: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! }); repository = new ProductRepository(pool); store = await createPostgresStore(databaseUrl!);
    tenantA = await repository.createBootstrap({ organization: "Alpha", organization_slug: `alpha-${suffix}`, project: "Control", project_slug: "control", environment: "Test", environment_slug: "test", email: `owner-${suffix}@alpha.test`, display_name: "Alpha Owner", password: "Correct Horse Battery Staple 47!" });
    tenantB = await repository.createBootstrap({ organization: "Beta", organization_slug: `beta-${suffix}`, project: "Control", project_slug: "control", environment: "Test", environment_slug: "test", email: `owner-${suffix}@beta.test`, display_name: "Beta Owner", password: "Correct Horse Battery Staple 48!" });
  });
  after(async () => { await store.close(); await pool.end(); });

  it("uses mainstream password hashing, opaque sessions, and hash-only revocable API keys", async () => {
    assert.equal(await repository.login(`alpha-${suffix}`, `owner-${suffix}@alpha.test`, "wrong"), null);
    const login = await repository.login(`alpha-${suffix}`, `owner-${suffix}@alpha.test`, "Correct Horse Battery Staple 47!"); assert(login);
    assert.equal((await repository.authenticateSession(login.session))?.organization_id, tenantA.organization_id);
    const key = await repository.createApiKey(tenantA, "SDK", ["actions:read", "actions:write", "receipts:read", "integrations:read"]);
    assert.equal((await repository.authenticateApiKey(key.key))?.organization_id, tenantA.organization_id);
    const persisted = await pool.query(`SELECT secret_hash,prefix FROM nyst_api_keys WHERE api_key_id=$1`, [key.api_key_id]);
    assert.equal(persisted.rows[0]?.secret_hash, digest(key.key)); assert.equal(JSON.stringify(persisted.rows).includes(key.key), false);
    assert.equal(await repository.revokeApiKey(tenantB, key.api_key_id), false); assert.equal((await repository.authenticateApiKey(key.key))?.organization_id, tenantA.organization_id, "cross-tenant revoke attempt must not revoke another tenant's key");
    assert.equal(await repository.revokeApiKey(tenantA, key.api_key_id), true); assert.equal(await repository.authenticateApiKey(key.key), null);
  });

  it("stores only tenant-scoped opaque integration references and rejects raw provider keys", async () => {
    const configured=await repository.configureIntegration(tenantA,"stripe","env:NYST_STRIPE_CREDENTIAL");assert.equal(configured.credential_ref,"env:NYST_STRIPE_CREDENTIAL");
    await assert.rejects(()=>repository.configureIntegration(tenantA,"stripe","sk_test_RAW_FORBIDDEN"),/reference/);assert.equal((await repository.integrations(tenantB)).length,0);
    await assert.rejects(()=>pool.query(`INSERT INTO nyst_integrations(integration_id,environment_id,project_id,organization_id,provider,credential_ref,configured) VALUES($1,$2,$3,$4,'github','github_pat_RAW_FORBIDDEN',true)`,[randomUUID(),tenantB.environment_id,tenantB.project_id,tenantB.organization_id]),/check constraint/i);
    await assert.rejects(()=>pool.query(`INSERT INTO nyst_integrations(integration_id,environment_id,project_id,organization_id,provider,credential_ref,configured) VALUES($1,$2,$3,$4,'okta','opaque-but-not-a-reference',true)`,[randomUUID(),tenantB.environment_id,tenantB.project_id,tenantB.organization_id]),/check constraint/i);
  });

  it("serves real runtime data and returns 404 for cross-org guessed action/evidence/receipt IDs", async () => {
    const harness = makeRuntimeHarness({}, store);
    const descriptor = { effect_name: harness.spec.effect_name, spec_version: harness.spec.schema_version, provider: "fake", supported_topology: "Deterministic product test only" };
    await repository.configureEffectSpec(tenantA, descriptor, true);
    const app = await buildProductServer({ repository, effect_specs: [descriptor],
      commit: async (request, principal) => harness.runtime.commit(request.effect, request.businessKey, request.input, EMPTY_CONTEXT, { establish_dispatch_eligibility: (action) => repository.scopeAction(principal, action.action_id, request.displayBusinessKey) }), verify_receipt: (value) => verifyResolution(harness.signer, value as never), runtime: harness.runtime });
    const loginA = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `alpha-${suffix}`, email: `owner-${suffix}@alpha.test`, password: "Correct Horse Battery Staple 47!" } });
    assert.equal(loginA.statusCode, 200); assert.match(String(loginA.headers["set-cookie"]), /HttpOnly/i); assert.match(String(loginA.headers["set-cookie"]), /SameSite=Strict/i); const cookieA = cookie(loginA.headers["set-cookie"]); const csrfA = loginA.json().csrf as string;
    const committed = await app.inject({ method: "POST", url: "/v1/actions", headers: { cookie: cookieA, "x-nyst-csrf": csrfA }, payload: { effect: harness.spec.effect_name, businessKey: "offboard:alice", input: runtimeInput("definitely_applied") } });
    assert.equal(committed.statusCode, 200); const actionId = committed.json().action.action_id as string;
    const loginB = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `beta-${suffix}`, email: `owner-${suffix}@beta.test`, password: "Correct Horse Battery Staple 48!" } });
    const cookieB = cookie(loginB.headers["set-cookie"]);
    for (const path of [`/v1/actions/${actionId}`, `/v1/actions/${actionId}/evidence`, `/v1/actions/${actionId}/resolutions`, `/v1/actions/${actionId}/receipt`]) assert.equal((await app.inject({ method: "GET", url: path, headers: { cookie: cookieB } })).statusCode, 404);
    const listA = await app.inject({ method: "GET", url: "/v1/actions", headers: { cookie: cookieA } }); assert.equal(listA.statusCode, 200); assert.equal(listA.json()[0].business_key, "offboard:alice");
    const receipt = await app.inject({ method: "GET", url: `/v1/actions/${actionId}/receipt`, headers: { cookie: cookieA } }); assert.equal(receipt.statusCode, 200); assert.equal(receipt.json().signature_valid, true);
    const receiptHtml=await app.inject({method:"GET",url:`/receipts/${actionId}`,headers:{cookie:cookieA}});assert.equal(receiptHtml.statusCode,200);assert.match(receiptHtml.body,/Signature verification/);assert.match(receiptHtml.body,/VALID/);assert.match(receiptHtml.body,/Export JSON/);
    const exported=await app.inject({method:"GET",url:`/exports/${actionId}`,headers:{cookie:cookieA}});assert.equal(exported.statusCode,200);assert.equal(exported.json().signature_valid,true);assert.match(String(exported.headers["content-disposition"]),/attachment/);
    const detailHtml = await app.inject({ method: "GET", url: `/actions/${actionId}`, headers: { cookie: cookieA } }); assert.equal(detailHtml.statusCode, 200); assert.match(detailHtml.body, /Intent/); assert.match(detailHtml.body, /Evidence timeline/); assert.doesNotMatch(detailHtml.body, /sk_test_|github_pat_|Bearer\s/);
    assert.equal((await app.inject({ method: "POST", url: "/v1/actions", headers: { cookie: cookieA }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: "/v1/actions?effect=' OR 1=1 --", headers: { cookie: cookieB } })).json().length, 0);
    assert.equal((await app.inject({ method: "GET", url: "/v1/actions/not-a-uuid", headers: { cookie: cookieA } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/v1/actions?limit=NaN", headers: { cookie: cookieA } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/v1/actions?since=not-a-date", headers: { cookie: cookieA } })).statusCode, 400);
    const oversized=await app.inject({method:"POST",url:"/v1/actions",headers:{cookie:cookieA,"x-nyst-csrf":csrfA,"content-type":"application/json"},payload:JSON.stringify({effect:harness.spec.effect_name,businessKey:"large",input:{padding:"x".repeat(70_000)}})});assert.equal(oversized.statusCode,413);
    const readOnly=await repository.createApiKey(tenantA,"read-only",["actions:read"]);const readAuth={authorization:`Nyst ${readOnly.key}`};assert.equal((await app.inject({method:"GET",url:"/v1/actions",headers:readAuth})).statusCode,200);assert.equal((await app.inject({method:"POST",url:"/v1/actions",headers:readAuth,payload:{effect:harness.spec.effect_name,businessKey:"denied",input:runtimeInput("definitely_applied")}})).statusCode,403);assert.equal((await app.inject({method:"GET",url:"/v1/integrations",headers:readAuth})).statusCode,403);
    const receiptOnly=await repository.createApiKey(tenantA,"receipt-only",["receipts:read"]);const receiptAuth={authorization:`Nyst ${receiptOnly.key}`};assert.equal((await app.inject({method:"GET",url:"/v1/actions",headers:receiptAuth})).statusCode,403);assert.equal((await app.inject({method:"GET",url:`/v1/actions/${actionId}/receipt`,headers:receiptAuth})).statusCode,200);assert.equal((await app.inject({method:"GET",url:"/",headers:receiptAuth})).statusCode,403);
    const badScope=await app.inject({method:"POST",url:"/v1/api-keys",headers:{cookie:cookieA,"x-nyst-csrf":csrfA},payload:{name:"bad",scopes:["admin:all"]}});assert.equal(badScope.statusCode,400);
    assert.equal((await app.inject({method:"GET",url:"/demo",headers:{cookie:cookieA}})).statusCode,200);
    assert.ok(typeof listA.headers["x-nyst-request-id"]==="string");
    await app.close();
  });

  it("serializes multiple scheduler workers and never turns reconciliation into redispatch", async () => {
    const harness = makeRuntimeHarness({}, store); const result = await harness.runtime.commit(harness.spec.effect_name, `${tenantA.environment_id}:scheduled-${suffix}`, runtimeInput("eventual_consistency"), EMPTY_CONTEXT, { establish_dispatch_eligibility: (action) => repository.scopeAction(tenantA, action.action_id, `scheduled-${suffix}`) });
    assert.equal(result.resolution.effect.state, "pending"); const metrics = new InMemoryOperationalMetrics();let entered!:()=>void;let release!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve});const releasePromise=new Promise<void>(resolve=>{release=resolve});const blockedRuntime={reconcile:async(actionId:string)=>{entered();await releasePromise;return harness.runtime.reconcile(actionId);}};const a = new NystReconciliationScheduler(pool, blockedRuntime, metrics); const b = new NystReconciliationScheduler(pool, blockedRuntime, metrics);
    await a.sync(); await pool.query(`UPDATE nyst_reconciliation_jobs SET due_at=CASE WHEN action_id=$1 THEN now()-interval '1 second' ELSE now()+interval '1 hour' END`, [result.action.action_id]);
    const first=a.runOne();await enteredPromise;const second=await b.runOne();assert.equal(second,false,"a simultaneous worker cannot claim the live lease");release();assert.equal(await first,true);assert.equal(harness.provider.mutationCount(), 1);
    await pool.query(`UPDATE nyst_reconciliation_jobs SET due_at=now()-interval '1 second' WHERE action_id=$1`, [result.action.action_id]); await a.runOne(); assert.equal(harness.provider.mutationCount(), 1);
    assert.equal((metrics.snapshot().counters as Record<string,number>).scheduler_claims, 2);
  });

  it("drops stale terminal jobs and backs failures off without a mutation path", async () => {
    const harness=makeRuntimeHarness({},store);const complete=await harness.runtime.commit(harness.spec.effect_name,`${tenantA.environment_id}:terminal-${suffix}`,runtimeInput("definitely_applied",{repository_id:`terminal-${suffix}`}),EMPTY_CONTEXT,{establish_dispatch_eligibility:(action)=>repository.scopeAction(tenantA,action.action_id,`terminal-${suffix}`)});
    await pool.query(`UPDATE nyst_reconciliation_jobs SET due_at=now()+interval '1 hour'`);await pool.query(`INSERT INTO nyst_reconciliation_jobs(action_id,due_at) VALUES($1,now()-interval '1 second') ON CONFLICT(action_id) DO UPDATE SET due_at=excluded.due_at,claim_token=NULL,claimed_until=NULL`,[complete.action.action_id]);let calls=0;const metrics=new InMemoryOperationalMetrics();const scheduler=new NystReconciliationScheduler(pool,{async reconcile(){calls++;throw new Error("must not run");}},metrics);assert.equal(await scheduler.runOne(),true);assert.equal(calls,0);
    const pending=await harness.runtime.commit(harness.spec.effect_name,`${tenantA.environment_id}:backoff-${suffix}`,runtimeInput("eventual_consistency",{repository_id:`backoff-${suffix}`}),EMPTY_CONTEXT,{establish_dispatch_eligibility:(action)=>repository.scopeAction(tenantA,action.action_id,`backoff-${suffix}`)});await scheduler.sync();await pool.query(`UPDATE nyst_reconciliation_jobs SET due_at=CASE WHEN action_id=$1 THEN now()-interval '1 second' ELSE now()+interval '1 hour' END`,[pending.action.action_id]);const failing=new NystReconciliationScheduler(pool,{async reconcile(){throw new Error("injected");}},metrics);assert.equal(await failing.runOne(),true);const job=await pool.query(`SELECT claim_token,claimed_until,last_error_code,due_at,due_at>now() future FROM nyst_reconciliation_jobs WHERE action_id=$1`,[pending.action.action_id]);assert.equal(job.rows[0]?.claim_token,null);assert.equal(job.rows[0]?.last_error_code,"reconcile_failed");assert.equal(job.rows[0]?.future,true);const beforeSync=String(job.rows[0]?.due_at);await failing.sync();const afterSync=await pool.query(`SELECT due_at FROM nyst_reconciliation_jobs WHERE action_id=$1`,[pending.action.action_id]);assert.equal(String(afterSync.rows[0]?.due_at),beforeSync,"scheduler sync must not erase failure backoff");assert.equal(harness.provider.mutationCount(),2);
  });

  it("issues one-use 30-second continuation leases and rejects stale evidence or cross-tenant consumption", async () => {
    // v0.2.1 issued this lease from the runtime disposition alone. Automatic
    // continuation now additionally requires the action-bound policy to permit
    // it, so the policy must genuinely authorize it BEFORE the action is bound.
    await repository.createPolicyVersion(tenantA, tenantA.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 300 });
    const harness = makeRuntimeHarness({}, store); let resolution = (await harness.runtime.commit(harness.spec.effect_name, `${tenantA.environment_id}:lease-${suffix}`, runtimeInput("definitely_applied", { repository_id: `lease-${suffix}` }), EMPTY_CONTEXT, { establish_dispatch_eligibility: (action) => repository.scopeAction(tenantA, action.action_id, `lease-${suffix}`) })).resolution;
    await harness.runtime.authorizeContinuation(resolution.action_id, resolution.resolution_id); assert(resolution.runtime);
    const lease = await repository.issueContinuationLease(tenantA, resolution.action_id, resolution.resolution_id, resolution.runtime.resolution_sequence, resolution.runtime.evidence_sequence);
    assert.equal(await repository.consumeContinuationLease(tenantB, lease.lease), null); assert.deepEqual(await repository.consumeContinuationLease(tenantA, lease.lease), { action_id: resolution.action_id, resolution_id: resolution.resolution_id }); assert.equal(await repository.consumeContinuationLease(tenantA, lease.lease), null);
    resolution = await harness.runtime.reconcile(resolution.action_id); assert(resolution.runtime); await harness.runtime.authorizeContinuation(resolution.action_id, resolution.resolution_id);
    const stale = await repository.issueContinuationLease(tenantA, resolution.action_id, resolution.resolution_id, resolution.runtime.resolution_sequence, resolution.runtime.evidence_sequence);
    await store.evidence.append({ action_id: resolution.action_id, evidence_schema_version: 1, source: "gate8.stale-test", verification_method: "none", kind: "transport_error", strength: "transport_only", observed_disposition: "indeterminate", attribution: "indeterminate", provider_object_id: null, provider_event_id: randomUUID(), observed_at: harness.clock.now().timestamp, provider_timestamp: null, payload: { category: "new_evidence" }, correlation: { method: "test", value: resolution.action_id }, signing: null, clock: harness.clock.now(), supersedes_evidence_id: null });
    assert.equal(await repository.consumeContinuationLease(tenantA, stale.lease), null);

    // The same runtime authority under a policy that forbids automatic
    // continuation must produce no lease at all (I7 — intersection, not union).
    await repository.createPolicyVersion(tenantA, tenantA.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 300 });
    const restricted = (await harness.runtime.commit(harness.spec.effect_name, `${tenantA.environment_id}:lease-blocked-${suffix}`, runtimeInput("definitely_applied", { repository_id: `lease-blocked-${suffix}` }), EMPTY_CONTEXT, { establish_dispatch_eligibility: (action) => repository.scopeAction(tenantA, action.action_id, `lease-blocked-${suffix}`) })).resolution;
    assert(restricted.runtime);
    assert.equal(restricted.control.continuation, "allowed", "runtime authority must still allow continuation for this to prove the intersection");
    await assert.rejects(() => repository.issueContinuationLease(tenantA, restricted.action_id, restricted.resolution_id, restricted.runtime!.resolution_sequence, restricted.runtime!.evidence_sequence), /authorize/i);
  });

  it("rejects direct tenant-scope rewrites and deletion", async () => {
    const row = await pool.query(`SELECT action_id FROM nyst_action_scopes WHERE organization_id=$1 LIMIT 1`, [tenantA.organization_id]); const actionId = row.rows[0]!.action_id;
    await assert.rejects(() => pool.query(`UPDATE nyst_action_scopes SET organization_id=$2 WHERE action_id=$1`, [actionId, tenantB.organization_id]), /immutable/);
    await assert.rejects(() => pool.query(`DELETE FROM nyst_action_scopes WHERE action_id=$1`, [actionId]), /immutable/);
  });
});

function cookie(value: string | string[] | undefined): string { const text = Array.isArray(value) ? value[0] : value; assert(text); return text.split(";")[0]!; }
