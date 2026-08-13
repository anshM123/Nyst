/**
 * Nyst v0.3.0 — Phases 46-58. THE RELEASE GATE.
 *
 * The adversarial pass, the end-to-end acceptance run, the secret scan, and
 * the version-truth check that stops a release claiming to be something it is
 * not.
 *
 * Everything here is deliberately hostile to the product. The question is not
 * "does it work" — the rest of the suite answers that — but "what does someone
 * trying to make Nyst lie actually get?"
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { AuthorityRepository } from "../src/product/authority/authorityRepository.js";
import { OutcomeShadow } from "../src/product/outcome/outcomeShadow.js";
import { EvidenceIngest } from "../src/product/outcome/evidenceIngest.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { buildProductServer, NYST_VERSION } from "../src/product/server.js";
import { registerPublicRoutes } from "../src/public/publicRoutes.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { EffectSpecDescriptor, TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

/** Every shape of real credential this project must never contain. */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["GitHub classic PAT", /\bghp_[A-Za-z0-9]{36}\b/],
  ["GitHub fine-grained PAT", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["GitHub OAuth token", /\bgho_[A-Za-z0-9]{36}\b/],
  ["Stripe secret key", /\bsk_(?:test|live)_[A-Za-z0-9]{20,}\b/],
  ["Stripe restricted key", /\brk_(?:test|live)_[A-Za-z0-9]{20,}\b/],
  ["Okta API token", /\b00[A-Za-z0-9_-]{40,}\b/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["Bearer token literal", /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/],
]);

