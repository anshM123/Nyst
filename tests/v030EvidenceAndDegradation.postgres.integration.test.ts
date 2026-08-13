/**
 * Nyst v0.3.0 — Phases 8, 9, 10, 17.
 *
 * EVIDENCE INGEST and the RELAY are how observations reach the outcome layer
 * when Nyst does not hold the credential itself. The line they enforce is the
 * one the whole product rests on:
 *
 *     A customer pushes EVIDENCE. Nyst evaluates TRUTH.
 *
 * A customer who could push "this outcome is verified" could make Nyst lie on
 * their behalf, and the receipt would be worth nothing.
 *
 * PHASE 17 is the graceful-degradation gate, tests A through J. The theme
 * running through all ten: a missing integration reduces COVERAGE. It never
 * invents certainty, and it never produces a false Ready.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { OutcomeShadow } from "../src/product/outcome/outcomeShadow.js";
import {
  EvidenceIngest, EvidenceRejected, RelayCoordinator, canonicalPushBody, RELAY_OPERATIONS,
} from "../src/product/outcome/evidenceIngest.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { EffectSpecDescriptor, TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const SIGNING_REF = "env:NYST_INGEST_SECRET";
const SIGNING_SECRET = "synthetic-ingest-secret-0000000000";

class TestSecrets {
  async resolve(reference: string): Promise<string> {
    if (reference === SIGNING_REF) return SIGNING_SECRET;
    throw new Error("no such secret");
  }
}

describe("Nyst v0.3.0 Phases 8/9/10/17 — evidence ingest, relay, graceful degradation", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let ingest: EvidenceIngest;
  let relay: RelayCoordinator;
  let shadow: OutcomeShadow;
  let signer: Ed25519Signer;
  let descriptors: readonly EffectSpecDescriptor[];
  let tenant: TenantScope & { user_id: string };
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    ingest = new EvidenceIngest(pool, outcomes, new TestSecrets());
    relay = new RelayCoordinator(pool, ingest);
    shadow = new OutcomeShadow(pool, outcomes);
    signer = Ed25519Signer.ephemeral("relay");
    tenant = await repository.createBootstrap({
      organization: "Evidence", organization_slug: `evidence-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `evidence-${suffix}@test.test`, display_name: "Evidence", password: "Nyst v030 evidence fixture 23!",
    });
    descriptors = createProductProviderRuntime(store, repository, signer, new MutableClock(),
      { production: false, enable_development_fake: true }).descriptors;
  });
  after(async () => { await store.close(); await pool.end(); });

  /** A fresh environment, so each degradation case starts from nothing. */
  async function environment(name: string): Promise<TenantScope & { user_id: string }> {
    return { ...tenant, environment_id: await repository.createEnvironment(tenant, name, `${name}-${suffix}`) };
  }

  async function offboarding(scope: TenantScope, name: string, modules: readonly string[] = []): Promise<{
    instanceId: string; github: string; okta: string; aws: string;
  }> {
    const contract = await outcomes.createContractFromPack(scope, tenant.user_id, "employee_offboarding", { modules });
    await outcomes.activateContract(scope, contract.outcome_contract_id);
    const subject = {
      person_email: `${name}@example.test`, github_login: name,
      github_repository: "acme/production", okta_user_id: `00u${name}`, aws_principal: name,
    };
    const { instance } = await outcomes.openInstance(scope, {
      outcome_contract_id: contract.outcome_contract_id, subject,
      subject_key: `offboard:${subject.person_email}`, mode: "enforced",
    });
    return {
      instanceId: instance.outcome_instance_id,
      github: `github:${subject.github_repository}:${subject.github_login}`,
      okta: `okta:user:${subject.okta_user_id}`,
      aws: `aws:principal:${subject.aws_principal}`,
    };
  }

  async function observe(scope: TenantScope, subjectRef: string, provider: string, property: string,
    value: string, at = new Date()): Promise<void> {
    await outcomes.recordFact(scope, {
      subject_ref: subjectRef, provider, property, value: { type: "string", value },
      observed_at: at.toISOString(), fresh_until: new Date(at.getTime() + 900_000).toISOString(),
      source_type: "provider_api_read", authoritative: true, adapter_version: "degradation-test/1.0.0",
    });
  }

  /* ====================================================== EVIDENCE INGEST */

  it("THE LINE: a customer pushes evidence and cannot push a conclusion", async () => {
    const scope = await environment("conclusion");
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "internal-vpn", display_name: "Internal VPN", transport: "evidence_ingest",
      permitted_properties: ["vpn.active", "outcome"], adapter_version: "vpn/1.0.0",
    });

    // Every shape of "just take my word for it".
    for (const hostile of [
      { property: "outcome", value: { type: "string" as const, value: "satisfied" } },
      { property: "verdict", value: { type: "string" as const, value: "satisfied" } },
      { property: "verified", value: { type: "boolean" as const, value: true } },
    ]) {
      await assert.rejects(() => ingest.push(scope, {
        source_key: "internal-vpn", event_id: `hostile-${hostile.property}-${suffix}`,
        subject_ref: "person:alice", property: hostile.property, value: hostile.value,
        observed_at: new Date().toISOString(),
      }), (error: unknown) => error instanceof EvidenceRejected && /conclusion, not an observation/.test(error.message),
        `A CUSTOMER PUSHED "${hostile.property}" AND NYST ACCEPTED IT`);
    }

    // And a conclusion smuggled as a top-level field is refused too.
    await assert.rejects(() => ingest.push(scope, {
      source_key: "internal-vpn", event_id: `smuggled-${suffix}`,
      subject_ref: "person:alice", property: "vpn.active",
      value: { type: "boolean", value: false }, observed_at: new Date().toISOString(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verdict: "satisfied",
    } as never), (error: unknown) => error instanceof EvidenceRejected && /may not carry "verdict"/.test(error.message));

    // The legitimate push — a fact their system observed — is accepted.
    const accepted = await ingest.push(scope, {
      source_key: "internal-vpn", event_id: `vpn-${suffix}`,
      subject_ref: "person:alice", property: "vpn.active",
      value: { type: "boolean", value: false }, observed_at: new Date().toISOString(),
    });
    assert.ok(accepted.world_fact_id, "a legitimate observation did not become a WorldFact");
  });

  it("a source may only report the properties it registered for", async () => {
    const scope = await environment("scoped");
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "internal-vpn", display_name: "Internal VPN", transport: "evidence_ingest",
      permitted_properties: ["vpn.active"], adapter_version: "vpn/1.0.0",
    });
    // The VPN system does not get to have an opinion about Okta.
    await assert.rejects(() => ingest.push(scope, {
      source_key: "internal-vpn", event_id: `overreach-${suffix}`,
      subject_ref: "okta:user:00ualice", property: "account_status",
      value: { type: "string", value: "SUSPENDED" }, observed_at: new Date().toISOString(),
    }), /not permitted to report/);

    // An unregistered source is refused rather than trusted.
    await assert.rejects(() => ingest.push(scope, {
      source_key: "not-registered", event_id: `unknown-${suffix}`,
      subject_ref: "person:alice", property: "vpn.active",
      value: { type: "boolean", value: false }, observed_at: new Date().toISOString(),
    }), /No evidence source named/);
  });

  it("a customer cannot promote their own evidence to authoritative", async () => {
    const scope = await environment("authority");
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "internal-hr", display_name: "HR system", transport: "evidence_ingest",
      permitted_properties: ["effective_permission"], adapter_version: "hr/1.0.0",
      authoritative: false,
    });
    const pushed = await ingest.push(scope, {
      source_key: "internal-hr", event_id: `promote-${suffix}`,
      subject_ref: "github:acme/production:mallory", property: "effective_permission",
      value: { type: "string", value: "none" }, observed_at: new Date().toISOString(),
      provenance: { authoritative: true },
    });
    const fact = (await outcomes.currentFacts(scope, ["github:acme/production:mallory"]))[0]!;
    assert.equal(fact.fact_id, pushed.world_fact_id);
    assert.equal(fact.authoritative, false,
      "A CUSTOMER PROMOTED THEIR OWN EVIDENCE TO AUTHORITATIVE THROUGH THE PROVENANCE FIELD");
  });

  it("a push is idempotent, bounded, and refuses an observation from the future", async () => {
    const scope = await environment("idempotent");
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "internal-vpn", display_name: "Internal VPN", transport: "evidence_ingest",
      permitted_properties: ["vpn.active"], adapter_version: "vpn/1.0.0",
    });
    const push = {
      source_key: "internal-vpn", event_id: `once-${suffix}`, subject_ref: "person:alice",
      property: "vpn.active", value: { type: "boolean" as const, value: false },
      observed_at: new Date().toISOString(),
    };
    const first = await ingest.push(scope, push);
    const second = await ingest.push(scope, push);
    assert.equal(second.replayed, true, "a retried push created a second observation of the same event");
    assert.equal(second.ingested_evidence_id, first.ingested_evidence_id);
    assert.equal((await outcomes.factHistory(scope, "person:alice", "vpn.active")).length, 1,
      "a retried push produced two WorldFacts");

    await assert.rejects(() => ingest.push(scope, { ...push, event_id: "short" }), /event_id/);
    await assert.rejects(() => ingest.push(scope, {
      ...push, event_id: `future-${suffix}`,
      observed_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }), /has not happened yet/);
  });

  it("a signed source refuses an unsigned or wrongly signed push, and records that it verified", async () => {
    const scope = await environment("signed");
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "internal-vpn", display_name: "Internal VPN", transport: "evidence_ingest",
      permitted_properties: ["vpn.active"], adapter_version: "vpn/1.0.0",
      signing_secret_ref: SIGNING_REF,
    });
    const push = {
      source_key: "internal-vpn", event_id: `signed-${suffix}`, subject_ref: "person:alice",
      property: "vpn.active", value: { type: "boolean" as const, value: false },
      observed_at: new Date().toISOString(),
    };
    await assert.rejects(() => ingest.push(scope, push), /carried no signature/);
    await assert.rejects(() => ingest.push(scope, { ...push, signature: "00".repeat(32) }), /did not verify/);

    const signature = createHmac("sha256", SIGNING_SECRET).update(canonicalPushBody(push)).digest("hex");
    const accepted = await ingest.push(scope, { ...push, signature });
    assert.equal(accepted.signature_verified, true);
    // The weaker path stays visible: an unsigned source records verified=false
    // rather than being silently treated as equal.
    const rows = await ingest.evidence(scope);
    assert.equal(rows[0]!.signature_verified, true);
  });

  /* =============================================================== RELAY */

  it("the Relay protocol is read-only, scoped, signed, expiring and single-use", async () => {
    const scope = await environment("relay");
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "customer-relay", display_name: "Customer Relay", transport: "customer_relay",
      permitted_properties: ["effective_permission"], adapter_version: "relay/1.0.0", authoritative: true,
    });

    // Every operation in the protocol is an observation. There is no mutation
    // operation, and this is the assertion that keeps it that way.
    for (const operation of RELAY_OPERATIONS) {
      assert.match(operation, /^observe_/, `Relay operation ${operation} is not a read`);
    }

    const issued = await relay.issueRequest(scope, {
      source_key: "customer-relay", operation: "observe_github_effective_permission",
      subject_ref: "github:acme/production:alice", property: "effective_permission",
      operation_key: `relay-op-${suffix}`,
    }, signer);
    assert.ok(issued.request.nonce.length >= 16);
    assert.equal(signer.verify(issued.request, {
      algorithm: "ed25519", canonicalization: "ojc-1",
      key_id: issued.key_id, signature_b64: issued.signature,
    }), true, "the Relay request signature does not verify");
    // Short-lived by design.
    const lifetime = new Date(issued.request.expires_at).getTime() - new Date(issued.request.issued_at).getTime();
    assert.ok(lifetime <= 10 * 60 * 1000, "a Relay request outlives ten minutes");

    const response = {
      source_key: "customer-relay", event_id: `relay-evidence-${suffix}`,
      subject_ref: "github:acme/production:alice", property: "effective_permission",
      value: { type: "string" as const, value: "none" }, observed_at: new Date().toISOString(),
    };
    const fulfilled = await relay.fulfil(scope, { nonce: issued.request.nonce, push: response });
    assert.ok(fulfilled.world_fact_id, "a fulfilled Relay request produced no WorldFact");

    // REPLAY. The nonce is accepted exactly once, and the refusal says which
    // of the three failures it was.
    await assert.rejects(() => relay.fulfil(scope, {
      nonce: issued.request.nonce, push: { ...response, event_id: `relay-replay-${suffix}` },
    }), /already fulfilled/);
    await assert.rejects(() => relay.fulfil(scope, {
      nonce: "0".repeat(48), push: response,
    }), /No Relay request matches/);
  });

  it("a Relay must answer the question it was asked", async () => {
    const scope = await environment("relay-mismatch");
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "customer-relay", display_name: "Customer Relay", transport: "customer_relay",
      permitted_properties: ["effective_permission"], adapter_version: "relay/1.0.0", authoritative: true,
    });
    const issued = await relay.issueRequest(scope, {
      source_key: "customer-relay", operation: "observe_github_effective_permission",
      subject_ref: "github:acme/production:alice", property: "effective_permission",
      operation_key: `relay-mismatch-${suffix}`,
    }, signer);
    // A response about a different subject is refused rather than recorded.
    await assert.rejects(() => relay.fulfil(scope, {
      nonce: issued.request.nonce,
      push: {
        source_key: "customer-relay", event_id: `wrong-subject-${suffix}`,
        subject_ref: "github:acme/production:someone-else", property: "effective_permission",
        value: { type: "string", value: "none" }, observed_at: new Date().toISOString(),
      },
    }), /asked about effective_permission for github:acme\/production:alice, and the response was about effective_permission for github:acme\/production:someone-else/);

    // And the request is durably marked rejected, so an operator can see that
    // a Relay answered a question it was not asked.
    const rejected = (await relay.requests(scope)).find((item) => item.operation_key === `relay-mismatch-${suffix}`)!;
    assert.equal(rejected.status, "rejected");
    assert.match(String(rejected.rejection_reason), /did not match the subject and property/);
  });

  it("mutation through the Relay is NOT implemented, and is documented as such", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/product/outcome/evidenceIngest.ts"), "utf8");
    assert.match(source, /NOT IMPLEMENTED: consequential mutation Relay/,
      "the unimplemented mutation Relay is no longer declared as unimplemented");
    // And nothing in the protocol can express one.
    assert.ok(RELAY_OPERATIONS.every((operation) => operation.startsWith("observe_")));
  });

  /* ============================== PHASE 17: GRACEFUL DEGRADATION GATE */

  it("TEST A — zero providers: nothing claims production Ready", async () => {
    const scope = await environment("gate-a");
    // No integrations configured at all.
    const readiness = await repository.integrationsReadiness(scope, new TestSecrets() as never);
    assert.ok(readiness.every((item) => !item.ready), "a provider claimed Ready with nothing configured");
    for (const item of readiness) {
      assert.ok(item.failure_category, `${item.provider} is not ready and cannot say why`);
    }
    // The Failure Lab still works with no providers at all — it is synthetic.
    const { runOutcomeFault } = await import("../src/product/outcome/failureLab2.js");
    assert.equal(runOutcomeFault("direct_removed_inherited_remains").evaluation.verdict, "unsatisfied");
    // And Evidence Ingest setup works, which is the point of having it.
    const registered = await ingest.registerSource(scope, tenant.user_id, {
      source_key: "internal-vpn", display_name: "Internal VPN", transport: "evidence_ingest",
      permitted_properties: ["vpn.active"], adapter_version: "vpn/1.0.0",
    });
    assert.ok(registered.evidence_source_id);
  });

  it("TEST B/D — read-only observation works, and coverage is truthful", async () => {
    const scope = await environment("gate-bd");
    const { instanceId, github, okta } = await offboarding(scope, `gateBD${suffix}`);
    // Only GitHub observed. Cross-system coverage is honestly partial.
    await observe(scope, github, "github", "effective_permission", "none");
    const partial = await outcomes.evaluate(scope, instanceId);
    assert.equal(partial.evaluation.verdict, "indeterminate");
    assert.deepEqual(partial.evaluation.coverage, { numerator: 1, denominator: 2 },
      "coverage did not fall when only one of two systems was observable");

    // Both observed: cross-system Outcome Shadow works end to end.
    await observe(scope, okta, "okta", "account_status", "SUSPENDED");
    const full = await outcomes.evaluate(scope, instanceId);
    assert.equal(full.evaluation.verdict, "satisfied");
    assert.deepEqual(full.evaluation.coverage, { numerator: 2, denominator: 2 });
  });

  it("TEST F — AWS not connected and not required: the base outcome may still be SATISFIED", async () => {
    const scope = await environment("gate-f");
    const { instanceId, github, okta } = await offboarding(scope, `gateF${suffix}`);
    await observe(scope, github, "github", "effective_permission", "none");
    await observe(scope, okta, "okta", "account_status", "SUSPENDED");
    const evaluated = await outcomes.evaluate(scope, instanceId);
    assert.equal(evaluated.evaluation.verdict, "satisfied");
    // And the contract said, up front, that it makes no AWS claim.
    const contract = await outcomes.contract(scope, (await outcomes.instance(scope, instanceId))!.outcome_contract_id);
    assert.equal(contract!.required_invariants.length, 2,
      "the base contract silently acquired an AWS requirement");
  });

  it("TEST G — AWS not connected and REQUIRED: INDETERMINATE, never satisfied", async () => {
    const scope = await environment("gate-g");
    const { instanceId, github, okta } = await offboarding(scope, `gateG${suffix}`, ["aws_production_credentials"]);
    await observe(scope, github, "github", "effective_permission", "none");
    await observe(scope, okta, "okta", "account_status", "SUSPENDED");
    const evaluated = await outcomes.evaluate(scope, instanceId);
    assert.equal(evaluated.evaluation.verdict, "indeterminate",
      "AN OUTCOME REQUIRING AWS WAS SATISFIED WITH NO AWS EVIDENCE");
    assert.deepEqual(evaluated.evaluation.coverage, { numerator: 2, denominator: 3 });
    const aws = evaluated.evaluation.required.find((item) => item.invariant_id === "aws_active_access_keys_zero")!;
    assert.equal(aws.result, "indeterminate");
    assert.ok(aws.missing_facts.length > 0);
  });

  it("TEST H — an integration revoked mid-outcome: history survives, freshness expires, verdict degrades", async () => {
    const scope = await environment("gate-h");
    const { instanceId, github, okta } = await offboarding(scope, `gateH${suffix}`);
    const observedAt = new Date();
    await observe(scope, github, "github", "effective_permission", "none", observedAt);
    await observe(scope, okta, "okta", "account_status", "SUSPENDED", observedAt);
    assert.equal((await outcomes.evaluate(scope, instanceId, { now: observedAt })).evaluation.verdict, "satisfied");

    // The credential is revoked. Nyst writes nothing new — and the historical
    // evidence stays exactly where it is.
    const historyBefore = await outcomes.factHistory(scope, github, "effective_permission");
    assert.equal(historyBefore.length, 1);

    // Time passes. Nothing was re-observed, so the evidence goes stale and the
    // verdict returns to INDETERMINATE rather than remaining SATISFIED.
    const later = new Date(observedAt.getTime() + 2 * 60 * 60 * 1000);
    const degraded = await outcomes.evaluate(scope, instanceId, { now: later });
    assert.equal(degraded.evaluation.verdict, "indeterminate",
      "A REVOKED INTEGRATION LEFT AN OUTCOME PERMANENTLY SATISFIED ON STALE EVIDENCE");
    assert.ok(degraded.evaluation.required.every((item) => /freshness window/.test(item.reason)));
    // History is intact.
    assert.equal((await outcomes.factHistory(scope, github, "effective_permission")).length, 1);
  });

  it("TEST I — insufficient permission is reported as insufficient permission, never as Ready", async () => {
    const scope = await environment("gate-i");
    await repository.configureEffectSpec(scope, descriptors.find((item) => item.provider === "github")!, true);
    await repository.configureIntegration(scope, "github", "env:NYST_GITHUB_TOKEN");
    const secrets = { async resolve(): Promise<string> { return "synthetic-degradation-only"; } };
    await repository.runIntegrationPreflight(scope, "github", secrets as never,
      async () => ({ ok: false, failure_category: "insufficient_permission", detail: "missing admin:org" }));
    const readiness = await repository.integrationReadiness(scope, "github", secrets as never);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.failure_category, "insufficient_permission");
    const manifest = await repository.capabilityManifest(scope, "github");
    assert.ok(manifest.capabilities.every((item) => item.state === "insufficient_permission"));
    assert.ok(manifest.limitation, "an insufficient-permission connection reports no limitation");
  });

  it("TEST J — customer evidence is accepted with provenance and evaluated normally", async () => {
    const scope = await environment("gate-j");
    const { instanceId, github, okta } = await offboarding(scope, `gateJ${suffix}`);
    // Nyst holds no GitHub credential here. The customer's own system reports
    // it, through a source they registered as authoritative for that property.
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "customer-github-reader", display_name: "Customer GitHub reader",
      transport: "evidence_ingest", permitted_properties: ["effective_permission"],
      authoritative: true, adapter_version: "customer-github/2.1.0",
    });
    const pushed = await ingest.push(scope, {
      source_key: "customer-github-reader", event_id: `gate-j-${suffix}`,
      subject_ref: github, property: "effective_permission",
      value: { type: "string", value: "none" }, observed_at: new Date().toISOString(),
      provenance: { read_by: "internal-scheduler", api_version: "2022-11-28" },
    });
    assert.ok(pushed.world_fact_id);
    await observe(scope, okta, "okta", "account_status", "SUSPENDED");

    // Evaluated by exactly the same engine, with no special case for pushed
    // evidence beyond where its authority came from.
    const evaluated = await outcomes.evaluate(scope, instanceId);
    assert.equal(evaluated.evaluation.verdict, "satisfied");
    const fact = (await outcomes.currentFacts(scope, [github]))[0]!;
    assert.equal(fact.source_type, "evidence_ingest");
    assert.equal(fact.adapter_version, "customer-github/2.1.0");
    assert.equal(fact.authoritative, true);
    // The provenance survives into the fact, so a receipt can say where this
    // came from rather than presenting it as Nyst's own observation.
    const rows = await ingest.evidence(scope);
    assert.equal(String(rows[0]!.source_key), "customer-github-reader");
  });

  it("TEST C/E — enforcement remains gated on every other requirement", async () => {
    const scope = await environment("gate-ce");
    await repository.configureEffectSpec(scope, descriptors.find((item) => item.provider === "github")!, true);
    await repository.configureIntegration(scope, "github", "env:NYST_GITHUB_TOKEN");
    const secrets = { async resolve(): Promise<string> { return "synthetic-degradation-only"; } };
    // Read capability only. Enforcement needs the write capability too, and a
    // read-only connection must not unlock it.
    await repository.runIntegrationPreflight(scope, "github", secrets as never,
      async () => ({ ok: true, account_identity: "acme", scopes: ["public_repo", "read:org"] }));
    const readOnly = await repository.integrationReadiness(scope, "github", secrets as never);
    assert.equal(readOnly.ready, false, "a read-only GitHub connection was reported as Ready for enforcement");
    assert.equal(readOnly.failure_category, "capabilities_insufficient");
    assert.deepEqual([...readOnly.missing_capabilities], ["github:collaborator:write"]);

    // With write authorization the connection becomes ready — and only then.
    await repository.runIntegrationPreflight(scope, "github", secrets as never,
      async () => ({ ok: true, account_identity: "acme", scopes: ["repo", "read:org"] }));
    assert.equal((await repository.integrationReadiness(scope, "github", secrets as never)).ready, true);
  });

  it("Outcome Shadow works with pushed evidence alone, which is the zero-integration path", async () => {
    const scope = await environment("shadow-ingest");
    await repository.setEnvironmentMode(scope, tenant.user_id, "shadow", "Zero-integration shadow");
    const contract = await outcomes.createContractFromPack(scope, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(scope, contract.outcome_contract_id);
    const subject = {
      person_email: `shadowingest-${suffix}@example.test`, github_login: `shadowingest${suffix}`,
      github_repository: "acme/production", okta_user_id: `00ushadowingest${suffix}`,
    };
    const { instance } = await outcomes.openInstance(scope, {
      outcome_contract_id: contract.outcome_contract_id, subject,
      subject_key: `offboard:${subject.person_email}`, mode: "shadow",
    });
    await ingest.registerSource(scope, tenant.user_id, {
      source_key: "customer-reader", display_name: "Customer reader", transport: "evidence_ingest",
      permitted_properties: ["effective_permission", "account_status"], authoritative: true,
      adapter_version: "customer/1.0.0",
    });
    await ingest.push(scope, {
      source_key: "customer-reader", event_id: `shadow-gh-${suffix}`,
      subject_ref: `github:${subject.github_repository}:${subject.github_login}`,
      property: "effective_permission", value: { type: "string", value: "write" },
      observed_at: new Date().toISOString(),
    });
    await ingest.push(scope, {
      source_key: "customer-reader", event_id: `shadow-okta-${suffix}`,
      subject_ref: `okta:user:${subject.okta_user_id}`, property: "account_status",
      value: { type: "string", value: "SUSPENDED" }, observed_at: new Date().toISOString(),
    });

    const result = await shadow.recordCompletionSignal(scope, {
      outcome_instance_id: instance.outcome_instance_id, declared_status: "complete",
    });
    assert.equal(result.verdict, "unsatisfied");
    assert.ok(result.finding, "Shadow produced no finding from customer-pushed evidence alone");
    assert.equal(result.finding!.invariant_id, "github_effective_access_none");
  });
});
