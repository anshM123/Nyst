/**
 * Nyst v0.3.0 — Phases 27, 33, 34.
 *
 * OUTCOME SHADOW produces the sentence the whole product is sold on:
 *
 *     Your Agent considered this offboarding complete.
 *     Inherited GitHub production access remained for 14m 23s.
 *
 * Which makes the language rule the most important test in this file. In
 * Shadow, Nyst was not in the path. It held nothing, blocked nothing and
 * prevented nothing, and a number that quietly implies otherwise poisons every
 * other number the customer is shown.
 *
 * FAILURE LAB 2.0 must compute its answers with the REAL evaluator. A lab that
 * renders a scripted verdict proves nothing at all.
 *
 * NYSTBENCH must never publish a figure it did not measure.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { OutcomeShadow, assertShadowLanguage, humanDuration } from "../src/product/outcome/outcomeShadow.js";
import {
  NYSTBENCH_LABEL, OUTCOME_FAULTS, OUTCOME_FAULT_CATALOGUE, runNystBench, runOutcomeFault,
} from "../src/product/outcome/failureLab2.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.0 Phases 27/33/34 — Outcome Shadow, Failure Lab 2.0, NystBench", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let shadow: OutcomeShadow;
  let tenant: TenantScope & { user_id: string };
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    shadow = new OutcomeShadow(pool, outcomes);
    tenant = await repository.createBootstrap({
      organization: "Shadow Co", organization_slug: `shadowco-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `shadow-${suffix}@test.test`, display_name: "Shadow", password: "Nyst v030 shadow fixture 23!",
    });
    await repository.setEnvironmentMode(tenant, tenant.user_id, "shadow", "Outcome Shadow evaluation");
    void Ed25519Signer.ephemeral("shadow");
  });
  after(async () => { await store.close(); await pool.end(); });

  async function offboarding(name: string): Promise<{ instanceId: string; github: string; okta: string }> {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const subject = {
      person_email: `${name}@example.test`, github_login: name,
      github_repository: "acme/production", okta_user_id: `00u${name}`,
    };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject,
      subject_key: `offboard:${subject.person_email}`, mode: "shadow",
    });
    return {
      instanceId: instance.outcome_instance_id,
      github: `github:${subject.github_repository}:${subject.github_login}`,
      okta: `okta:user:${subject.okta_user_id}`,
    };
  }

  async function observe(subjectRef: string, provider: string, property: string, value: string, at = new Date()): Promise<void> {
    await outcomes.recordFact(tenant, {
      subject_ref: subjectRef, provider, property, value: { type: "string", value },
      observed_at: at.toISOString(), fresh_until: new Date(at.getTime() + 900_000).toISOString(),
      source_type: "provider_api_read", authoritative: true, adapter_version: "shadow-test/1.0.0",
    });
  }

  /* =========================================================== THE FINDING */

  it("THE SIGNATURE FINDING: the Agent said complete, and access remained — measured, not estimated", async () => {
    const { instanceId, github, okta } = await offboarding(`alice${suffix}`);

    // The world at the moment the Agent declares victory: direct access gone,
    // inherited access still granting WRITE, Okta suspended.
    const declaredAt = new Date();
    await observe(github, "github", "direct_permission", "none", declaredAt);
    await observe(github, "github", "effective_permission", "write", declaredAt);
    await observe(okta, "okta", "account_status", "SUSPENDED", declaredAt);

    const signalled = await shadow.recordCompletionSignal(tenant, {
      outcome_instance_id: instanceId, declared_status: "complete", declared_at: declaredAt, now: declaredAt,
    });
    assert.equal(signalled.verdict, "unsatisfied",
      "Nyst agreed with the Agent that an offboarding leaving WRITE access was complete");
    assert.ok(signalled.finding, "no Shadow finding was produced for a workflow declared complete too early");
    assert.equal(signalled.finding!.kind, "declared_complete_too_early");
    assert.equal(signalled.finding!.invariant_id, "github_effective_access_none");
    assert.match(signalled.finding!.finding, /would have held/i);

    // 14 minutes 23 seconds later the inherited path is removed and Nyst
    // observes the outcome hold.
    const resolvedAt = new Date(declaredAt.getTime() + (14 * 60 + 23) * 1000);
    await observe(github, "github", "effective_permission", "none", resolvedAt);
    const evaluated = await outcomes.evaluate(tenant, instanceId, { now: resolvedAt });
    assert.equal(evaluated.evaluation.verdict, "satisfied");

    const closed = await shadow.closeExposure(tenant, instanceId, resolvedAt);
    assert.ok(closed >= 1, "no exposure window was closed when the outcome became satisfied");

    const findings = await shadow.findings(tenant);
    const exposure = findings.find((item) => item.kind === "declared_complete_too_early")!;
    assert.ok(exposure.exposure_seconds !== null, "the exposure was never measured");
    // The duration is MEASURED between two observations, not estimated. Allow
    // a couple of seconds for the satisfied_at timestamp the database wrote.
    assert.ok(Math.abs(exposure.exposure_seconds! - 863) <= 5,
      `the measured exposure was ${exposure.exposure_seconds}s; expected about 863s (14m 23s)`);
    assert.equal(humanDuration(863), "14m 23s");

    const headline = await shadow.headline(tenant);
    assert.ok(headline, "no headline finding was produced");
    assert.match(headline!, /considered this workflow complete/);
    assert.match(headline!, /14m 23s|14m 2[0-9]s/);
  });

  it("THE LANGUAGE RULE: Shadow may never claim it prevented anything", async () => {
    // The guard itself.
    assert.throws(() => assertShadowLanguage("Nyst prevented 14 unsafe continuations."), /may not claim/);
    assert.throws(() => assertShadowLanguage("This was blocked before it could happen."), /may not claim/);
    assert.throws(() => assertShadowLanguage("Nyst stopped the offboarding."), /may not claim/);
    // And the counterfactual phrasing passes.
    assertShadowLanguage("In Enforced, Nyst would have held this. Shadow observed it.");

    // Every finding actually stored obeys it.
    for (const finding of await shadow.findings(tenant)) {
      assertShadowLanguage(finding.finding);
    }

    // And the metrics payload says so out loud rather than leaving it implied.
    const metrics = await shadow.metrics(tenant);
    assert.equal(metrics.language, "detected");
    assert.match(metrics.disclaimer, /prevented nothing/);
    assert.match(metrics.disclaimer, /was not in the path/);
    assert.doesNotMatch(JSON.stringify({ ...metrics, disclaimer: "" }), /prevented|blocked/i,
      "a Shadow metric name claims prevention");
  });

  it("Shadow metrics count what was observed, and every one is checkable against its parts", async () => {
    const metrics = await shadow.metrics(tenant);
    const findings = await shadow.findings(tenant, 200);
    assert.equal(metrics.outcomes_agent_declared_complete_too_early,
      findings.filter((item) => item.kind === "declared_complete_too_early").length);
    assert.equal(metrics.unsafe_continuation_opportunities,
      findings.filter((item) => item.kind === "unsafe_continuation_opportunity").length);
    assert.equal(metrics.automatically_established_later,
      findings.filter((item) => item.kind === "established_later").length);
    assert.ok(metrics.longest_exposure_seconds > 0);
    assert.ok(metrics.total_exposure_seconds >= metrics.longest_exposure_seconds);
  });

  it("an Agent's claim is stored as a claim, is immutable, and never moves the verdict", async () => {
    const { instanceId, github, okta } = await offboarding(`bob${suffix}`);
    await observe(github, "github", "effective_permission", "admin");
    await observe(okta, "okta", "account_status", "ACTIVE");
    const { signal, verdict } = await shadow.recordCompletionSignal(tenant, {
      outcome_instance_id: instanceId, declared_status: "complete",
    });
    assert.equal(verdict, "unsatisfied", "THE AGENT'S CLAIM CHANGED NYST'S VERDICT");
    assert.equal(signal.verdict_at_signal, "unsatisfied");
    const instance = await outcomes.instance(tenant, instanceId);
    assert.equal(instance!.verdict, "unsatisfied");

    await assert.rejects(
      () => pool.query(`UPDATE nyst_agent_completion_signals SET declared_status='failed' WHERE completion_signal_id=$1`,
        [signal.completion_signal_id]),
      /append-only/, "an Agent's historical claim was rewritten");
    await assert.rejects(
      () => pool.query(`DELETE FROM nyst_agent_completion_signals WHERE completion_signal_id=$1`, [signal.completion_signal_id]),
      /append-only/);
  });

  it("an Agent that is right produces no finding", async () => {
    const { instanceId, github, okta } = await offboarding(`carol${suffix}`);
    await observe(github, "github", "effective_permission", "none");
    await observe(okta, "okta", "account_status", "SUSPENDED");
    const result = await shadow.recordCompletionSignal(tenant, {
      outcome_instance_id: instanceId, declared_status: "complete",
    });
    assert.equal(result.verdict, "satisfied");
    assert.equal(result.finding, null, "Nyst manufactured a finding against an Agent that was correct");
  });

  /* ========================================================= FAILURE LAB 2 */

  it("every Failure Lab fault computes its verdict with the REAL evaluator", () => {
    for (const fault of OUTCOME_FAULTS) {
      const run = runOutcomeFault(fault);
      assert.equal(run.simulation, true);
      assert.match(run.label, /SIMULATION/);
      assert.ok(run.evaluation.required.length >= 2, `${fault} evaluated no invariants`);
      // The verdict must be derivable from the invariant results, which is
      // only true if it came from the real combinator rather than a script.
      const falses = run.evaluation.required.filter((item) => item.result === "false").length;
      const unknowns = run.evaluation.required.filter((item) => item.result === "indeterminate").length;
      const expected = falses ? "unsatisfied" : unknowns ? "indeterminate" : "satisfied";
      assert.equal(run.evaluation.verdict, expected,
        `${fault} reported a verdict its own invariant results do not support`);
      // Every fault carries a customer-readable explanation.
      const description = OUTCOME_FAULT_CATALOGUE[fault];
      assert.ok(description.what_happens.length > 20);
      assert.ok(description.naive_conclusion.length > 20);
      assert.ok(description.nyst_conclusion.length > 20);
    }
  });

  it("the flagship fault reproduces the headline: action fine, outcome false", () => {
    const run = runOutcomeFault("direct_removed_inherited_remains");
    assert.equal(run.evaluation.verdict, "unsatisfied");
    const github = run.evaluation.required.find((item) => item.invariant_id === "github_effective_access_none")!;
    assert.equal(github.result, "false");
    assert.match(github.reason, /write/);
    // Coverage is full: the outcome is false because the world is wrong.
    assert.deepEqual(run.evaluation.coverage, { numerator: 2, denominator: 2 });
  });

  it("faults where the honest answer is unknown come back INDETERMINATE, not false", () => {
    for (const fault of ["provider_outage", "missing_integration", "evidence_expires", "contradictory_evidence"] as const) {
      const run = runOutcomeFault(fault);
      assert.equal(run.evaluation.verdict, "indeterminate",
        `${fault} produced a definite answer where Nyst could not actually know`);
    }
  });

  it("the lab is deterministic, and touches no provider and no credential", () => {
    const first = JSON.stringify(runOutcomeFault("contradictory_evidence", { now: new Date(1_700_000_000_000), seed: 7 }));
    const second = JSON.stringify(runOutcomeFault("contradictory_evidence", { now: new Date(1_700_000_000_000), seed: 7 }));
    assert.equal(first, second, "the same seed and clock produced different results");

    const source = readFileSync(resolve(process.cwd(), "src/product/outcome/failureLab2.ts"), "utf8");
    // No network, no provider client, no credential reference of any kind.
    assert.doesNotMatch(source, /\bfetch\(|https?:\/\/(?!\s)|GitHubRestClient|OktaRestClient|StripeRestClient/);
    assert.doesNotMatch(source, /env:NYST_|ghp_|github_pat_|sk_(test|live)_/);
    for (const fault of OUTCOME_FAULTS) {
      assert.doesNotMatch(JSON.stringify(runOutcomeFault(fault)), /ghp_|github_pat_|sk_(test|live)_|Bearer /);
    }
  });

  /* ============================================================ NYSTBENCH */

  it("NystBench is deterministic, labelled, and every aggregate matches its parts", () => {
    const first = runNystBench({ now: new Date(1_700_000_000_000) });
    const second = runNystBench({ now: new Date(1_700_000_000_000) });
    assert.deepEqual(first, second, "the benchmark is not deterministic");
    assert.equal(first.label, NYSTBENCH_LABEL);
    assert.match(first.label, /SIMULATED \/ ADVERSARIAL BENCHMARK/);

    // Every rate is recomputable from per_fault, so no figure is asserted.
    const total = first.per_fault.length;
    assert.equal(first.faults_run, total);
    const baselineFalseSuccess = first.per_fault.filter((item) =>
      item.baseline_claimed_success && !item.ground_truth_satisfied).length / total;
    assert.equal(first.baseline.false_success_rate, Number(baselineFalseSuccess.toFixed(4)));
    const nystFalseSuccess = first.per_fault.filter((item) =>
      item.nyst_verdict === "satisfied" && !item.ground_truth_satisfied).length / total;
    assert.equal(first.nyst.false_success_rate, Number(nystFalseSuccess.toFixed(4)));

    // The headline claim, and it must be measured rather than assumed.
    assert.equal(first.nyst.false_success_rate, 0,
      "Nyst reported success on an outcome that was not actually satisfied");
    assert.ok(first.baseline.false_success_rate > 0,
      "the baseline model never fails, which means it is not modelling real agent behaviour");
    assert.equal(first.nyst.duplicate_effect_rate, 0);
    assert.ok(first.baseline.duplicate_effect_rate > 0);

    // The method is stated, including how the baseline was modelled, so a
    // sceptical reader can disagree with it rather than having to trust it.
    assert.match(first.method.baseline.decision_rule, /successful provider response/);
    assert.match(first.method.note, /No provider was contacted/);
    assert.match(first.method.note, /never be published without this label/);
  });

  it("no public claim quotes a benchmark number without the simulation label", () => {
    // Anything that renders a NystBench figure must render the label with it.
    const directory = resolve(process.cwd(), "src/product");
    const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(resolve(path, entry.name))
        : entry.name.endsWith(".ts") ? [resolve(path, entry.name)] : []);
    let checked = 0;
    for (const file of walk(directory)) {
      const source = readFileSync(file, "utf8");
      // Returning the benchmark object wholesale is fine: the label travels
      // inside the payload. What must never happen is a surface FORMATTING an
      // individual rate for a human to read without the label beside it.
      const rendersAFigure = /BenchmarkResult|benchmark\.(baseline|nyst)/.test(source) && /toFixed\(/.test(source);
      if (!rendersAFigure) continue;
      checked += 1;
      assert.match(source, /NYSTBENCH_LABEL|SIMULATED \/ ADVERSARIAL BENCHMARK/,
        `${file} formats a benchmark figure for a human without the simulation label`);
    }
    assert.ok(checked > 0, "no surface renders a benchmark figure, so this check proved nothing");
  });
});
