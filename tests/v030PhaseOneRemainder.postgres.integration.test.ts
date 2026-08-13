/**
 * Nyst v0.3.0 — Phases 1E, 1F, 1G, 1H.
 *
 * 1E  Scoped Freeze readiness must use the SAME coverage predicate as admission.
 *     Freezing Agent A marked every unrelated workload in the environment
 *     "Frozen", while admission would cheerfully have admitted them.
 *
 * 1F  Policy readiness must use the production policy resolver. It asked
 *     "does any policy row exist here?", which is true in an environment whose
 *     only policy governs a different EffectSpec entirely.
 *
 * 1G  Blast Radius must not consume budget before semantically valid input
 *     exists, amounts must come only from EffectSpecs with declared financial
 *     semantics, and a missing amount is a refusal rather than a zero.
 *
 * 1H  The Slack "Request re-observation" button linked to ?intent=reobserve,
 *     which nothing in Nyst honoured.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { authoritativeConsequenceMetadata, EffectInputError, effectSemantics } from "../src/product/effectSemantics.js";
import { FREEZE_COVERAGE_PREDICATE } from "../src/product/admission.js";
import { buildHumanReviewMessage, incidentFragment } from "../src/product/slackNotifier.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { GITHUB_EFFECT_NAME } from "../src/providers/github/types.js";
import { OKTA_EFFECT_NAME } from "../src/providers/okta/types.js";
import { STRIPE_REFUND_EFFECT } from "../src/providers/stripe/types.js";
import type { EffectSpecDescriptor, TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const secrets = { async resolve(): Promise<string> { return "synthetic-phase-one-remainder"; } };

describe("Nyst v0.3.0 Phase 1E/1F/1G/1H", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let descriptors: readonly EffectSpecDescriptor[];
  let fakeEffect: string;
  let agentA: string;
  let agentB: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Remainder", organization_slug: `remainder-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `remainder-${suffix}@test.test`, display_name: "Remainder", password: "Nyst v030 remainder fixture 23!",
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p1r"), new MutableClock(),
      { production: false, enable_development_fake: true });
    descriptors = product.descriptors;
    fakeEffect = descriptors.find((item) => item.provider === "fake")!.effect_name;
    for (const descriptor of descriptors) await repository.configureEffectSpec(tenant, descriptor, true);
    agentA = String((await repository.createAgent(tenant, tenant.user_id, {
      name: "Agent A", slug: `agent-a-${suffix}`, owner: "Platform", description: "", framework: "unspecified", tags: [],
    })).agent_id);
    agentB = String((await repository.createAgent(tenant, tenant.user_id, {
      name: "Agent B", slug: `agent-b-${suffix}`, owner: "Platform", description: "", framework: "unspecified", tags: [],
    })).agent_id);
  });
  after(async () => { await store.close(); await pool.end(); });

  /* ============================================================ 1E */

  it("1E THE CASE: freezing Agent A does not mark Agent B frozen, and admission agrees", async () => {
    const freeze = await repository.activateFreeze(tenant, tenant.user_id, {
      scope_agent_id: agentA, scope_effect_name: null, reason: "Agent A is misbehaving and only Agent A.",
    });
    try {
      const coveredA = await repository.freezeCoverage(tenant, agentA, fakeEffect);
      const coveredB = await repository.freezeCoverage(tenant, agentB, fakeEffect);
      assert.equal(coveredA.frozen, true, "the freeze does not cover the Agent it names");
      assert.equal(coveredB.frozen, false, "an unrelated Agent was marked frozen");

      // Readiness and the gate must give the same answer. Admission is the gate.
      const admissionB = await repository.admitConsequence(tenant, {
        agent_id: agentB, effect_name: fakeEffect, business_key: `freeze-scope-b-${suffix}`, amount_minor: null, currency: null,
      });
      assert.equal(admissionB.admitted, true, "admission blocked an Agent the freeze does not name");

      const admissionA = await repository.admitConsequence(tenant, {
        agent_id: agentA, effect_name: fakeEffect, business_key: `freeze-scope-a-${suffix}`, amount_minor: null, currency: null,
      });
      assert.equal(admissionA.admitted, false);
      assert.equal(admissionA.blocked_by, "freeze");

      // And Go-Live, which is what an operator actually looks at.
      const goLiveB = await repository.goLiveReadiness(tenant, secrets, agentB, fakeEffect, descriptors);
      assert.notEqual(goLiveB.label, "Frozen", "the Go-Live screen labelled an unrelated workload Frozen");
      const goLiveA = await repository.goLiveReadiness(tenant, secrets, agentA, fakeEffect, descriptors);
      assert.equal(goLiveA.label, "Frozen");
      assert.match(goLiveA.checks.find((check) => check.id === "not_frozen")!.detail, /this Agent/);
    } finally {
      await repository.releaseFreeze(tenant, tenant.user_id, String(freeze.freeze_id), "Test cleanup.");
    }
  });

  it("1E: every scope combination the spec names", async () => {
    const otherEffect = GITHUB_EFFECT_NAME;
    const cases: ReadonlyArray<{
      name: string; scope_agent_id: string | null; scope_effect_name: string | null;
      covered: ReadonlyArray<[string | null, string]>; uncovered: ReadonlyArray<[string | null, string]>;
    }> = [
      { name: "exact Agent", scope_agent_id: agentA, scope_effect_name: null,
        covered: [[agentA, fakeEffect], [agentA, otherEffect]], uncovered: [[agentB, fakeEffect], [null, fakeEffect]] },
      { name: "exact EffectSpec", scope_agent_id: null, scope_effect_name: fakeEffect,
        covered: [[agentA, fakeEffect], [agentB, fakeEffect], [null, fakeEffect]], uncovered: [[agentA, otherEffect]] },
      { name: "whole environment", scope_agent_id: null, scope_effect_name: null,
        covered: [[agentA, fakeEffect], [agentB, otherEffect], [null, otherEffect]], uncovered: [] },
      { name: "the intersection of one Agent and one EffectSpec", scope_agent_id: agentA, scope_effect_name: fakeEffect,
        covered: [[agentA, fakeEffect]], uncovered: [[agentA, otherEffect], [agentB, fakeEffect], [null, fakeEffect]] },
    ];

    for (const testCase of cases) {
      const freeze = await repository.activateFreeze(tenant, tenant.user_id, {
        scope_agent_id: testCase.scope_agent_id, scope_effect_name: testCase.scope_effect_name,
        reason: `Scope test: ${testCase.name}.`,
      });
      try {
        for (const [agent, effect] of testCase.covered) {
          assert.equal((await repository.freezeCoverage(tenant, agent, effect)).frozen, true,
            `${testCase.name}: ${agent ?? "unattributed"} + ${effect} should be covered`);
        }
        for (const [agent, effect] of testCase.uncovered) {
          assert.equal((await repository.freezeCoverage(tenant, agent, effect)).frozen, false,
            `${testCase.name}: ${agent ?? "unattributed"} + ${effect} was covered and should not be`);
        }
      } finally {
        await repository.releaseFreeze(tenant, tenant.user_id, String(freeze.freeze_id), "Test cleanup.");
      }
    }
  });

  it("1E: readiness and admission share ONE predicate, not two that happen to agree", () => {
    // Structural. Two independently written predicates can agree today and
    // drift apart in the next change; this is the drift that produced the bug.
    const repositorySource = readFileSync(resolve(process.cwd(), "src/product/productRepository.ts"), "utf8");
    assert.match(repositorySource, /FREEZE_COVERAGE_PREDICATE/,
      "the repository no longer uses the shared coverage predicate");
    assert.match(FREEZE_COVERAGE_PREDICATE, /scope_agent_id IS NULL OR scope_agent_id=/);
    assert.match(FREEZE_COVERAGE_PREDICATE, /scope_effect_name IS NULL OR scope_effect_name=/);
    const admissionSource = readFileSync(resolve(process.cwd(), "src/product/admission.ts"), "utf8");
    assert.doesNotMatch(admissionSource, /WHERE environment_id=\$1 AND released_at IS NULL\s*\n\s*AND \(scope_agent_id/,
      "admission grew back a hand-written copy of the coverage predicate");
  });

  /* ============================================================ 1F */

  it("1F THE CASE: a policy for an unrelated EffectSpec is not a policy for this one", async () => {
    // A bare environment, inserted without the fallback policy createEnvironment
    // would seed, so the "nothing binds" state is reachable at all.
    const environmentId = randomUUID();
    await pool.query(`INSERT INTO nyst_environments(environment_id,project_id,organization_id,slug,name) VALUES($1,$2,$3,$4,$5)`,
      [environmentId, tenant.project_id, tenant.organization_id, `policy-${suffix}`, "Policy case"]);
    const isolated = { ...tenant, environment_id: environmentId };
    await repository.configureEffectSpec(isolated, descriptors.find((item) => item.effect_name === fakeEffect)!, true);

    // A policy exists in the environment — for a completely different effect.
    await repository.createPolicyVersion(isolated, tenant.user_id, {
      effect_name: GITHUB_EFFECT_NAME, execution_mode: "automatic",
      auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 3600,
    });
    assert.equal(await repository.effectivePolicyFor(isolated, fakeEffect), null,
      "a policy for another EffectSpec was reported as binding this one");
    const before = await repository.goLiveReadiness(isolated, secrets, null, fakeEffect, descriptors);
    assert.equal(before.checks.find((check) => check.id === "policy_bound")!.satisfied, false);

    // Now an environment fallback, which genuinely does bind.
    await repository.createPolicyVersion(isolated, tenant.user_id, {
      effect_name: null, execution_mode: "automatic",
      auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 3600,
    });
    const fallback = await repository.effectivePolicyFor(isolated, fakeEffect);
    assert.ok(fallback, "the environment fallback policy did not bind");
    assert.equal(fallback!.effect_name, null);

    // And an EffectSpec-specific policy wins over the fallback — the same
    // specificity rule the production resolver uses for real execution.
    await repository.createPolicyVersion(isolated, tenant.user_id, {
      effect_name: fakeEffect, execution_mode: "approval_required",
      auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 3600,
    });
    const specific = await repository.effectivePolicyFor(isolated, fakeEffect);
    assert.equal(specific!.effect_name, fakeEffect);
    assert.equal(specific!.execution_mode, "approval_required");

    // Readiness names the exact version that would bind, not "a policy exists".
    const after = await repository.goLiveReadiness(isolated, secrets, null, fakeEffect, descriptors);
    const check = after.checks.find((item) => item.id === "policy_bound")!;
    assert.equal(check.satisfied, true);
    assert.match(check.detail, new RegExp(`Policy version ${specific!.version}`));
    assert.match(check.detail, /approval required/);
  });

  it("1F: readiness resolves through the same function production execution uses", async () => {
    const specific = await repository.effectivePolicyFor(tenant, fakeEffect);
    const production = await repository.currentPolicy(tenant, fakeEffect);
    assert.equal(specific?.policy_version_id, production.policy_version_id,
      "readiness and execution would bind different policy versions");
  });

  /* ============================================================ 1G */

  it("1G THE CASE: an invalid request consumes no budget", async () => {
    const isolated = { ...tenant, environment_id: await repository.createEnvironment(tenant, "Budget case", `budget-${suffix}`) };
    await repository.configureEffectSpec(isolated, descriptors.find((item) => item.effect_name === GITHUB_EFFECT_NAME)!, true);
    await repository.createBlastRadiusBudget(isolated, tenant.user_id, {
      agent_id: null, effect_name: GITHUB_EFFECT_NAME, window_seconds: 3600,
      max_actions_per_window: 3, max_amount_minor_per_action: null, max_amount_minor_per_window: null, currency: null,
    });

    // Ten malformed submissions. Pure validation refuses every one of them, so
    // none reaches admission and none consumes a unit of the budget.
    for (let index = 0; index < 10; index += 1) {
      assert.throws(() => authoritativeConsequenceMetadata(GITHUB_EFFECT_NAME, { nonsense: index }), EffectInputError);
    }
    const used = (await pool.query(
      `SELECT count(*)::int count FROM nyst_consequence_admissions WHERE environment_id=$1`, [isolated.environment_id])).rows[0]!;
    assert.equal(used.count, 0, "invalid requests wrote admission rows and therefore consumed budget");

    // The budget is still whole: three valid actions still fit.
    for (let index = 0; index < 3; index += 1) {
      const decision = await repository.admitConsequence(isolated, {
        agent_id: null, effect_name: GITHUB_EFFECT_NAME, business_key: `valid-${index}-${suffix}`, amount_minor: null, currency: null,
      });
      assert.equal(decision.admitted, true, `valid action ${index} was refused: the budget had been eaten by invalid input`);
    }
    const fourth = await repository.admitConsequence(isolated, {
      agent_id: null, effect_name: GITHUB_EFFECT_NAME, business_key: `valid-3-${suffix}`, amount_minor: null, currency: null,
    });
    assert.equal(fourth.admitted, false, "the count budget did not bite at all");
    assert.equal(fourth.blocked_by, "blast_radius");
  });

  it("1G: GITHUB FAKE AMOUNT — a count-only effect may not declare money", () => {
    // The attack: slip an amount onto an effect Nyst has no financial semantics
    // for, so a monetary budget evaluates against a number the caller chose.
    assert.throws(() => authoritativeConsequenceMetadata(GITHUB_EFFECT_NAME, {
      owner: "nyst", repository: "fixture", principal: "alice", desired_permission: "write",
      credential_ref: "env:NYST_GITHUB_TOKEN", amount_minor: 1, currency: "usd",
    }), (error: unknown) => error instanceof EffectInputError && /no authoritative financial semantics/.test(error.message));

    assert.throws(() => authoritativeConsequenceMetadata(OKTA_EFFECT_NAME, { amount_minor: 1 }), EffectInputError);

    // And a valid GitHub input yields no amount at all.
    const metadata = authoritativeConsequenceMetadata(GITHUB_EFFECT_NAME, {
      owner: "nyst", repository: "fixture", principal: "alice", desired_permission: "write", credential_ref: "env:NYST_GITHUB_TOKEN",
    });
    assert.equal(metadata.amount_minor, null);
    assert.equal(metadata.currency, null);
    assert.equal(metadata.budget_semantics, "count_only");
    assert.equal(effectSemantics(GITHUB_EFFECT_NAME)!.budget_semantics, "count_only");
    assert.equal(effectSemantics(OKTA_EFFECT_NAME)!.budget_semantics, "count_only");
  });

  it("1G: a malformed Stripe input is refused, and missing amount or currency fails closed", () => {
    assert.throws(() => authoritativeConsequenceMetadata(STRIPE_REFUND_EFFECT, { payment_intent_id: "not-a-pi" }), EffectInputError);
    // Missing amount: refused, never treated as zero.
    assert.throws(() => authoritativeConsequenceMetadata(STRIPE_REFUND_EFFECT, {
      payment_intent_id: "pi_fixture_0001", charge_id: "ch_fixture_0001", currency: "usd", credential_ref: "env:NYST_STRIPE_CREDENTIAL",
    }), (error: unknown) => error instanceof EffectInputError && /amount/.test(error.message));
    // Missing currency: refused.
    assert.throws(() => authoritativeConsequenceMetadata(STRIPE_REFUND_EFFECT, {
      payment_intent_id: "pi_fixture_0001", charge_id: "ch_fixture_0001", amount_minor: 500, credential_ref: "env:NYST_STRIPE_CREDENTIAL",
    }), EffectInputError);
    // Zero is not a valid amount either: it is not a consequence worth issuing,
    // and accepting it would pass every monetary budget.
    assert.throws(() => authoritativeConsequenceMetadata(STRIPE_REFUND_EFFECT, {
      payment_intent_id: "pi_fixture_0001", charge_id: "ch_fixture_0001", amount_minor: 0, currency: "usd", credential_ref: "env:NYST_STRIPE_CREDENTIAL",
    }), EffectInputError);

    const valid = authoritativeConsequenceMetadata(STRIPE_REFUND_EFFECT, {
      payment_intent_id: "pi_fixture_0001", charge_id: "ch_fixture_0001", amount_minor: 500, currency: "usd", credential_ref: "env:NYST_STRIPE_CREDENTIAL",
    });
    assert.deepEqual(valid, { amount_minor: 500, currency: "usd", budget_semantics: "monetary" });
    // The EffectSpec's own schema is the authority on shape, and it requires a
    // lowercase ISO-4217 code. Nyst does not quietly repair a caller's input
    // before deciding how much money is at stake.
    assert.throws(() => authoritativeConsequenceMetadata(STRIPE_REFUND_EFFECT, {
      payment_intent_id: "pi_fixture_0001", charge_id: "ch_fixture_0001", amount_minor: 500, currency: "USD", credential_ref: "env:NYST_STRIPE_CREDENTIAL",
    }), EffectInputError);
  });

  it("1G: an aggregate monetary budget fails closed on an action with no amount", async () => {
    const isolated = { ...tenant, environment_id: await repository.createEnvironment(tenant, "Aggregate case", `aggregate-${suffix}`) };
    await repository.createBlastRadiusBudget(isolated, tenant.user_id, {
      agent_id: null, effect_name: fakeEffect, window_seconds: 3600,
      max_actions_per_window: null, max_amount_minor_per_action: null,
      // Only an aggregate limit. The previous SQL added coalesce(amount, 0) to
      // the window total, so an amount-free action passed this budget every
      // time, no matter how low the limit.
      max_amount_minor_per_window: 1000, currency: "usd",
    });
    const decision = await repository.admitConsequence(isolated, {
      agent_id: null, effect_name: fakeEffect, business_key: `aggregate-${suffix}`, amount_minor: null, currency: null,
    });
    assert.equal(decision.admitted, false, "MISSING AMOUNT WAS TREATED AS ZERO against an aggregate monetary budget");
    assert.equal(decision.blocked_by, "blast_radius");
    assert.match(decision.reason, /no authoritative amount|no authoritative currency/);
  });

  it("1G: a mismatched currency is refused, and a matching one is admitted", async () => {
    const isolated = { ...tenant, environment_id: await repository.createEnvironment(tenant, "Currency case", `currency-${suffix}`) };
    await repository.createBlastRadiusBudget(isolated, tenant.user_id, {
      agent_id: null, effect_name: STRIPE_REFUND_EFFECT, window_seconds: 3600,
      max_actions_per_window: null, max_amount_minor_per_action: 10_000, max_amount_minor_per_window: null, currency: "usd",
    });
    const mismatched = await repository.admitConsequence(isolated, {
      agent_id: null, effect_name: STRIPE_REFUND_EFFECT, business_key: `currency-eur-${suffix}`, amount_minor: 500, currency: "eur",
    });
    assert.equal(mismatched.admitted, false);
    assert.match(mismatched.reason, /currency/);

    const matched = await repository.admitConsequence(isolated, {
      agent_id: null, effect_name: STRIPE_REFUND_EFFECT, business_key: `currency-usd-${suffix}`, amount_minor: 500, currency: "usd",
    });
    assert.equal(matched.admitted, true);
  });

  it("1G: per-action and aggregate monetary limits both bite", async () => {
    const isolated = { ...tenant, environment_id: await repository.createEnvironment(tenant, "Monetary case", `monetary-${suffix}`) };
    await repository.createBlastRadiusBudget(isolated, tenant.user_id, {
      agent_id: null, effect_name: STRIPE_REFUND_EFFECT, window_seconds: 3600,
      max_actions_per_window: null, max_amount_minor_per_action: 1_000, max_amount_minor_per_window: 1_500, currency: "usd",
    });
    const tooBig = await repository.admitConsequence(isolated, {
      agent_id: null, effect_name: STRIPE_REFUND_EFFECT, business_key: `too-big-${suffix}`, amount_minor: 1_001, currency: "usd",
    });
    assert.equal(tooBig.admitted, false);
    assert.equal(tooBig.limit_kind, "amount_per_action");

    assert.equal((await repository.admitConsequence(isolated, {
      agent_id: null, effect_name: STRIPE_REFUND_EFFECT, business_key: `first-${suffix}`, amount_minor: 1_000, currency: "usd",
    })).admitted, true);
    const overWindow = await repository.admitConsequence(isolated, {
      agent_id: null, effect_name: STRIPE_REFUND_EFFECT, business_key: `second-${suffix}`, amount_minor: 1_000, currency: "usd",
    });
    assert.equal(overWindow.admitted, false);
    assert.equal(overWindow.limit_kind, "amount_per_window");
  });

  for (const concurrency of [2, 10, 100]) {
    it(`1G: ${concurrency} concurrent admissions against one budget admit exactly the limit`, async () => {
      const limit = Math.max(1, Math.floor(concurrency / 2));
      const isolated = { ...tenant, environment_id: await repository.createEnvironment(tenant, `Race ${concurrency}`, `race-${concurrency}-${suffix}`) };
      await repository.createBlastRadiusBudget(isolated, tenant.user_id, {
        agent_id: null, effect_name: fakeEffect, window_seconds: 3600,
        max_actions_per_window: limit, max_amount_minor_per_action: null, max_amount_minor_per_window: null, currency: null,
      });
      const results = await Promise.all(Array.from({ length: concurrency }, (_unused, index) =>
        repository.admitConsequence(isolated, {
          agent_id: null, effect_name: fakeEffect, business_key: `race-${concurrency}-${index}-${suffix}`, amount_minor: null, currency: null,
        })));
      const admitted = results.filter((item) => item.admitted).length;
      assert.equal(admitted, limit,
        `${admitted} of ${concurrency} concurrent admissions were admitted against a budget of ${limit}`);
    });
  }

  /* ============================================================ 1H */

  it("1H THE CASE: no Slack affordance claims to do something a link cannot do", () => {
    const incidentId = randomUUID();
    const message = buildHumanReviewMessage({
      action_id: randomUUID(), incident_id: incidentId, agent_name: "Agent A", effect_name: fakeEffect,
      environment: "Production", effect_state: "unprovable", control_primary: "escalate",
      reason: "Nyst could not establish what happened.", incident_url: "https://nyst.example.com/reviews",
      opened_at: new Date().toISOString(),
    }, "env:NYST_SLACK_WEBHOOK");
    const serialized = JSON.stringify(message);

    assert.doesNotMatch(serialized, /intent=reobserve/, "the dead query parameter came back");
    assert.doesNotMatch(serialized, /"Request re-observation"/,
      "a Slack link may not claim to request anything: clicking it requests nothing");
    const actions = (message.blocks as Array<{ type: string; elements?: Array<{ url?: string }> }>)
      .find((block) => block.type === "actions");
    assert.ok(actions?.elements?.length);
    for (const element of actions!.elements!) {
      assert.ok(element.url, "every Slack affordance must be a link");
      assert.doesNotMatch(String(element.url), /[?&]/,
        "Nyst must not mutate through URL query parameters, and a link previewer will fetch this");
    }
    assert.match(serialized, new RegExp(`/reviews${incidentFragment(incidentId).replace("#", "#")}`),
      "the second affordance must deep-link to the real control");
  });

  it("1H: the incident the fragment names actually exists in the rendered page, and the client focuses it", () => {
    const dashboard = readFileSync(resolve(process.cwd(), "src/product/dashboard.ts"), "utf8");
    assert.match(dashboard, /id="review-\$\{escape\(String\(incident\.incident_id\)\)\}"/,
      "the reviews page has no anchor for the fragment Slack links to");
    const assets = readFileSync(resolve(process.cwd(), "src/product/assets.ts"), "utf8");
    assert.match(assets, /review-\[A-Za-z0-9_-\]\+/, "nothing honours the deep-link fragment");
    assert.match(assets, /request_reobservation/, "the deep link does not focus the real re-observation control");
    // And nothing anywhere reads an intent query parameter.
    for (const file of ["src/product/server.ts", "src/product/assets.ts", "src/product/dashboard.ts"]) {
      assert.doesNotMatch(readFileSync(resolve(process.cwd(), file), "utf8"), /intent=reobserve|\bintent\b\s*===\s*"reobserve"/,
        `${file} reads an intent query parameter, which is mutation through a URL`);
    }
  });
});
