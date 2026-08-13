/**
 * Nyst v0.3.0 — Phases 28-31. THE AUTHORITY LAYER.
 *
 * AUTHORITY answers "what may this Agent do?". It is not EFFECT ("what
 * happened") and not OUTCOME ("what became true"), and the three must never
 * blur — which is exactly what these tests are for.
 *
 * The adversarial cases are the point of the file:
 *
 *   - an exception must never change what Nyst observed
 *   - an exception must never rescue a FREEZE or a Blast Radius refusal
 *   - an exception for $1,000 must not authorize $1,001
 *   - half an authorization is not an authorization
 *   - a grant must die the moment the world is re-observed
 *   - an Agent with no Autonomy Line rule has NO autonomy, not unlimited
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { AuthorityRepository } from "../src/product/authority/authorityRepository.js";
import { evaluateAuthority, type AuthorityRequest } from "../src/product/authority/canonicalAuthority.js";
import { evaluateAutonomyLine, type AutonomyRule } from "../src/product/authority/autonomyLine.js";
import type { EffectiveAuthority } from "../src/product/effectiveAuthority.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

/** A runtime authority that permits everything, so the test isolates one layer. */
const PERMISSIVE: EffectiveAuthority = {
  primary: "continue", retry: "forbidden", continuation: "allowed", recovery: "none",
  automatic_continuation_allowed: true, automatic_compensation_allowed: true,
  automatic_retry_allowed: false, reductions: [],
};

/** The baseline request: everything permits, so any refusal is the layer under test. */
function baseRequest(overrides: Partial<AuthorityRequest> = {}): AuthorityRequest {
  return {
    agent_id: "agent-1", effect_name: "stripe.refund", amount_minor: 10_000, currency: "usd",
    runtime_authority: PERMISSIVE, policy_version_id: "policy-1",
    autonomy_rules: [],
    autonomy: {
      outcome_spec: null, resource_class: null, reversible: true,
      actions_in_window: 0, amount_in_window_minor: 0, open_incident: false, outcome_satisfied: null,
    },
    blast_radius: { admitted: true, budget_id: null, reason: "Every applicable consequence budget has headroom." },
    freeze: { frozen: false, freeze_id: null, scope_description: null },
    rollout: { mode: "enforced", controlled: true, reason: "The environment is Enforced." },
    outcome_dependency: null,
    exceptions: [],
    ...overrides,
  };
}

function rule(overrides: Partial<AutonomyRule> = {}): AutonomyRule {
  return {
    autonomy_rule_id: randomUUID(), agent_id: null, effect_name: null, outcome_spec: null, resource_class: null,
    max_amount_minor: null, currency: null, max_actions_per_window: null, max_amount_minor_per_window: null,
    window_seconds: null, requires_reversible: false, requires_no_open_incident: false,
    requires_outcome_satisfied: null, disposition: "autonomous", rationale: "Test rule.",
    ...overrides,
  };
}

