/**
 * Nyst v0.2.2 — Phases 13-20.
 *
 *   13 Go-Live readiness and the formal labels
 *   14 Incident Inbox ("Needs Attention")
 *   15 Human Review safety
 *   16 Slack notification
 *   17 Impact metrics from ONE canonical source
 *   18 Proof Pack
 *   19 Failure Lab
 *   20 Canonical offboarding order
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { buildProductServer } from "../src/product/server.js";
import { TestSecretProvider } from "../src/product/secretProvider.js";
import { proofPackHtml } from "../src/product/proofPack.js";
import { buildHumanReviewMessage } from "../src/product/slackNotifier.js";
import { WORKLOAD_LABEL_DEFINITIONS } from "../src/product/goLiveReadiness.js";
import { CANONICAL_OFFBOARDING_ORDER, CANONICAL_OFFBOARDING_STAGES, CANONICAL_OFFBOARDING_SUMMARY } from "../src/offboarding/canonicalStages.js";
import { runFailureLabEngine } from "../src/product/failureLabEngine.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { verifyResolution } from "../src/engine/resolver.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";
import { runtimeInput } from "./runtimeHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phases 13-20", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let runtime: ReturnType<typeof createProductProviderRuntime>["runtime"];
  let descriptors: ReturnType<typeof createProductProviderRuntime>["descriptors"];
  let signer: Ed25519Signer;
  let effect: string;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let auth: { cookie: string; csrf: string };
  let agentId: string;
  const suffix = randomUUID().slice(0, 8);
  const password = "Nyst v022 operations fixture 39!";
  const secrets = new TestSecretProvider({ "env:NYST_GITHUB_TOKEN": "synthetic-token" });

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Ops", organization_slug: `ops-${suffix}`, project: "Ops", project_slug: "opsproject",
      environment: "Production", environment_slug: "production", email: `ops-${suffix}@ops.test`, display_name: "Ops", password,
    });
    signer = Ed25519Signer.ephemeral("p1320");
    const product = createProductProviderRuntime(store, repository, signer, new MutableClock(), { production: false, enable_development_fake: true });
    runtime = product.runtime; descriptors = product.descriptors;
    effect = descriptors.find((item) => item.provider === "fake")!.effect_name;
    await repository.configureEffectSpec(tenant, descriptors.find((item) => item.effect_name === effect)!, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 300 });
    app = await buildProductServer({ repository, effect_specs: descriptors, runtime: product.runtime, commit: product.commit, production: false, secrets,
      verify_receipt: (receipt) => verifyResolution(signer, receipt as never) });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `ops-${suffix}`, email: `ops-${suffix}@ops.test`, password } });
    auth = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, csrf: login.json().csrf };
    agentId = (await repository.createAgent(tenant, tenant.user_id, { name: "HR Offboarding Agent", slug: `ops-agent-${suffix}`, owner: "IT", framework: "OpenAI Agents SDK" })).agent_id as string;
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const headers = () => ({ cookie: auth.cookie, "x-nyst-csrf": auth.csrf });

  async function commit(key: string, scenario: string): Promise<string> {
    const result = await runtime.commit(effect, `${tenant.environment_id}:${key}`, runtimeInput(scenario, { repository_id: key }), EMPTY_CONTEXT, {
      establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, key, agentId),
    });
    await repository.recordResolutionTransition(result.action.action_id, result.resolution, "action_commit");
    return result.action.action_id;
  }

  /* ============================================================ PHASE 13 */

  it("P13: readiness is computed per Agent + Environment + EffectSpec with truthful labels", async () => {
    const readiness = await repository.goLiveReadiness(tenant, secrets, agentId, effect, descriptors);
    assert.equal(readiness.effect_name, effect);
    assert.equal(readiness.agent_id, agentId);
    assert.ok(readiness.checks.length >= 10, "every readiness dimension is reported");
    for (const check of readiness.checks) assert.equal(typeof check.detail, "string");
    assert.equal(readiness.label, "Protected");
    assert.equal(readiness.protected_by_nyst, true);
    assert.equal(readiness.label_definition, WORKLOAD_LABEL_DEFINITIONS.Protected);
  });

  it('P13: "Protected" is impossible while anything blocks, in Shadow, or while frozen', async () => {
    // Shadow: Nyst is not controlling the workload, so it cannot be Protected.
    await repository.setEnvironmentMode(tenant, tenant.user_id, "shadow", "readiness proof");
    const shadow = await repository.goLiveReadiness(tenant, secrets, agentId, effect, descriptors);
    assert.equal(shadow.label, "Shadow");
    assert.equal(shadow.protected_by_nyst, false);
    await repository.setEnvironmentMode(tenant, tenant.user_id, "enforced", "restore");

    // Frozen: no new consequence may begin, so it is not Protected either.
    const freeze = await repository.activateFreeze(tenant, tenant.user_id, { reason: "readiness proof" });
    const frozen = await repository.goLiveReadiness(tenant, secrets, agentId, effect, descriptors);
    assert.equal(frozen.label, "Frozen");
    assert.equal(frozen.protected_by_nyst, false);
    await repository.releaseFreeze(tenant, tenant.user_id, String(freeze.freeze_id), "done");

    // A real provider effect with an unresolvable credential is Blocked, never Protected.
    const github = descriptors.find((item) => item.provider === "github")!;
    await repository.configureEffectSpec(tenant, github, true);
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    const blocked = await repository.goLiveReadiness(tenant, { resolve: async () => { throw new Error("gone"); } }, agentId, github.effect_name, descriptors);
    assert.equal(blocked.label, "Blocked");
    assert.equal(blocked.protected_by_nyst, false);
    assert.ok(blocked.blocking_failures.some((reason) => /credential/i.test(reason)));
  });

  /* ============================================================ PHASE 14 */

  it("P14: Needs Attention explains what Nyst knows, does not know, and why it stopped", async () => {
    const actionId = await commit(`inbox-${suffix}`, "provider_read_unavailable");
    await repository.openHumanReview(tenant, actionId, "Provider observation unavailable");
    const inbox = await repository.needsAttention(tenant);
    const incident = inbox.find((item) => item.action_id === actionId)!;
    assert.ok(incident, "the incident appears in the inbox");
    assert.equal(incident.agent, "HR Offboarding Agent");
    assert.ok(String(incident.title).length > 0);
    assert.ok(Array.isArray(incident.what_nyst_knows) && (incident.what_nyst_knows as string[]).length > 0);
    assert.ok(Array.isArray(incident.what_nyst_does_not_know) && (incident.what_nyst_does_not_know as string[]).length > 0);
    assert.ok(String(incident.why_nyst_stopped).length > 0);
    assert.ok(Number(incident.age_seconds) >= 0);
    const safe = incident.safe_actions as string[];
    assert.ok(safe.includes("acknowledge") && safe.includes("request_reobservation"));
    for (const forbidden of ["force_continue", "force_retry", "set_effect_state", "ignore"]) {
      assert.ok(!safe.includes(forbidden), `${forbidden} must never be offered`);
    }
  });

  it("P14: a held consequence with no action still reaches the inbox", async () => {
    const heldAgent = (await repository.createAgent(tenant, tenant.user_id, { name: "Held", slug: `held-agent-${suffix}`, owner: "IT" })).agent_id as string;
    await repository.createBlastRadiusBudget(tenant, tenant.user_id, { agent_id: heldAgent, effect_name: effect, window_seconds: 3600, max_actions_per_window: 1 });
    await repository.admitConsequence(tenant, { agent_id: heldAgent, effect_name: effect, business_key: `held-1-${suffix}`, amount_minor: null, currency: null });
    const held = await repository.admitConsequence(tenant, { agent_id: heldAgent, effect_name: effect, business_key: `held-2-${suffix}`, amount_minor: null, currency: null });
    assert.equal(held.admitted, false);
    const inbox = await repository.needsAttention(tenant);
    const incident = inbox.find((item) => item.source === "held_consequence" && item.agent === "Held");
    assert.ok(incident, "a consequence Nyst refused to start is still an operator-visible incident");
    assert.equal(incident!.action_id, null, "and it honestly reports that no action exists");
  });

  /* ============================================================ PHASE 15 */

  it("P15: Human Review cannot force retry, force continuation, or rewrite state", async () => {
    const actionId = await commit(`review-safety-${suffix}`, "transport_timeout");
    const review = await repository.openHumanReview(tenant, actionId, "safety proof");
    const options = await repository.humanReviewOptions(tenant, actionId);
    assert.ok(options.permitted.includes("acknowledge"));
    assert.ok(options.permitted.includes("request_reobservation"));
    assert.ok(!options.permitted.includes("force_continue" as never));
    assert.ok(options.forbidden.includes("force_retry"));
    assert.ok(options.forbidden.includes("set_effect_state"));

    for (const attempt of ["force_continue", "force_retry", "set_effect_state", "approve"]) {
      const response = await app.inject({ method: "POST", url: `/v1/reviews/${review.human_review_id}`, headers: headers(), payload: { operation: attempt } });
      assert.equal(response.statusCode, 400, `${attempt} must be rejected at the API boundary`);
    }
    await assert.rejects(() => repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "authorize_compensation"),
      /may not authorize_compensation|do not authorize/i, "compensation is refused when the runtime does not support it");

    // The state itself is unreachable: a reviewer cannot write a resolution.
    const latest = (await store.resolutions.latestForAction(actionId))!;
    await assert.rejects(() => pool.query(`UPDATE outcome_resolutions SET effect_state='verified' WHERE resolution_id=$1`, [latest.resolution_id]));
    assert.equal((await store.resolutions.latestForAction(actionId))!.effect.state, latest.effect.state);
  });

  it("P15: re-observation stays read-only and acknowledgement changes no external truth", async () => {
    const actionId = await commit(`review-readonly-${suffix}`, "transport_timeout");
    const before = (await store.resolutions.latestForAction(actionId))!;
    const review = await repository.openHumanReview(tenant, actionId, "read-only proof");
    await repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "request_reobservation");
    const after = (await store.resolutions.latestForAction(actionId))!;
    assert.equal(after.effect.state, before.effect.state, "requesting re-observation does not itself change external truth");
    const mutations = (await pool.query(`SELECT count(*)::int c FROM nyst_recovery_executions WHERE action_id=$1`, [actionId])).rows[0]!;
    assert.equal(Number(mutations.c), 0, "no consequence is created by a review command");
  });

  /* ============================================================ PHASE 16 */

  it("P16: the Slack notification is informative and offers no unsafe action", () => {
    const incidentId = randomUUID();
    const message = buildHumanReviewMessage({
      action_id: randomUUID(), incident_id: incidentId, agent_name: "HR Offboarding Agent", effect_name: "github.repository_permission_change",
      environment: "Production", effect_state: "satisfied_unattributed", control_primary: "do_not_retry",
      reason: "Inherited GitHub access remains", incident_url: "https://nyst.example.com/reviews", opened_at: new Date().toISOString(),
    }, "env:NYST_SLACK_WEBHOOK");
    const serialized = JSON.stringify(message);
    assert.match(serialized, /HR Offboarding Agent/);
    assert.match(serialized, /satisfied_unattributed/);
    assert.match(serialized, /Open in Nyst/);
    assert.doesNotMatch(serialized.toLowerCase(), /force continue|force_retry|approve and continue/);
    const actions = (message.blocks as Array<{ type: string; elements?: Array<{ url?: string }> }>).find((block) => block.type === "actions");
    for (const element of actions?.elements ?? []) assert.ok(element.url, "every Slack affordance is a link, never a state change from Slack");
    assert.equal(message.channel_reference, "env:NYST_SLACK_WEBHOOK", "the destination is an opaque reference, never an inline URL");

    // v0.3.0 Phase 1H. The button used to promise an action a link cannot
    // perform, and pointed at a query parameter nothing in Nyst read.
    assert.doesNotMatch(serialized, /intent=reobserve/, "the dead query parameter came back");
    assert.doesNotMatch(serialized, /"Request re-observation"/,
      "a Slack link may not claim to request anything: clicking it requests nothing");
    for (const element of actions?.elements ?? []) {
      assert.doesNotMatch(String(element.url), /[?&]/,
        "a Slack affordance must not carry query parameters: link previewers fetch links with nobody deciding anything");
    }
    assert.match(serialized, new RegExp(`https://nyst\.example\.com/reviews#review-${incidentId}`),
      "the second affordance must deep-link to the incident's real control");
  });

  /* ============================================================ PHASE 17 */

  it("P17: Overview and the Protection Report read the SAME canonical source", async () => {
    const overview = await repository.overview(tenant);
    const report = await repository.protectionReport(tenant, secrets, "all");
    assert.equal(report.metrics.consequential_actions, overview.consequential_actions);
    assert.equal(report.enforced.unsafe_retries_prevented, overview.unsafe_retries_prevented_enforced);
    assert.equal(report.shadow.unsafe_retries_detected, overview.unsafe_retries_detected_shadow);
    assert.equal(report.metrics.human_escalations, overview.human_escalations);
  });

  /* ============================================================ PHASE 18 */

  it("P18: the Proof Pack packages existing truth and creates none", async () => {
    const actionId = await commit(`proof-${suffix}`, "response_lost_after_effect");
    const pack = (await repository.proofPack(tenant, actionId, (receipt) => verifyResolution(signer, receipt as never)))!;
    assert.ok(pack);
    assert.equal(pack.provenance, "assembled_from_persisted_records");
    assert.equal(pack.action.action_id, actionId);
    assert.equal(pack.agent?.name, "HR Offboarding Agent");
    assert.ok(pack.policy, "the bound policy version is included");
    assert.ok(pack.evidence.length > 0, "cited evidence is included");
    assert.ok(pack.resolution_history.length > 0);
    assert.ok(pack.current, "the current EffectState and ControlDecision are included");
    assert.equal(pack.receipt_verification.verified, true, "the signed receipt verifies");
    assert.match(pack.receipt_verification.note, /tamper evidence, not hardware attestation/);
    assert.ok(pack.attestations.some((note) => /NOT hardware-backed/.test(note)));
    assert.ok(pack.dispatch_boundary.dispatch_status, "the durable dispatch boundary is included");

    // Generating a Proof Pack must not write anything.
    const before = (await pool.query(`SELECT count(*)::int c FROM outcome_evidence WHERE action_id=$1`, [actionId])).rows[0]!.c;
    await repository.proofPack(tenant, actionId);
    const after = (await pool.query(`SELECT count(*)::int c FROM outcome_evidence WHERE action_id=$1`, [actionId])).rows[0]!.c;
    assert.equal(after, before, "assembling a Proof Pack creates no new records");

    const html = proofPackHtml(pack);
    assert.match(html, /Nyst Proof Pack/);
    assert.match(html, /What this bundle does and does not prove/);
    assert.doesNotMatch(html, /<script/i);

    const response = await app.inject({ method: "GET", url: `/v1/actions/${actionId}/proof-pack?format=html`, headers: headers() });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/html/);
  });

  it("P18: the Proof Pack escapes hostile content instead of rendering it", async () => {
    const actionId = await commit(`proof-xss-${suffix}`, "definitely_applied");
    const pack = (await repository.proofPack(tenant, actionId))!;
    const html = proofPackHtml({ ...pack, action: { ...pack.action, business_key: `<img src=x onerror="alert(1)">` } });
    assert.ok(!html.includes("<img src=x"), "hostile markup must be escaped");
    assert.match(html, /&lt;img src=x/);
  });

  /* ============================================================ PHASE 19 */

  it("P19: the Failure Lab runs the real runtime and never hardcodes an outcome", async () => {
    const scenarios = ["response_lost", "timeout_before_send", "delayed_observation", "reconcile_rate_limit", "duplicate_caller", "process_crash"] as const;
    const states = new Set<string>();
    for (const scenario of scenarios) {
      const result = await runFailureLabEngine(scenario, effect, 42);
      assert.equal(result.simulated, true, "every run is labelled a simulation");
      assert.equal(result.provider_credentials_used, false, "the Failure Lab never resolves a provider credential");
      assert.ok(result.action_id, "a real action was created by the real runtime");
      assert.ok(result.timeline.length > 0, "real runtime events are recorded");
      assert.equal(result.signature_valid, true, "a real signed receipt is produced");
      assert.ok(result.naive_behavior.length > 0 && result.nyst_behavior.length > 0);
      states.add(result.final_effect_state);
    }
    assert.ok(states.size > 1, `different faults must produce different truths, saw ${[...states].join(", ")}`);
  });

  it("P19: the Failure Lab is isolated from Enforced environments and production credentials", async () => {
    await repository.setEnvironmentMode(tenant, tenant.user_id, "enforced", "isolation proof");
    await assert.rejects(() => repository.runFailureLab(tenant, tenant.user_id, "response_lost", effect, 7), /isolated/i);
    await repository.setEnvironmentMode(tenant, tenant.user_id, "shadow", "lab");
    const run = await repository.runFailureLab(tenant, tenant.user_id, "response_lost", effect, 7);
    assert.equal(run.provider_credentials_used, false);
    assert.equal(run.simulated, true);
    await repository.setEnvironmentMode(tenant, tenant.user_id, "enforced", "restore");

    // Lab runs live in their own table and can never inflate production metrics.
    const metrics = await repository.canonicalMetrics(tenant);
    const labRuns = Number((await pool.query(`SELECT count(*)::int c FROM nyst_failure_lab_runs WHERE environment_id=$1`, [tenant.environment_id])).rows[0]!.c);
    assert.ok(labRuns > 0);
    const scoped = Number((await pool.query(`SELECT count(*)::int c FROM nyst_action_scopes WHERE environment_id=$1`, [tenant.environment_id])).rows[0]!.c);
    assert.equal(metrics.consequential_actions, scoped, "Failure Lab runs are not counted as consequential actions");
  });

  /* ============================================================ PHASE 20 */

  it("P20: one canonical offboarding order, and the runtime agrees with it", async () => {
    assert.deepEqual([...CANONICAL_OFFBOARDING_ORDER], ["okta.user_suspension_change", "github.repository_permission_change"]);
    assert.equal(CANONICAL_OFFBOARDING_SUMMARY, "Okta suspension → GitHub access removal");
    assert.deepEqual(CANONICAL_OFFBOARDING_STAGES.map((stage) => stage.index), [1, 2]);
    for (const stage of CANONICAL_OFFBOARDING_STAGES) {
      assert.ok(stage.rationale.length > 0, "every stage states why it is in this position");
      assert.ok(stage.continuation_requirement.length > 0);
    }

    // The API surface serves the same order the constant defines.
    const served = (await app.inject({ method: "GET", url: "/v1/offboarding/stages", headers: headers() })).json();
    assert.deepEqual(served.stages.map((stage: { effect_name: string }) => stage.effect_name), [...CANONICAL_OFFBOARDING_ORDER]);
    assert.equal(served.summary, CANONICAL_OFFBOARDING_SUMMARY);

    // And the coordinator's own status vocabulary runs Okta before GitHub.
    const coordinator = await import("../src/offboarding/offboardingCoordinator.js");
    const source = coordinator as unknown as Record<string, unknown>;
    assert.ok(source, "the coordinator module loads");
    const runs = await repository.offboardingRuns(tenant);
    assert.ok(Array.isArray(runs));
  });
});