describe("Nyst v0.3.0 Phases 46-58 — the release gate", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let authority: AuthorityRepository;
  let shadow: OutcomeShadow;
  let ingest: EvidenceIngest;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let product: ReturnType<typeof createProductProviderRuntime>;
  let descriptors: readonly EffectSpecDescriptor[];
  let signer: Ed25519Signer;
  let tenant: TenantScope & { user_id: string };
  let effect: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    authority = new AuthorityRepository(pool);
    shadow = new OutcomeShadow(pool, outcomes);
    ingest = new EvidenceIngest(pool, outcomes, null);
    signer = Ed25519Signer.ephemeral("release-gate");
    tenant = await repository.createBootstrap({
      organization: "Release", organization_slug: `release-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `release-${suffix}@test.test`, display_name: "Release", password: "Nyst v030 release fixture 23!",
    });
    product = createProductProviderRuntime(store, repository, signer, new MutableClock(),
      { production: false, enable_development_fake: true });
    descriptors = product.descriptors;
    effect = descriptors.find((item) => item.provider === "fake")!.effect_name;
    await repository.configureEffectSpec(tenant, descriptors.find((item) => item.effect_name === effect)!, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, {
      effect_name: null, execution_mode: "automatic", auto_continuation: true,
      auto_compensation: true, reconcile_timeout_seconds: 3600,
    });
    app = await buildProductServer({
      repository, effect_specs: descriptors, runtime: product.runtime, commit: product.commit,
      production: false, outcomes, authority, shadow, evidence: ingest, signer,
    });
    registerPublicRoutes(app, { mount_root: false });
    await app.ready();
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  /* ================================================== PHASE 55: END TO END */

  it("END TO END: an agent acts, the outcome is false, a human fixes it, and a receipt is issued", async () => {
    /* Authority. What may this Agent do? */
    const agentId = String((await repository.createAgent(tenant, tenant.user_id, {
      name: "HR Offboarding Agent", slug: `e2e-hr-${suffix}`, owner: "People Ops",
      description: "", framework: "unspecified", tags: [],
    })).agent_id);
    await authority.createAutonomyRule(tenant, tenant.user_id, {
      agent_id: agentId, effect_name: effect, disposition: "autonomous",
      rationale: "Removing access is safe and reversible.",
    });

    /* Outcome. What must become true? */
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding", { agent_id: agentId });
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const subject = {
      person_email: `e2e-${suffix}@example.test`, github_login: `e2e${suffix}`,
      github_repository: "acme/production", okta_user_id: `00ue2e${suffix}`,
    };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, agent_id: agentId,
      subject, subject_key: `offboard:${subject.person_email}`, mode: "enforced",
    });
    const github = `github:${subject.github_repository}:${subject.github_login}`;
    const okta = `okta:user:${subject.okta_user_id}`;

    /* Effect. What happened to the operation? */
    const businessKey = `e2e-${suffix}`;
    const admission = await repository.admitConsequence(tenant, {
      agent_id: agentId, effect_name: effect, business_key: businessKey, amount_minor: null, currency: null,
    });
    assert.equal(admission.admitted, true);
    const committed = await product.runtime.commit(effect, `${tenant.environment_id}:${businessKey}`,
      { repository_id: subject.github_repository, principal_id: subject.github_login,
        desired_permission: "none", scenario: "response_lost_after_effect" },
      EMPTY_CONTEXT,
      { establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, businessKey, agentId) });
    await repository.linkAdmission(admission.admission_id, committed.action.action_id);
    await repository.recordResolutionTransition(committed.action.action_id, committed.resolution, "action_commit");
    await outcomes.linkAction(instance.outcome_instance_id, committed.action.action_id, "remove_github_direct");
    assert.ok(["verified", "satisfied_unattributed"].includes(committed.resolution.effect.state));

    /* The world. Direct access gone, inherited access still granting WRITE. */
    const now = new Date();
    for (const [ref, provider, property, value] of [
      [github, "github", "direct_permission", "none"],
      [github, "github", "effective_permission", "write"],
      [okta, "okta", "account_status", "SUSPENDED"],
    ] as const) {
      await outcomes.recordFact(tenant, {
        subject_ref: ref, provider, property, value: { type: "string", value },
        observed_at: now.toISOString(), fresh_until: new Date(now.getTime() + 900_000).toISOString(),
        source_type: "provider_api_read", authoritative: true, adapter_version: "e2e/1.0.0",
      });
    }

    const first = await outcomes.evaluate(tenant, instance.outcome_instance_id);
    assert.equal(first.evaluation.verdict, "unsatisfied");
    assert.equal(first.instance.continuation_disposition, "hold");

    /* A grant is refused, because the outcome is not established. */
    await assert.rejects(() => authority.issueGrant(tenant, {
      agent_id: agentId, outcome_instance_id: instance.outcome_instance_id,
      permitted_effects: [effect], resource_scope: [github], expires_in_seconds: 600,
    }, signer), /requires an explicit, attributed human exception/);

    /* A human fixes the world. */
    const fixedAt = new Date(now.getTime() + 60_000);
    await outcomes.recordFact(tenant, {
      subject_ref: github, provider: "github", property: "effective_permission",
      value: { type: "string", value: "none" },
      observed_at: fixedAt.toISOString(), fresh_until: new Date(fixedAt.getTime() + 900_000).toISOString(),
      source_type: "provider_api_read", authoritative: true, adapter_version: "e2e/1.0.0",
    });
    const settled = await outcomes.evaluate(tenant, instance.outcome_instance_id, { now: fixedAt });
    assert.equal(settled.evaluation.verdict, "satisfied");
    assert.equal(settled.instance.continuation_disposition, "allowed");

    /* Now a grant may issue, and it is narrow. */
    const grant = await authority.issueGrant(tenant, {
      agent_id: agentId, outcome_instance_id: instance.outcome_instance_id,
      permitted_effects: [effect], resource_scope: [github], expires_in_seconds: 600,
    }, signer);
    assert.ok(grant.grant_id);

    /* And a signed receipt, which verifies. */
    const receipt = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);
    assert.equal(receipt.verdict, "satisfied");
    assert.equal(signer.verify(receipt.payload, {
      algorithm: "ed25519", canonicalization: "ojc-1",
      key_id: String(receipt.key_id), signature_b64: String(receipt.signature),
    }), true, "the end-to-end Outcome Receipt does not verify");
  });

  /* ================================================ PHASE 54: ADVERSARIAL */

  it("ADVERSARIAL: no surface accepts a verdict, an effect state, or a capability from a caller", async () => {
    // Every way someone might try to tell Nyst what is true rather than let it
    // find out. Each must be refused, and none may produce a 500.
    const attacks: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
      ["push a verdict as evidence", "/v1/evidence",
        { source_key: "x", event_id: "aaaaaaaa", subject_ref: "s", property: "outcome",
          value: { type: "string", value: "satisfied" }, observed_at: new Date().toISOString() }],
      ["push a conclusion field", "/v1/evidence",
        { source_key: "x", event_id: "bbbbbbbb", subject_ref: "s", property: "vpn.active",
          value: { type: "boolean", value: false }, observed_at: new Date().toISOString(), verdict: "satisfied" }],
      ["declare an outcome complete without an instance", "/v1/shadow/completion-signals",
        { outcome_instance_id: randomUUID(), declared_status: "complete" }],
      ["issue a grant for an outcome that does not exist", "/v1/continuation-grants",
        { outcome_instance_id: randomUUID(), permitted_effects: ["x"], resource_scope: ["y"] }],
    ];
    for (const [name, path, payload] of attacks) {
      const response = await app.inject({ method: "POST", url: path, payload,
        headers: { "content-type": "application/json" } });
      assert.ok(response.statusCode >= 400, `${name} was ACCEPTED with ${response.statusCode}`);
      assert.notEqual(response.statusCode, 500, `${name} produced a 500 rather than a deliberate refusal`);
    }
  });

  it("ADVERSARIAL: an exception cannot make a false outcome true, through any surface", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const subject = {
      person_email: `adv-${suffix}@example.test`, github_login: `adv${suffix}`,
      github_repository: "acme/production", okta_user_id: `00uadv${suffix}`,
    };
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject,
      subject_key: `offboard:${subject.person_email}`, mode: "enforced",
    });
    const now = new Date();
    await outcomes.recordFact(tenant, {
      subject_ref: `github:${subject.github_repository}:${subject.github_login}`,
      provider: "github", property: "effective_permission", value: { type: "string", value: "admin" },
      observed_at: now.toISOString(), fresh_until: new Date(now.getTime() + 900_000).toISOString(),
      source_type: "provider_api_read", authoritative: true, adapter_version: "adv/1.0.0",
    });
    await outcomes.evaluate(tenant, instance.outcome_instance_id);

    await authority.createException(tenant, tenant.user_id, {
      kind: "break_glass", outcome_instance_id: instance.outcome_instance_id,
      authorizes: "continuation_despite_unsatisfied_outcome",
      actor_role: "Security", reason: "INC-999: continue despite the unsatisfied outcome.",
      reference: "INC-999", expires_in_seconds: 3600,
    });

    // The verdict has not moved, and re-evaluating does not move it either.
    assert.equal((await outcomes.instance(tenant, instance.outcome_instance_id))!.verdict, "unsatisfied");
    assert.equal((await outcomes.evaluate(tenant, instance.outcome_instance_id)).evaluation.verdict, "unsatisfied");
    // And the receipt records what was observed, not what was authorized.
    const receipt = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);
    assert.equal(receipt.verdict, "unsatisfied",
      "A HUMAN EXCEPTION CHANGED WHAT A SIGNED RECEIPT ASSERTS");
  });

  it("ADVERSARIAL: no resolved secret reaches any response, on any surface", async () => {
    for (const path of [
      "/health", "/ready", "/v1/overview", "/v1/outcomes", "/v1/evidence-sources",
      "/v1/autonomy-rules", "/v1/nystbench", "/pricing", "/security", "/contact", "/",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      for (const [name, pattern] of SECRET_PATTERNS) {
        assert.doesNotMatch(response.body, pattern, `${path} leaked something shaped like a ${name}`);
      }
    }
  });

  /* ================================================== PHASE 57: SECRET SCAN */

  it("SECRET SCAN: no real credential exists anywhere in the repository", () => {
    const roots = ["src", "tests", "scripts", "db", "docs", "packages"];
    const findings: string[] = [];
    const skip = new Set(["node_modules", "dist", ".git", "coverage"]);

    const walk = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = join(path, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (statSync(full).size > 2_000_000) continue;
        if (!/\.(ts|js|mjs|cjs|json|sql|md|yml|yaml|env|sh|txt|html|css)$/.test(entry.name)) continue;
        const source = readFileSync(full, "utf8");
        for (const [name, pattern] of SECRET_PATTERNS) {
          // The test file that DEFINES these patterns necessarily contains
          // them, and so does anything documenting the shapes we refuse.
          if (full.endsWith("v030ReleaseGate.postgres.integration.test.ts")) continue;
          if (pattern.test(source)) findings.push(`${full}: something shaped like a ${name}`);
        }
      }
    };
    for (const root of roots) walk(resolve(process.cwd(), root));

    // NEVER print the value. The path and the shape are enough to act on.
    assert.deepEqual(findings, [], `possible credentials found:\n${findings.join("\n")}`);
  });

  it("SECRET SCAN: credential references are opaque, and never a value", () => {
    const source = readFileSync(resolve(process.cwd(), "src/product/productRepository.ts"), "utf8");
    // Every stored reference is a scheme-prefixed pointer.
    assert.match(source, /\^\(\?:env\|vault\|secret-manager\)|env:NYST_/);
    // And nothing resolves a secret into a persisted column.
    assert.doesNotMatch(source, /INSERT[^;]*credential_value|secret_value/i);
  });

  /* =================================================== PHASE 1I: VERSION */

  it("VERSION TRUTH: every artefact agrees on 0.3.0", () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
    const root = JSON.parse(read("package.json")) as { version: string; name: string };
    const sdk = JSON.parse(read("packages/sdk/package.json")) as { version: string; name: string };
    assert.equal(root.version, "0.3.0", "the root package does not claim 0.3.0");
    assert.equal(sdk.version, "0.3.0", "the SDK does not claim 0.3.0");
    assert.equal(NYST_VERSION, "0.3.0", "the server does not report 0.3.0");
    for (const document of ["README.md", "VERIFICATION.md"]) {
      assert.match(read(document), /0\.3\.0/, `${document} does not mention 0.3.0`);
    }
  });

  it("the health and readiness endpoints report the same version the server was built as", async () => {
    for (const path of ["/health", "/ready"]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 200);
      assert.equal((response.json() as { version: string }).version, NYST_VERSION);
    }
  });

  /* ================================================ STRUCTURAL INVARIANTS */

  it("the three layers are still three: no module blurs authority, effect and outcome", () => {
    // The outcome layer must not import the authority evaluator, and the
    // authority evaluator must not import the outcome repository. They share
    // types, not decisions.
    const outcomeRepository = readFileSync(resolve(process.cwd(), "src/product/outcome/outcomeRepository.ts"), "utf8");
    assert.doesNotMatch(outcomeRepository, /from "\.\.\/authority\//,
      "the outcome layer imports the authority layer: what is true must not depend on what is allowed");
    const canonicalAuthority = readFileSync(resolve(process.cwd(), "src/product/authority/canonicalAuthority.ts"), "utf8");
    assert.doesNotMatch(canonicalAuthority, /outcomeRepository|OutcomeRepository/,
      "the authority evaluator reaches into the outcome repository rather than being handed a verdict");
  });

  it("there is still no Force Continue, and no way to declare an outcome satisfied", () => {
    const forbidden = /force[_ ]?continue|mark[_ ]?verified|override[_ ]?verdict|set[_ ]?satisfied/i;
    const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(resolve(path, entry.name))
        : entry.name.endsWith(".ts") ? [resolve(path, entry.name)] : []);
    for (const file of [...walk(resolve(process.cwd(), "src")), ...walk(resolve(process.cwd(), "packages/sdk/src"))]) {
      const source = readFileSync(file, "utf8");
      const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n");
      // The server legitimately contains the SENTENCE "There is no
      // force-continue" in a refusal message. What must not exist is an
      // identifier, route or handler.
      const identifiers = code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
      for (const identifier of identifiers) {
        assert.ok(!forbidden.test(identifier), `${file} declares ${identifier}`);
      }
    }
  });

  it("exactly six EffectStates, exactly three OutcomeVerdicts, and they are not the same enum", async () => {
    const { EFFECT_STATES } = await import("../src/model/effectState.js") as { EFFECT_STATES: readonly string[] };
    const { OUTCOME_VERDICTS } = await import("../src/product/outcome/invariantEngine.js");
    assert.equal(EFFECT_STATES.length, 6);
    assert.equal(OUTCOME_VERDICTS.length, 3);
    for (const verdict of OUTCOME_VERDICTS) {
      assert.ok(!EFFECT_STATES.includes(verdict),
        `${verdict} appears in both the EffectState and OutcomeVerdict sets: the layers have been flattened`);
    }
  });

  /* ======================================================= DOCUMENTATION */

  it("the documented boundaries are still documented, and still honest", () => {
    const boundaries = readFileSync(resolve(process.cwd(), "docs/product/known-boundaries.md"), "utf8");
    for (const required of [
      /write capabilit/i,          // read-only preflight cannot verify a write
      /Relay/i,                     // mutation Relay is not implemented
      /Google/i,                    // never run against a live Google project
    ]) {
      assert.match(boundaries, required, "a known boundary has quietly disappeared from the documentation");
    }
    // And nothing claims to have been verified live when it has not.
    assert.doesNotMatch(boundaries, /verified against production|live provider verified/i);
  });
});