describe("Nyst v0.3.0 Phases 28-31 — the authority layer", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let authority: AuthorityRepository;
  let tenant: TenantScope & { user_id: string };
  let signer: Ed25519Signer;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    authority = new AuthorityRepository(pool);
    signer = Ed25519Signer.ephemeral("grants");
    tenant = await repository.createBootstrap({
      organization: "Authority", organization_slug: `authority-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `authority-${suffix}@test.test`, display_name: "Authority", password: "Nyst v030 authority fixture 23!",
    });
  });
  after(async () => { await store.close(); await pool.end(); });

  /* ===================================================== THE AUTONOMY LINE */

  it("an Agent with no Autonomy Line rule has NO autonomy, not unlimited autonomy", () => {
    const determination = evaluateAutonomyLine([], {
      agent_id: "agent-1", effect_name: "stripe.refund", outcome_spec: null, resource_class: null,
      amount_minor: 100, currency: "usd", reversible: true,
      actions_in_window: 0, amount_in_window_minor: 0, open_incident: false, outcome_satisfied: null,
    });
    assert.equal(determination.disposition, "human", "AN UNDESCRIBED AGENT WAS GIVEN AUTONOMY");
    assert.equal(determination.decided_by, "no_rule_configured");
    assert.match(determination.reason, /has no autonomy, not unlimited autonomy/);
  });

  it("it is not a trust score: revoke may be autonomous while grant needs a person", () => {
    const rules = [
      rule({ agent_id: "hr-agent", effect_name: "github.revoke", disposition: "autonomous", rationale: "Removing access is safe." }),
      rule({ agent_id: "hr-agent", effect_name: "github.grant", disposition: "human", rationale: "Granting access is not." }),
      rule({ agent_id: "hr-agent", effect_name: "aws.mutate", disposition: "disabled", rationale: "This Agent has no AWS mandate." }),
    ];
    const ask = (effect: string) => evaluateAutonomyLine(rules, {
      agent_id: "hr-agent", effect_name: effect, outcome_spec: null, resource_class: null,
      amount_minor: null, currency: null, reversible: true,
      actions_in_window: 0, amount_in_window_minor: 0, open_incident: false, outcome_satisfied: null,
    });
    // A single 0-100 score cannot express this, and the difference between
    // these two is the whole safety question.
    assert.equal(ask("github.revoke").disposition, "autonomous");
    assert.equal(ask("github.grant").disposition, "human");
    assert.equal(ask("aws.mutate").disposition, "disabled");
    // And no number appears anywhere in the module.
    const source = readFileSync(resolve(process.cwd(), "src/product/authority/autonomyLine.ts"), "utf8");
    assert.doesNotMatch(source, /trust_score|trustScore|0\s*(to|-|–)\s*100/i, "a trust score appeared in the Autonomy Line");
  });

  it("the most specific rule wins, deterministically", () => {
    const broad = rule({ disposition: "autonomous", rationale: "Everything is fine." });
    const narrow = rule({ agent_id: "agent-1", effect_name: "stripe.refund", disposition: "human", rationale: "Refunds need a person." });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const determination = evaluateAutonomyLine([broad, narrow], {
        agent_id: "agent-1", effect_name: "stripe.refund", outcome_spec: null, resource_class: null,
        amount_minor: 100, currency: "usd", reversible: true,
        actions_in_window: 0, amount_in_window_minor: 0, open_incident: false, outcome_satisfied: null,
      });
      assert.equal(determination.disposition, "human");
      assert.equal(determination.rule?.autonomy_rule_id, narrow.autonomy_rule_id);
    }
  });

  it("every bound narrows, and each names the dimension that decided it", () => {
    const bounded = rule({
      agent_id: "agent-1", effect_name: "stripe.refund", disposition: "autonomous",
      max_amount_minor: 30_000, currency: "usd",
      max_actions_per_window: 15, max_amount_minor_per_window: 500_000, window_seconds: 3600,
      rationale: "Support refunds up to 300.00 USD.",
    });
    const ask = (overrides: Partial<Parameters<typeof evaluateAutonomyLine>[1]>) => evaluateAutonomyLine([bounded], {
      agent_id: "agent-1", effect_name: "stripe.refund", outcome_spec: null, resource_class: null,
      amount_minor: 10_000, currency: "usd", reversible: true,
      actions_in_window: 0, amount_in_window_minor: 0, open_incident: false, outcome_satisfied: null,
      ...overrides,
    });
    assert.equal(ask({}).disposition, "autonomous");

    assert.equal(ask({ amount_minor: 30_001 }).decided_by, "amount_per_action");
    assert.match(ask({ amount_minor: 30_001 }).reason, /300\.00 USD/);
    assert.equal(ask({ actions_in_window: 15 }).decided_by, "action_count_window");
    assert.equal(ask({ amount_in_window_minor: 495_000 }).decided_by, "amount_window");
    assert.equal(ask({ currency: "eur" }).decided_by, "currency_mismatch");
    // FAIL CLOSED on a missing amount against a monetary bound.
    assert.equal(ask({ amount_minor: null }).decided_by, "amount_per_action");
    assert.match(ask({ amount_minor: null }).reason, /will not treat a missing amount as zero/);
    for (const determination of [ask({ amount_minor: 30_001 }), ask({ actions_in_window: 15 })]) {
      assert.equal(determination.disposition, "human", "a bound blocked outright instead of asking a person");
    }
  });

  it("reversibility, open incidents and outcome dependencies each narrow autonomy", () => {
    const careful = rule({
      disposition: "autonomous", requires_reversible: true, requires_no_open_incident: true,
      requires_outcome_satisfied: "employee_offboarding", rationale: "Careful rule.",
    });
    const ask = (overrides: Partial<Parameters<typeof evaluateAutonomyLine>[1]>) => evaluateAutonomyLine([careful], {
      agent_id: "agent-1", effect_name: "github.revoke", outcome_spec: null, resource_class: null,
      amount_minor: null, currency: null, reversible: true,
      actions_in_window: 0, amount_in_window_minor: 0, open_incident: false, outcome_satisfied: true,
      ...overrides,
    });
    assert.equal(ask({}).disposition, "autonomous");
    assert.equal(ask({ reversible: false }).decided_by, "reversibility");
    // Unknown reversibility is treated exactly like irreversible. Nyst does
    // not extend autonomy on the strength of not having checked.
    assert.equal(ask({ reversible: null }).decided_by, "reversibility");
    assert.match(ask({ reversible: null }).reason, /does not know/);
    assert.equal(ask({ open_incident: true }).decided_by, "open_incident");
    assert.equal(ask({ outcome_satisfied: false }).decided_by, "outcome_not_satisfied");
    assert.equal(ask({ outcome_satisfied: null }).decided_by, "outcome_not_satisfied");
  });

  /* ============================================ THE CANONICAL EVALUATOR */

  it("effective authority is an INTERSECTION: any one layer refusing is enough", () => {
    assert.equal(evaluateAuthority(baseRequest({
      autonomy_rules: [rule({ disposition: "autonomous", rationale: "ok" })],
    })).disposition, "allowed", "the permissive baseline should be allowed");

    const layers: Array<[string, Partial<AuthorityRequest>, "held" | "blocked"]> = [
      ["freeze", { freeze: { frozen: true, freeze_id: "f1", scope_description: "this Agent" } }, "blocked"],
      ["blast radius", { blast_radius: { admitted: false, budget_id: "b1", reason: "The consequence budget is exhausted." } }, "blocked"],
      ["EffectSpec safety", { runtime_authority: { ...PERMISSIVE, primary: "escalate" } }, "blocked"],
      ["rollout", { rollout: { mode: "shadow", controlled: false, reason: "This workload is in Shadow; Nyst is not controlling it." } }, "held"],
      ["autonomy line", { autonomy_rules: [rule({ disposition: "human", rationale: "needs a person" })] }, "held"],
    ];
    for (const [name, override, expected] of layers) {
      const decision = evaluateAuthority(baseRequest({
        autonomy_rules: [rule({ disposition: "autonomous", rationale: "ok" })], ...override,
      }));
      assert.equal(decision.disposition, expected, `${name} did not narrow effective authority`);
      assert.ok(decision.primary_reason.length > 20, `${name} gave no usable reason`);
    }
  });

  it("every layer's answer is named, so nobody has to guess which one bit", () => {
    const decision = evaluateAuthority(baseRequest({
      autonomy_rules: [rule({ disposition: "autonomous", rationale: "ok" })],
      freeze: { frozen: true, freeze_id: "f1", scope_description: "the whole environment" },
    }));
    const layers = decision.reasons.map((item) => item.layer);
    for (const required of ["effectspec_safety", "customer_policy", "freeze", "blast_radius", "rollout", "autonomy_line"]) {
      assert.ok(layers.includes(required as never), `the decision does not report the ${required} layer`);
    }
    assert.equal(decision.freeze_id, "f1");
    assert.match(decision.primary_reason, /Emergency Freeze/);
  });

  /* ======================================================== EXCEPTIONS */

  it("AN EXCEPTION CANNOT RESCUE A FREEZE OR A BLAST RADIUS REFUSAL", () => {
    const exception = {
      exception_id: "e1", kind: "break_glass",
      authorizes: "action_requiring_human_approval" as const,
      max_amount_minor: null, currency: null,
      actor: "jane@example.test", actor_role: "Security",
      reason: "INC-812 requires immediate action.", reference: "INC-812",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };
    for (const [name, override] of [
      ["a freeze", { freeze: { frozen: true, freeze_id: "f1", scope_description: "the whole environment" } }],
      ["an exhausted budget", { blast_radius: { admitted: false, budget_id: "b1", reason: "exhausted" } }],
      ["the EffectSpec safety floor", { runtime_authority: { ...PERMISSIVE, primary: "escalate" as const } }],
    ] as const) {
      const decision = evaluateAuthority(baseRequest({
        autonomy_rules: [rule({ disposition: "human", rationale: "needs a person" })],
        exceptions: [exception], ...override,
      }));
      assert.equal(decision.disposition, "blocked",
        `A HUMAN EXCEPTION OVERRODE ${name.toUpperCase()}`);
    }
  });

  it("an exception for $1,000 does not authorize $1,001", () => {
    const bounded = rule({
      disposition: "autonomous", max_amount_minor: 30_000, currency: "usd", rationale: "Refunds up to 300.00 USD.",
    });
    const exception = {
      exception_id: "e1", kind: "temporary_grant", authorizes: "amount_above_autonomy_line" as const,
      max_amount_minor: 100_000, currency: "usd",
      actor: "jane@example.test", actor_role: "Security",
      reason: "INC-812: allow up to 1000.00 for 60 minutes.", reference: "INC-812",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };
    const ask = (amount: number) => evaluateAuthority(baseRequest({
      amount_minor: amount, autonomy_rules: [bounded], exceptions: [exception],
    }));
    assert.equal(ask(20_000).disposition, "allowed", "within the normal line");
    assert.equal(ask(100_000).disposition, "allowed", "exactly at the exception ceiling");
    assert.equal(ask(100_001).disposition, "held", "AN EXCEPTION FOR 1000.00 AUTHORIZED 1000.01");
    // And an exception in the wrong currency does not apply at all.
    assert.equal(evaluateAuthority(baseRequest({
      amount_minor: 50_000, currency: "eur", autonomy_rules: [bounded], exceptions: [exception],
    })).disposition, "held");
  });

  it("half an authorization is not an authorization", () => {
    // The Autonomy Line holds it for an amount AND the outcome is
    // indeterminate. An exception addressing only the amount releases neither.
    const decision = evaluateAuthority(baseRequest({
      amount_minor: 50_000,
      autonomy_rules: [rule({ disposition: "autonomous", max_amount_minor: 30_000, currency: "usd", rationale: "limit" })],
      outcome_dependency: {
        outcome_instance_id: "o1", verdict: "indeterminate",
        grant_id: null, grant_valid: false, grant_invalid_reason: null,
      },
      exceptions: [{
        exception_id: "e1", kind: "temporary_grant", authorizes: "amount_above_autonomy_line",
        max_amount_minor: 100_000, currency: "usd",
        actor: "jane@example.test", actor_role: "Security", reason: "INC-812 amount only.", reference: "INC-812",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }],
    }));
    assert.equal(decision.disposition, "held",
      "AN EXCEPTION COVERING ONE HELD LAYER RELEASED AN ACTION HELD BY TWO");
  });

  it("an exception authorizes continuation, and the outcome stays exactly as observed", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const subject = {
      person_email: `held-${suffix}@example.test`, github_login: "held",
      github_repository: "nyst-fixtures/production", okta_user_id: "00uheldfixture",
    };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject, subject_key: `offboard:${subject.person_email}`,
      mode: "enforced",
    });
    // Nothing observed at all, so the verdict is INDETERMINATE.
    const evaluated = await outcomes.evaluate(tenant, instance.outcome_instance_id);
    assert.equal(evaluated.evaluation.verdict, "indeterminate");

    const exception = await authority.createException(tenant, tenant.user_id, {
      kind: "break_glass", outcome_instance_id: instance.outcome_instance_id,
      authorizes: "continuation_despite_indeterminate_outcome",
      actor_role: "Security", reason: "INC-812: the employee is a confirmed insider threat; continue.",
      reference: "INC-812", expires_in_seconds: 3600,
    });
    assert.ok(exception.exception_id);

    // THE VERDICT DID NOT MOVE. This is the whole point of the layer split.
    const after = await outcomes.instance(tenant, instance.outcome_instance_id);
    assert.equal(after!.verdict, "indeterminate",
      "A HUMAN EXCEPTION CHANGED WHAT NYST OBSERVED");

    // But authority now permits continuation, with the human's name on it.
    const live = await authority.liveExceptions(tenant, { outcome_instance_id: instance.outcome_instance_id });
    const decision = evaluateAuthority(baseRequest({
      autonomy_rules: [rule({ disposition: "autonomous", rationale: "ok" })],
      outcome_dependency: {
        outcome_instance_id: instance.outcome_instance_id, verdict: "indeterminate",
        grant_id: null, grant_valid: false, grant_invalid_reason: null,
      },
      exceptions: live,
    }));
    assert.equal(decision.disposition, "allowed");
    assert.match(decision.reasons.find((item) => item.layer === "exception")!.reason,
      /does not change what Nyst observed/);
    assert.match(decision.reasons.find((item) => item.layer === "exception")!.reason, /INC-812/);
  });

  it("there is no way to mark something verified or declare an outcome satisfied", () => {
    // Structural: the vocabulary simply does not exist. A future contributor
    // adding one has to add it to this list first, which is the point.
    const forbidden = /mark[_ ]?verified|force[_ ]?verified|override[_ ]?verdict|set[_ ]?satisfied|pretend/i;
    const directories = ["src/product", "src/product/authority", "src/product/outcome"];
    for (const directory of directories) {
      for (const file of readdirSync(resolve(process.cwd(), directory)).filter((name) => name.endsWith(".ts"))) {
        const source = readFileSync(resolve(process.cwd(), directory, file), "utf8");
        // Comments explaining that these do not exist are fine; identifiers are not.
        const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n");
        assert.doesNotMatch(code, forbidden, `${directory}/${file} contains an override affordance`);
      }
    }
  });

  it("exceptions are attributed, time-limited, immutable and revocable", async () => {
    await assert.rejects(() => authority.createException(tenant, tenant.user_id, {
      kind: "temporary_grant", authorizes: "amount_above_autonomy_line", max_amount_minor: 1000, currency: "usd",
      actor_role: "Security", reason: "short", expires_in_seconds: 600,
    }), /reason/, "an exception without a real reason was accepted");

    await assert.rejects(() => authority.createException(tenant, tenant.user_id, {
      kind: "temporary_grant", authorizes: "amount_above_autonomy_line", max_amount_minor: 1000, currency: "usd",
      actor_role: "Security", reason: "A perfectly good reason for this.", expires_in_seconds: 90_000,
    }), /24 hours/, "a permanent exception was accepted");

    await assert.rejects(() => authority.createException(tenant, tenant.user_id, {
      kind: "break_glass", authorizes: "action_requiring_human_approval",
      actor_role: "Security", reason: "An unscoped emergency authorization.", expires_in_seconds: 600,
    }), /must name what it applies to/, "an unscoped break-glass was accepted");

    const created = await authority.createException(tenant, tenant.user_id, {
      kind: "temporary_grant", effect_name: "stripe.refund",
      authorizes: "amount_above_autonomy_line", max_amount_minor: 100_000, currency: "usd",
      actor_role: "Security", reason: "INC-812: allow up to 1000.00 for 60 minutes.", reference: "INC-812",
      expires_in_seconds: 3600,
    });
    await assert.rejects(
      () => pool.query(`UPDATE nyst_authority_exceptions SET max_amount_minor=999999999 WHERE exception_id=$1`, [created.exception_id]),
      /immutable/, "an exception was edited after the fact");
    await assert.rejects(
      () => pool.query(`DELETE FROM nyst_authority_exceptions WHERE exception_id=$1`, [created.exception_id]),
      /immutable/);

    assert.equal(await authority.revokeException(tenant, tenant.user_id, String(created.exception_id), "The incident is closed."), true);
    const live = await authority.liveExceptions(tenant, { effect_name: "stripe.refund" });
    assert.ok(!live.some((item) => item.exception_id === created.exception_id), "a revoked exception is still live");
    // The record survives revocation, because the audit trail is the product.
    const history = await authority.exceptionHistory(tenant);
    assert.ok(history.some((item) => String(item.exception_id) === String(created.exception_id)));
  });

  /* ================================================= CONTINUATION GRANTS */

  it("a grant on a non-satisfied outcome requires a named human exception", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const subject = {
      person_email: `grant-${suffix}@example.test`, github_login: "grantsubject",
      github_repository: "nyst-fixtures/production", okta_user_id: "00ugrantfixture",
    };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject, subject_key: `offboard:${subject.person_email}`,
      mode: "enforced",
    });
    await outcomes.evaluate(tenant, instance.outcome_instance_id);

    await assert.rejects(() => authority.issueGrant(tenant, {
      outcome_instance_id: instance.outcome_instance_id,
      permitted_effects: ["github.repository_permission_change"],
      resource_scope: ["github:nyst-fixtures/production"],
      expires_in_seconds: 600,
    }, signer), /requires an explicit, attributed human exception/,
      "A GRANT WAS ISSUED ON AN UNOBSERVED OUTCOME WITH NOBODY'S NAME ON IT");
  });

  it("a grant is narrow, signed, single-use, and dies when the world is re-observed", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const subject = {
      person_email: `good-${suffix}@example.test`, github_login: "goodsubject",
      github_repository: "nyst-fixtures/production", okta_user_id: "00ugoodfixture",
    };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject, subject_key: `offboard:${subject.person_email}`,
      mode: "enforced",
    });
    const githubSubject = `github:${subject.github_repository}:${subject.github_login}`;
    const oktaSubject = `okta:user:${subject.okta_user_id}`;
    const now = new Date();
    for (const [ref, provider, property, value] of [
      [githubSubject, "github", "effective_permission", "none"],
      [oktaSubject, "okta", "account_status", "SUSPENDED"],
    ] as const) {
      await outcomes.recordFact(tenant, {
        subject_ref: ref, provider, property, value: { type: "string", value },
        observed_at: now.toISOString(), fresh_until: new Date(now.getTime() + 900_000).toISOString(),
        source_type: "provider_api_read", authoritative: true, adapter_version: "test/1.0.0",
      });
    }
    const evaluated = await outcomes.evaluate(tenant, instance.outcome_instance_id);
    assert.equal(evaluated.evaluation.verdict, "satisfied");

    const grant = await authority.issueGrant(tenant, {
      agent_id: null,
      outcome_instance_id: instance.outcome_instance_id,
      permitted_effects: ["github.repository_permission_change"],
      resource_scope: [githubSubject],
      expires_in_seconds: 600,
    }, signer);
    const grantId = String(grant.grant_id);

    // Signed, and verifiable.
    assert.equal(signer.verify(grant.payload, {
      algorithm: "ed25519", canonicalization: "ojc-1",
      key_id: String(grant.key_id), signature_b64: String(grant.signature),
    }), true, "the ContinuationGrant signature does not verify");

    const valid = { agent_id: null, effect_name: "github.repository_permission_change", resource_ref: githubSubject,
      outcome_instance_id: instance.outcome_instance_id };
    assert.equal((await authority.validateGrant(tenant, grantId, valid)).valid, true);

    // NARROW: wrong effect, wrong resource, wrong outcome are each refused,
    // and each says which one.
    assert.match((await authority.validateGrant(tenant, grantId, { ...valid, effect_name: "okta.user_suspension_change" })).reason!,
      /permits github/);
    assert.match((await authority.validateGrant(tenant, grantId, { ...valid, resource_ref: "github:other/repo:someone" })).reason!,
      /covers github:nyst-fixtures/);

    // SINGLE USE.
    assert.equal(await authority.consumeGrant(tenant, grantId), true);
    assert.equal(await authority.consumeGrant(tenant, grantId), false, "a grant was consumed twice");
    assert.match((await authority.validateGrant(tenant, grantId, valid)).reason!, /already been consumed/);

    // AND THE IMPORTANT ONE: a fresh grant dies the moment the world is
    // re-observed, because the evidence it rested on is no longer current.
    const second = await authority.issueGrant(tenant, {
      outcome_instance_id: instance.outcome_instance_id,
      permitted_effects: ["github.repository_permission_change"], resource_scope: [githubSubject],
      expires_in_seconds: 600,
    }, signer);
    assert.equal((await authority.validateGrant(tenant, String(second.grant_id), valid)).valid, true);
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const stale = await authority.validateGrant(tenant, String(second.grant_id), valid);
    assert.equal(stale.valid, false, "A GRANT SURVIVED A RE-OBSERVATION OF THE WORLD");
    assert.match(stale.reason!, /re-evaluated since this grant was issued/);
  });

  it("there are no broad permanent grants", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const subject = {
      person_email: `broad-${suffix}@example.test`, github_login: "broadsubject",
      github_repository: "nyst-fixtures/production", okta_user_id: "00ubroadfixture",
    };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject, subject_key: `offboard:${subject.person_email}`,
      mode: "enforced",
    });
    for (const [bad, pattern] of [
      [{ expires_in_seconds: 7200 }, /within one hour/],
      [{ permitted_effects: [] }, /must name the effects/],
      [{ resource_scope: [] }, /must name the effects/],
    ] as const) {
      await assert.rejects(() => authority.issueGrant(tenant, {
        outcome_instance_id: instance.outcome_instance_id,
        permitted_effects: ["github.repository_permission_change"],
        resource_scope: ["github:nyst-fixtures/production"],
        ...{ expires_in_seconds: 600 },
        ...bad,
      }, signer), pattern);
    }
  });

  /* ============================================== ONE EVALUATOR, NO CLONES */

  it("there is exactly ONE authority evaluator, and no parallel implementation", () => {
    const directory = resolve(process.cwd(), "src/product");
    const offenders: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) { walk(resolve(path, entry.name)); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const full = resolve(path, entry.name);
        if (full.endsWith("canonicalAuthority.ts")) continue;
        const source = readFileSync(full, "utf8");
        const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n");
        // A second function that returns an allowed/held/blocked verdict is a
        // parallel authority implementation, and one of the two will
        // eventually be the more permissive.
        if (/function\s+\w*[Aa]uthority\w*\s*\([^)]*\)\s*:\s*\w*Decision/.test(code)) {
          offenders.push(`${entry.name}: a second authority evaluator`);
        }
      }
    };
    walk(directory);
    assert.deepEqual(offenders, [], `parallel authority implementations exist:\n${offenders.join("\n")}`);
  });

  it("an authority decision is recorded with every input that produced it", async () => {
    // A real persisted rule, so the recorded decision genuinely references the
    // rule that produced it rather than a detached identifier.
    const persisted = await authority.createAutonomyRule(tenant, tenant.user_id, {
      effect_name: "stripe.refund", disposition: "human",
      rationale: "Refunds above the line need a person.",
    });
    const decision = evaluateAuthority(baseRequest({
      policy_version_id: null, autonomy_rules: [persisted],
    }));
    assert.equal(decision.disposition, "held");
    assert.equal(decision.autonomy.rule?.autonomy_rule_id, persisted.autonomy_rule_id);
    await authority.recordDecision(tenant, {
      agent_id: null, effect_name: "stripe.refund", decision,
    });
    const recorded = (await authority.decisions(tenant))[0]!;
    assert.equal(recorded.disposition, "held");
    const reasons = recorded.reasons as Array<{ layer: string; reason: string }>;
    assert.ok(reasons.length >= 6, "the recorded decision does not name every layer");
    await assert.rejects(
      () => pool.query(`UPDATE nyst_authority_decisions SET disposition='allowed' WHERE authority_decision_id=$1`,
        [recorded.authority_decision_id]),
      /append-only/, "an authority decision was rewritten after the fact");
  });
});
