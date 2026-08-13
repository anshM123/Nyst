/**
 * Nyst v0.3.0 — Phases 18-26. THE FLAGSHIP OUTCOME SCENARIO.
 *
 * Alice is leaving. The HR Offboarding Agent removes her direct access to the
 * production repository. GitHub accepts it. The response is lost, so Nyst
 * cannot tell whether it applied — it refuses to blindly retry, reads back,
 * and establishes that the direct grant is gone.
 *
 * THE ACTION IS VERIFIED.
 *
 * Alice is also in a team that grants WRITE to the same repository. Her
 * EFFECTIVE access is still WRITE. Every log in the customer's stack says the
 * offboarding succeeded.
 *
 *     ACTION VERIFIED.  OUTCOME UNSATISFIED.
 *
 * That sentence is the entire reason the outcome layer exists, and this file
 * is the proof that Nyst actually says it.
 *
 * The scenario then continues: a human authorizes the supported remediation,
 * the inherited path is removed, Okta is suspended and observed SUSPENDED, and
 * only when every required invariant has fresh authoritative evidence does the
 * verdict become SATISFIED and a signed Outcome Receipt get issued.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { EMPLOYEE_OFFBOARDING_PACK, dependencyOrder } from "../src/product/outcome/outcomePacks.js";
import { OUTCOME_VERDICTS } from "../src/product/outcome/invariantEngine.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { EffectSpecDescriptor, TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const ADAPTER = "github-adapter/1.0.0";

describe("Nyst v0.3.0 — the flagship Employee Offboarding outcome", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let tenant: TenantScope & { user_id: string };
  let product: ReturnType<typeof createProductProviderRuntime>;
  let descriptors: readonly EffectSpecDescriptor[];
  let effect: string;
  let agentId: string;
  let signer: Ed25519Signer;
  const suffix = randomUUID().slice(0, 8);

  /** Alice, and the two subject references her invariants are about. */
  const alice = {
    person_email: "alice@example.test",
    github_login: "alice",
    github_repository: "nyst-fixtures/production",
    okta_user_id: "00ualicefixture",
  };
  const githubSubject = `github:${alice.github_repository}:${alice.github_login}`;
  const oktaSubject = `okta:user:${alice.okta_user_id}`;

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    signer = Ed25519Signer.ephemeral("outcome-receipts");
    tenant = await repository.createBootstrap({
      organization: "Alice Co", organization_slug: `alice-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `alice-admin-${suffix}@test.test`, display_name: "Admin", password: "Nyst v030 alice fixture 23!",
    });
    product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("alice"), new MutableClock(),
      { production: false, enable_development_fake: true });
    descriptors = product.descriptors;
    effect = descriptors.find((item) => item.provider === "fake")!.effect_name;
    await repository.configureEffectSpec(tenant, descriptors.find((item) => item.effect_name === effect)!, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, {
      effect_name: null, execution_mode: "automatic", auto_continuation: true,
      auto_compensation: true, reconcile_timeout_seconds: 3600,
    });
    agentId = String((await repository.createAgent(tenant, tenant.user_id, {
      name: "HR Offboarding Agent", slug: `hr-offboarding-${suffix}`, owner: "People Ops",
      description: "Runs employee offboarding", framework: "unspecified", tags: ["hr"],
    })).agent_id);
  });
  after(async () => { await store.close(); await pool.end(); });

  /** Record one observation of the world. */
  async function observe(subject: string, provider: string, property: string,
    value: Parameters<OutcomeRepository["recordFact"]>[1]["value"],
    options: { authoritative?: boolean; observedAt?: Date; freshSeconds?: number } = {}) {
    const observedAt = options.observedAt ?? new Date();
    return outcomes.recordFact(tenant, {
      subject_ref: subject, provider, property, value,
      observed_at: observedAt.toISOString(),
      fresh_until: new Date(observedAt.getTime() + (options.freshSeconds ?? 900) * 1000).toISOString(),
      source_type: "provider_api_read",
      authoritative: options.authoritative ?? true,
      adapter_version: ADAPTER,
    });
  }

  it("THE SCENARIO: the action is verified, and the outcome is NOT", async () => {
    /* 1. The Agent requests Employee Offboarding. --------------------------- */
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding", { agent_id: agentId });
    assert.equal(contract.required_invariants.length, 2, "the base pack requires exactly the GitHub and Okta invariants");
    // The pack states what it does NOT cover, before anyone relies on it.
    assert.ok(contract.uncovered.some((item) => /AWS/i.test(item)),
      "the contract does not disclose that AWS is uncovered");
    assert.ok(contract.uncovered.some((item) => /VPN/i.test(item)));
    assert.equal(await outcomes.activateContract(tenant, contract.outcome_contract_id), true);

    /* 2. Nyst persists the OutcomeInstance. -------------------------------- */
    const opened = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, agent_id: agentId,
      subject: alice, subject_key: `offboard:${alice.person_email}`, mode: "enforced",
    });
    assert.equal(opened.created, true);
    const instanceId = opened.instance.outcome_instance_id;
    assert.equal(opened.instance.verdict, "indeterminate", "a brand new outcome starts as INDETERMINATE, not satisfied");
    assert.equal(opened.instance.continuation_disposition, "hold");

    // The same request again is the SAME outcome, not a second offboarding.
    const again = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, agent_id: agentId,
      subject: alice, subject_key: `offboard:${alice.person_email}`, mode: "enforced",
    });
    assert.equal(again.created, false);
    assert.equal(again.instance.outcome_instance_id, instanceId, "a retry created a second offboarding for the same person");

    /* 3-8. The atomic action: applied, response lost, no blind retry, read back. */
    const businessKey = `offboard-github-${suffix}`;
    const admission = await repository.admitConsequence(tenant, {
      agent_id: agentId, effect_name: effect, business_key: businessKey, amount_minor: null, currency: null,
    });
    assert.equal(admission.admitted, true);
    const committed = await product.runtime.commit(effect, `${tenant.environment_id}:${businessKey}`,
      // The scenario in which the provider applied the change and the response
      // never came back. This is the case a naive client retries and duplicates.
      { repository_id: alice.github_repository, principal_id: alice.github_login, desired_permission: "none",
        scenario: "response_lost_after_effect" },
      EMPTY_CONTEXT,
      { establish_dispatch_eligibility: (action) =>
          repository.scopeAction(tenant, action.action_id, businessKey, agentId) });
    await repository.linkAdmission(admission.admission_id, committed.action.action_id);
    await repository.recordResolutionTransition(committed.action.action_id, committed.resolution, "action_commit");
    await outcomes.linkAction(instanceId, committed.action.action_id, "remove_github_direct");

    // Nyst did not blindly retry. It read back, and the effect state came from
    // external truth rather than from the mutation response — which is the
    // whole point, since the mutation response never arrived.
    assert.ok(await repository.actionDetail(tenant, committed.action.action_id), "the action was not persisted");
    const effectState = committed.resolution.effect.state;
    assert.ok(["verified", "satisfied_unattributed"].includes(effectState),
      `the atomic action should be established from read-back; it was ${effectState}`);
    assert.equal(committed.resolution.effect.evidence_strength, "authoritative",
      "the effect state rests on something weaker than an authoritative read");

    // THE ACTION IS VERIFIED. Hold on to that.
    const actionVerified = effectState === "verified" || effectState === "satisfied_unattributed";
    assert.equal(actionVerified, true);

    /* 9-12. Inherited access survives, so the OUTCOME is false. ------------ */
    // The direct grant is gone. That is what the action changed.
    await observe(githubSubject, "github", "direct_permission", { type: "string", value: "none" });
    // The team membership was never touched, and it grants WRITE. Effective
    // access is the union, so this is what Alice can actually do.
    await observe(githubSubject, "github", "effective_permission", { type: "string", value: "write" });
    await observe(githubSubject, "github", "inherited_paths",
      { type: "string_set", value: ["team:production-engineers"] });
    // Okta has not been touched yet.
    await observe(oktaSubject, "okta", "account_status", { type: "string", value: "ACTIVE" });

    const first = await outcomes.evaluate(tenant, instanceId);
    assert.equal(first.evaluation.verdict, "unsatisfied",
      "NYST FAILED TO NOTICE THAT ALICE STILL HAS PRODUCTION ACCESS");
    assert.equal(first.instance.verdict, "unsatisfied");
    assert.equal(first.instance.continuation_disposition, "hold",
      "an unsatisfied outcome must not permit automatic continuation");

    /* 15. Nyst names the exact violated invariant. ------------------------- */
    // Both required invariants are false at this point: Alice still has
    // effective GitHub access, and her Okta account is still ACTIVE. Nyst
    // names each one rather than reporting one generic failure.
    const violated = first.evaluation.required.filter((item) => item.result === "false");
    assert.deepEqual(violated.map((item) => item.invariant_id).sort(),
      ["github_effective_access_none", "okta_account_disabled"]);

    const github = violated.find((item) => item.invariant_id === "github_effective_access_none")!;
    assert.match(github.reason, /effective_permission/);
    assert.match(github.reason, /write/, "the reason does not say what Nyst actually observed");
    // And the evidence it rested on is named, so the claim is checkable.
    assert.ok(github.facts_used.length > 0, "the violated invariant cites no facts");
    // The primary reason a human reads first is the access one, not the
    // account one: someone with live production access is the urgent problem.
    assert.ok(first.evaluation.primary_reason, "no primary reason was surfaced");

    // Coverage is FULL: Nyst could see everything it needed to. The outcome is
    // false because the world is wrong, not because Nyst is blind. That
    // distinction is the difference between an alert and a guess.
    assert.deepEqual(first.evaluation.coverage, { numerator: 2, denominator: 2 });

    /* THE HEADLINE. --------------------------------------------------------- */
    assert.equal(actionVerified, true, "ACTION VERIFIED");
    assert.equal(first.instance.verdict, "unsatisfied", "OUTCOME UNSATISFIED");

    /* 16-17. A human authorizes the supported remediation. ----------------- */
    const remediation = EMPLOYEE_OFFBOARDING_PACK.remediation.find((item) => item.remediation_id === "remove_inherited_team_access")!;
    assert.equal(remediation.requires_human_authorization, true,
      "removing someone from a team is a consequential act and must not be automatic");
    assert.equal(remediation.addresses_invariant, "github_effective_access_none");

    // The remediation runs, and the world changes.
    await observe(githubSubject, "github", "inherited_paths", { type: "string_set", value: [] });
    await observe(githubSubject, "github", "effective_permission", { type: "string", value: "none" });

    const afterRemediation = await outcomes.evaluate(tenant, instanceId);
    assert.equal(afterRemediation.evaluation.verdict, "unsatisfied",
      "the outcome is still unsatisfied: Okta has not been suspended yet");
    assert.equal(
      afterRemediation.evaluation.required.find((item) => item.invariant_id === "github_effective_access_none")!.result,
      "true", "the GitHub invariant did not become true after the inherited path was removed");

    /* 18-21. Okta suspension, observed. ------------------------------------ */
    await observe(oktaSubject, "okta", "account_status", { type: "string", value: "SUSPENDED" });
    const settled = await outcomes.evaluate(tenant, instanceId);
    assert.equal(settled.evaluation.verdict, "satisfied",
      "every required invariant holds on fresh authoritative evidence, and the verdict is still not SATISFIED");
    assert.equal(settled.instance.lifecycle, "settled");

    /* 22. Continuation may now be granted. --------------------------------- */
    assert.equal(settled.instance.continuation_disposition, "allowed");
    assert.ok(settled.instance.satisfied_at, "the instance does not record when it became satisfied");

    /* 23. A signed Outcome Receipt. ---------------------------------------- */
    const receipt = await outcomes.issueReceipt(tenant, instanceId, signer);
    assert.equal(receipt.verdict, "satisfied");
    const payload = receipt.payload as Record<string, unknown>;
    assert.equal(payload.receipt_type, "nyst.outcome.v1");
    assert.equal(payload.desired_outcome_statement, EMPLOYEE_OFFBOARDING_PACK.desired_outcome_statement);
    assert.deepEqual(payload.coverage, { numerator: 2, denominator: 2 });
    // The signature verifies against the canonical payload.
    assert.equal(signer.verify(payload, {
      algorithm: "ed25519", canonicalization: "ojc-1",
      key_id: String(receipt.key_id), signature_b64: String(receipt.signature),
    }), true, "the Outcome Receipt signature does not verify");
    // And a payload whose content changed does NOT verify.
    assert.equal(signer.verify({ ...payload, verdict: "unsatisfied" }, {
      algorithm: "ed25519", canonicalization: "ojc-1",
      key_id: String(receipt.key_id), signature_b64: String(receipt.signature),
    }), false, "a tampered Outcome Receipt verified");
    // And it carries no credential of any kind.
    assert.doesNotMatch(JSON.stringify(receipt), /ghp_|github_pat_|sk_(test|live)_|Bearer /);
  });

  it("a receipt is issued for an UNSATISFIED outcome too, because that is the one an incident needs", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const bob = { ...alice, person_email: "bob@example.test", github_login: "bob", okta_user_id: "00ubobfixture" };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject: bob,
      subject_key: `offboard:${bob.person_email}`, mode: "enforced",
    });
    await observe(`github:${bob.github_repository}:${bob.github_login}`, "github", "effective_permission",
      { type: "string", value: "admin" });
    await observe(`okta:user:${bob.okta_user_id}`, "okta", "account_status", { type: "string", value: "SUSPENDED" });
    const evaluated = await outcomes.evaluate(tenant, instance.outcome_instance_id);
    assert.equal(evaluated.evaluation.verdict, "unsatisfied");

    const receipt = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);
    assert.equal(receipt.verdict, "unsatisfied");
    const payload = receipt.payload as { invariants: Array<{ invariant_id: string; result: string; reason: string }> };
    const failing = payload.invariants.find((item) => item.result === "false")!;
    assert.equal(failing.invariant_id, "github_effective_access_none");
    assert.match(failing.reason, /admin/, "the receipt does not say what Nyst actually observed");
  });

  it("INDETERMINATE is not UNSATISFIED: an unobservable invariant blocks SATISFIED without claiming falsehood", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const carol = { ...alice, person_email: "carol@example.test", github_login: "carol", okta_user_id: "00ucarolfixture" };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject: carol,
      subject_key: `offboard:${carol.person_email}`, mode: "enforced",
    });
    // GitHub is clean. Okta was never observed at all.
    await observe(`github:${carol.github_repository}:${carol.github_login}`, "github", "effective_permission",
      { type: "string", value: "none" });

    const evaluated = await outcomes.evaluate(tenant, instance.outcome_instance_id);
    assert.equal(evaluated.evaluation.verdict, "indeterminate",
      "a missing observation must not produce SATISFIED, and must not produce UNSATISFIED either");
    const okta = evaluated.evaluation.required.find((item) => item.invariant_id === "okta_account_disabled")!;
    assert.equal(okta.result, "indeterminate");
    assert.ok(okta.missing_facts.length > 0, "the indeterminate result does not say what was missing");
    // Coverage drops, and that is exactly how a customer learns Nyst is
    // partially blind rather than quietly optimistic.
    assert.deepEqual(evaluated.evaluation.coverage, { numerator: 1, denominator: 2 });
    assert.equal(evaluated.instance.continuation_disposition, "hold");
  });

  it("a stale observation is not evidence, however good the news it carries", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const dave = { ...alice, person_email: "dave@example.test", github_login: "dave", okta_user_id: "00udavefixture" };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject: dave,
      subject_key: `offboard:${dave.person_email}`, mode: "enforced",
    });
    // Both invariants would hold — on observations from two hours ago, well
    // outside the pack's 900-second freshness window.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await observe(`github:${dave.github_repository}:${dave.github_login}`, "github", "effective_permission",
      { type: "string", value: "none" }, { observedAt: old, freshSeconds: 60 });
    await observe(`okta:user:${dave.okta_user_id}`, "okta", "account_status",
      { type: "string", value: "SUSPENDED" }, { observedAt: old, freshSeconds: 60 });

    const evaluated = await outcomes.evaluate(tenant, instance.outcome_instance_id);
    assert.equal(evaluated.evaluation.verdict, "indeterminate",
      "STALE EVIDENCE WAS ACCEPTED AS PROOF THAT ACCESS IS GONE");
    assert.ok(evaluated.evaluation.required.every((item) => /freshness window/.test(item.reason)),
      "the reason does not explain that the evidence is stale");
  });

  it("two authoritative sources that disagree is INDETERMINATE, never a tie broken by recency", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const erin = { ...alice, person_email: "erin@example.test", github_login: "erin", okta_user_id: "00uerinfixture" };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject: erin,
      subject_key: `offboard:${erin.person_email}`, mode: "enforced",
    });
    const subject = `github:${erin.github_repository}:${erin.github_login}`;
    // Two authoritative providers, same property, different answers. The
    // tempting move is to take the newer one. That is how a safety system
    // produces a confident wrong answer.
    await observe(subject, "github", "effective_permission", { type: "string", value: "none" });
    await observe(subject, "github_audit_log", "effective_permission", { type: "string", value: "write" });
    await observe(`okta:user:${erin.okta_user_id}`, "okta", "account_status", { type: "string", value: "SUSPENDED" });

    const evaluated = await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const github = evaluated.evaluation.required.find((item) => item.invariant_id === "github_effective_access_none")!;
    assert.equal(github.result, "indeterminate");
    assert.ok(github.contradictions.length >= 2, "the contradiction is not reported");
    assert.match(github.reason, /disagree/);
    assert.equal(evaluated.evaluation.verdict, "indeterminate");
  });

  it("corroborative evidence alone can never satisfy a required invariant", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const frank = { ...alice, person_email: "frank@example.test", github_login: "frank", okta_user_id: "00ufrankfixture" };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject: frank,
      subject_key: `offboard:${frank.person_email}`, mode: "enforced",
    });
    await observe(`github:${frank.github_repository}:${frank.github_login}`, "github", "effective_permission",
      { type: "string", value: "none" }, { authoritative: false });
    await observe(`okta:user:${frank.okta_user_id}`, "okta", "account_status",
      { type: "string", value: "SUSPENDED" }, { authoritative: false });

    const evaluated = await outcomes.evaluate(tenant, instance.outcome_instance_id);
    assert.equal(evaluated.evaluation.verdict, "indeterminate");
    assert.ok(evaluated.evaluation.required.every((item) => /corroborative/.test(item.reason)),
      "the reason does not explain that only corroborative evidence exists");
  });

  it("the AWS module is required when selected, and NOT claimed when it is not", async () => {
    // Unselected: the contract requires two invariants and says out loud that
    // it makes no AWS claim.
    const base = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    assert.equal(base.required_invariants.length, 2);
    assert.ok(base.uncovered.some((item) => /NO claim about AWS/i.test(item)),
      "an unselected module must say, in words, what Nyst is not claiming");

    // Selected: its invariant becomes REQUIRED, not optional. An optional
    // invariant could never change a verdict, which would make selecting the
    // module purely decorative.
    const withAws = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding",
      { modules: ["aws_production_credentials"] });
    assert.equal(withAws.required_invariants.length, 3);
    assert.ok(withAws.required_invariants.some((item) => item.invariant_id === "aws_active_access_keys_zero"));
    assert.ok(withAws.capability_requirements.includes("aws:iam:read"));
    assert.ok(!withAws.uncovered.some((item) => /NO claim about AWS/i.test(item)));

    await assert.rejects(
      () => outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding", { modules: ["not_a_module"] }),
      /no optional module named/);
  });

  it("an activated contract is immutable, and a historical instance pins its version", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const grace = { ...alice, person_email: "grace@example.test", github_login: "grace", okta_user_id: "00ugracefixture" };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject: grace,
      subject_key: `offboard:${grace.person_email}`, mode: "enforced",
    });
    assert.equal(instance.contract_version, contract.contract_version,
      "the instance did not pin the contract version it ran under");

    await assert.rejects(
      () => pool.query(`UPDATE nyst_outcome_contracts SET required_invariants='[]'::jsonb WHERE outcome_contract_id=$1`,
        [contract.outcome_contract_id]),
      /immutable/, "an activated OutcomeContract was edited in place");
    await assert.rejects(
      () => pool.query(`DELETE FROM nyst_outcome_contracts WHERE outcome_contract_id=$1`, [contract.outcome_contract_id]),
      /immutable/);
  });

  it("a WorldFact is superseded, never rewritten, so history survives", async () => {
    const subject = `github:${alice.github_repository}:history-${suffix}`;
    const first = await observe(subject, "github", "effective_permission", { type: "string", value: "write" });
    const second = await observe(subject, "github", "effective_permission", { type: "string", value: "none" });

    const history = await outcomes.factHistory(tenant, subject, "effective_permission");
    assert.equal(history.length, 2, "the earlier observation was lost");
    const current = await outcomes.currentFacts(tenant, [subject]);
    assert.equal(current.length, 1, "a superseded fact is still current");
    assert.equal(current[0]!.fact_id, second.fact_id);

    await assert.rejects(
      () => pool.query(`DELETE FROM nyst_world_facts WHERE fact_id=$1`, [first.fact_id]),
      /append-only/, "a WorldFact was deleted");
    await assert.rejects(
      () => pool.query(`UPDATE nyst_world_facts SET value='{"type":"string","value":"admin"}'::jsonb WHERE fact_id=$1`,
        [first.fact_id]),
      /append-only/, "a WorldFact was rewritten");
  });

  it("there are exactly three OutcomeVerdicts, and lifecycle is not one of them", () => {
    assert.deepEqual([...OUTCOME_VERDICTS], ["satisfied", "unsatisfied", "indeterminate"]);
    // "evaluating" is a lifecycle state. Mixing it into the truth values would
    // make "we haven't looked yet" a kind of answer, which it is not.
    assert.ok(!(OUTCOME_VERDICTS as readonly string[]).includes("evaluating"));
    assert.ok(!(OUTCOME_VERDICTS as readonly string[]).includes("pending"));
  });

  it("the dependency graph is acyclic, bounded, and puts observation before consequence", () => {
    const order = dependencyOrder(EMPLOYEE_OFFBOARDING_PACK.dependency_graph);
    const position = (key: string) => order.indexOf(key);
    // Identity first: while the account can authenticate, removing repository
    // access contains nothing.
    assert.ok(position("suspend_okta") < position("remove_github_direct"),
      "repository access is revoked before the identity is suspended");
    // And the effective-access read comes after the removal, because that is
    // the read that answers the question the customer actually asked.
    assert.ok(position("remove_github_direct") < position("observe_github_effective"));
    assert.ok(position("observe_github_effective") < position("github_effective_none"));

    assert.throws(() => dependencyOrder({
      outcome_spec: "cyclic",
      nodes: [
        { key: "a", kind: "observation", title: "A", requires: ["b"], blocking_explanation: "" },
        { key: "b", kind: "observation", title: "B", requires: ["a"], blocking_explanation: "" },
      ],
    }), /cycle/);
  });

  it("invariants are data: a contract carrying executable code is refused", async () => {
    await assert.rejects(() => outcomes.createContract(tenant, tenant.user_id, {
      outcome_spec: "employee_offboarding", outcome_spec_version: "employee_offboarding/1.0.0",
      subject_schema: { person_email: "string" },
      desired_outcome_statement: "A statement long enough to satisfy the constraint.",
      required_invariants: [{
        invariant_id: "hostile", statement: "Executable", operator: "equals",
        subject_ref: "x", property: "y",
        // A function smuggled onto an invariant. There is no expression
        // language, no eval, and no LLM anywhere in the safety path.
        evaluate: () => true,
      } as never],
      freshness_seconds: 900, timeout_seconds: 3600,
    }), /never code/);
  });
});
