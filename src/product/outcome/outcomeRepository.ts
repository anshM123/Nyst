/**
 * THE OUTCOME REPOSITORY.
 *
 * Persistence and evaluation for the OUTCOME layer. It never touches a
 * provider: facts arrive here already observed, and everything below is a pure
 * decision over durable rows plus one signed statement at the end.
 *
 * The layer boundary is the point. `productRepository` answers "what happened
 * to this operation?"; this file answers "what became true in the world?".
 * Those questions have different answers all the time, and an architecture
 * that lets them share a table will eventually let them share an answer.
 */
import { randomUUID } from "node:crypto";
import type { ProductDb } from "../productRepository.js";
import type { TenantScope } from "../types.js";
import type { Signer } from "../../core/signing.js";
import { canonicalHash } from "../../core/canonical.js";
import {
  evaluateOutcome, OUTCOME_VERDICT_DEFINITIONS,
  type FactValue, type Invariant, type InvariantEvaluation, type OutcomeEvaluationResult, type OutcomeVerdict, type WorldFact,
} from "./invariantEngine.js";
import { outcomePack, resolveInvariants } from "./outcomePacks.js";

export type OutcomeLifecycle = "open" | "evaluating" | "settled" | "timed_out" | "cancelled";
export type ContinuationDisposition = "hold" | "allowed" | "blocked";

export interface OutcomeContractInput {
  outcome_spec: string;
  outcome_spec_version: string;
  agent_id?: string | null;
  subject_schema: Record<string, string>;
  desired_outcome_statement: string;
  required_invariants: readonly Invariant[];
  optional_invariants?: readonly Invariant[];
  evidence_requirements?: Record<string, readonly string[]>;
  freshness_seconds: number;
  capability_requirements?: readonly string[];
  effect_dependencies?: readonly string[];
  timeout_seconds: number;
  exception_policy?: Record<string, unknown>;
  remediation_policy?: Record<string, unknown>;
  continuation_policy?: Record<string, unknown>;
}

export interface OutcomeContract extends OutcomeContractInput {
  outcome_contract_id: string;
  contract_version: number;
  activated_at: string | null;
  required_invariants: readonly Invariant[];
  optional_invariants: readonly Invariant[];
  capability_requirements: readonly string[];
  effect_dependencies: readonly string[];
}

export interface OutcomeInstance {
  outcome_instance_id: string;
  outcome_contract_id: string;
  contract_version: number;
  agent_id: string | null;
  subject: Record<string, unknown>;
  subject_key: string;
  mode: "shadow" | "canary" | "enforced";
  verdict: OutcomeVerdict;
  lifecycle: OutcomeLifecycle;
  continuation_disposition: ContinuationDisposition;
  coverage_numerator: number;
  coverage_denominator: number;
  evidence_sequence: number;
  evaluation_sequence: number;
  started_at: string;
  deadline_at: string;
  satisfied_at: string | null;
  completed_at: string | null;
}

export interface WorldFactInput {
  subject_ref: string;
  provider: string;
  property: string;
  value: FactValue;
  observed_at: string;
  fresh_until: string;
  evidence_id?: string | null;
  source_type: WorldFact["source_type"];
  authoritative: boolean;
  provenance?: Record<string, unknown>;
  adapter_version: string;
}

export class OutcomeRepository {
  constructor(private readonly db: ProductDb) {}

  /* ------------------------------------------------------------ contracts */

  /**
   * Create the next contract version for an OutcomeSpec in this environment.
   *
   * Versions are never edited. An activated contract is immutable at the
   * database level, so an instance that ran in March keeps meaning what it
   * meant in March no matter what the customer changes in April.
   */
  async createContract(scope: TenantScope, userId: string, input: OutcomeContractInput): Promise<OutcomeContract> {
    if (!input.required_invariants.length) {
      throw Object.assign(new Error("An OutcomeContract must require at least one invariant"), { statusCode: 400 });
    }
    assertInvariantsAreDeclarative([...input.required_invariants, ...(input.optional_invariants ?? [])]);

    const id = randomUUID();
    const result = await this.db.query(
      `INSERT INTO nyst_outcome_contracts(outcome_contract_id,organization_id,project_id,environment_id,
         outcome_spec,outcome_spec_version,contract_version,agent_id,subject_schema,desired_outcome_statement,
         required_invariants,optional_invariants,evidence_requirements,freshness_seconds,capability_requirements,
         effect_dependencies,timeout_seconds,exception_policy,remediation_policy,continuation_policy,created_by)
       SELECT $1,$2,$3,$4,$5,$6,coalesce(max(contract_version),0)+1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
       FROM nyst_outcome_contracts WHERE environment_id=$4 AND outcome_spec=$5
       RETURNING outcome_contract_id,contract_version,activated_at`,
      [id, scope.organization_id, scope.project_id, scope.environment_id,
        input.outcome_spec, input.outcome_spec_version, input.agent_id ?? null,
        JSON.stringify(input.subject_schema), input.desired_outcome_statement,
        JSON.stringify(input.required_invariants), JSON.stringify(input.optional_invariants ?? []),
        JSON.stringify(input.evidence_requirements ?? {}), input.freshness_seconds,
        JSON.stringify(input.capability_requirements ?? []), JSON.stringify(input.effect_dependencies ?? []),
        input.timeout_seconds, JSON.stringify(input.exception_policy ?? {}),
        JSON.stringify(input.remediation_policy ?? {}), JSON.stringify(input.continuation_policy ?? {}), userId]);
    const row = result.rows[0]!;
    return {
      ...input,
      outcome_contract_id: String(row.outcome_contract_id),
      contract_version: Number(row.contract_version),
      activated_at: row.activated_at ? new Date(String(row.activated_at)).toISOString() : null,
      required_invariants: input.required_invariants,
      optional_invariants: input.optional_invariants ?? [],
      capability_requirements: input.capability_requirements ?? [],
      effect_dependencies: input.effect_dependencies ?? [],
    };
  }

  /**
   * Create a contract from a published Outcome Pack.
   *
   * Selecting an optional module makes its invariants REQUIRED — that is what
   * selecting it means. Leaving it unselected means Nyst makes no claim about
   * that area at all, and the pack says so in words that reach the UI.
   */
  async createContractFromPack(
    scope: TenantScope, userId: string, spec: string,
    options: { modules?: readonly string[]; agent_id?: string | null } = {},
  ): Promise<OutcomeContract & { uncovered: readonly string[] }> {
    const pack = outcomePack(spec);
    if (!pack) throw Object.assign(new Error(`Unknown Outcome Pack: ${spec}`), { statusCode: 400 });
    const selected = new Set(options.modules ?? []);
    for (const module of selected) {
      if (!pack.optional_modules.some((item) => item.module_id === module)) {
        throw Object.assign(new Error(`${spec} has no optional module named ${module}`), { statusCode: 400 });
      }
    }
    const modules = pack.optional_modules.filter((module) => selected.has(module.module_id));
    const contract = await this.createContract(scope, userId, {
      outcome_spec: pack.outcome_spec,
      outcome_spec_version: pack.outcome_spec_version,
      agent_id: options.agent_id ?? null,
      subject_schema: { ...pack.subject_schema },
      desired_outcome_statement: pack.desired_outcome_statement,
      // Selected modules become REQUIRED. An optional invariant that stayed
      // optional could never change a verdict, which would make selecting the
      // module purely decorative.
      required_invariants: [...pack.required_invariants, ...modules.flatMap((module) => module.invariants)],
      optional_invariants: [],
      evidence_requirements: { ...pack.evidence_requirements },
      freshness_seconds: pack.freshness_seconds,
      capability_requirements: [...pack.capability_requirements, ...modules.flatMap((module) => module.capability_requirements)],
      effect_dependencies: [...pack.supported_effect_specs],
      timeout_seconds: pack.timeout_seconds,
      remediation_policy: { options: pack.remediation },
    });
    return {
      ...contract,
      // Everything Nyst will NOT be claiming. Surfaced, not buried.
      uncovered: [
        ...pack.explicit_non_coverage,
        ...pack.optional_modules.filter((module) => !selected.has(module.module_id)).map((module) => module.uncovered_claim),
      ],
    };
  }

  async activateContract(scope: TenantScope, contractId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE nyst_outcome_contracts SET activated_at=now()
       WHERE outcome_contract_id=$1 AND environment_id=$2 AND organization_id=$3 AND activated_at IS NULL
       RETURNING outcome_contract_id`,
      [contractId, scope.environment_id, scope.organization_id]);
    return result.rows.length === 1;
  }

  async contract(scope: TenantScope, contractId: string): Promise<OutcomeContract | null> {
    const row = (await this.db.query(
      `SELECT * FROM nyst_outcome_contracts WHERE outcome_contract_id=$1 AND environment_id=$2 AND organization_id=$3`,
      [contractId, scope.environment_id, scope.organization_id])).rows[0];
    return row ? hydrateContract(row) : null;
  }

  /** The newest ACTIVATED contract for a spec. Draft versions never bind. */
  async activeContract(scope: TenantScope, spec: string): Promise<OutcomeContract | null> {
    const row = (await this.db.query(
      `SELECT * FROM nyst_outcome_contracts
       WHERE environment_id=$1 AND organization_id=$2 AND outcome_spec=$3 AND activated_at IS NOT NULL AND retired_at IS NULL
       ORDER BY contract_version DESC LIMIT 1`,
      [scope.environment_id, scope.organization_id, spec])).rows[0];
    return row ? hydrateContract(row) : null;
  }

  async contracts(scope: TenantScope): Promise<OutcomeContract[]> {
    return (await this.db.query(
      `SELECT * FROM nyst_outcome_contracts WHERE environment_id=$1 AND organization_id=$2
       ORDER BY outcome_spec, contract_version DESC`,
      [scope.environment_id, scope.organization_id])).rows.map(hydrateContract);
  }

  /* ------------------------------------------------------------ instances */

  /**
   * Open one concrete outcome.
   *
   * `subject_key` is the caller's stable identity for it. A retrying caller
   * gets the SAME instance back rather than a second offboarding for the same
   * person, which is the outcome-layer equivalent of the atomic action
   * identity guarantee.
   */
  async openInstance(scope: TenantScope, input: {
    outcome_contract_id: string;
    agent_id?: string | null;
    subject: Record<string, unknown>;
    subject_key: string;
    mode: "shadow" | "canary" | "enforced";
    now?: Date;
  }): Promise<{ instance: OutcomeInstance; created: boolean }> {
    const contract = await this.contract(scope, input.outcome_contract_id);
    if (!contract) throw Object.assign(new Error("Unknown OutcomeContract"), { statusCode: 404 });
    if (!contract.activated_at) throw Object.assign(new Error("This OutcomeContract has not been activated"), { statusCode: 409 });
    assertSubjectMatchesSchema(input.subject, contract.subject_schema);

    const now = input.now ?? new Date();
    const deadline = new Date(now.getTime() + contract.timeout_seconds * 1000);
    const inserted = await this.db.query(
      `INSERT INTO nyst_outcome_instances(outcome_instance_id,outcome_contract_id,contract_version,
         organization_id,project_id,environment_id,agent_id,subject,subject_key,mode,started_at,deadline_at,
         coverage_denominator)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (environment_id,outcome_contract_id,subject_key) DO NOTHING
       RETURNING *`,
      [randomUUID(), contract.outcome_contract_id, contract.contract_version,
        scope.organization_id, scope.project_id, scope.environment_id, input.agent_id ?? null,
        JSON.stringify(input.subject), input.subject_key, input.mode,
        now.toISOString(), deadline.toISOString(), contract.required_invariants.length]);
    if (inserted.rows.length) return { instance: hydrateInstance(inserted.rows[0]!), created: true };

    const existing = (await this.db.query(
      `SELECT * FROM nyst_outcome_instances WHERE environment_id=$1 AND outcome_contract_id=$2 AND subject_key=$3`,
      [scope.environment_id, contract.outcome_contract_id, input.subject_key])).rows[0]!;
    return { instance: hydrateInstance(existing), created: false };
  }

  async instance(scope: TenantScope, instanceId: string): Promise<OutcomeInstance | null> {
    const row = (await this.db.query(
      `SELECT * FROM nyst_outcome_instances WHERE outcome_instance_id=$1 AND environment_id=$2 AND organization_id=$3`,
      [instanceId, scope.environment_id, scope.organization_id])).rows[0];
    return row ? hydrateInstance(row) : null;
  }

  async instances(scope: TenantScope, limit = 50): Promise<OutcomeInstance[]> {
    return (await this.db.query(
      `SELECT * FROM nyst_outcome_instances WHERE environment_id=$1 AND organization_id=$2
       ORDER BY started_at DESC LIMIT $3`,
      [scope.environment_id, scope.organization_id, Math.min(Math.max(1, limit), 200)])).rows.map(hydrateInstance);
  }

  /** Link an atomic action underneath an outcome. Actions live below outcomes. */
  async linkAction(instanceId: string, actionId: string, dependencyKey: string): Promise<void> {
    await this.db.query(
      `INSERT INTO nyst_outcome_actions(outcome_instance_id,action_id,dependency_key)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [instanceId, actionId, dependencyKey]);
  }

  async linkedActions(instanceId: string): Promise<Array<{ action_id: string; dependency_key: string }>> {
    return (await this.db.query(
      `SELECT action_id,dependency_key FROM nyst_outcome_actions WHERE outcome_instance_id=$1 ORDER BY linked_at`,
      [instanceId])).rows.map((row) => ({ action_id: String(row.action_id), dependency_key: String(row.dependency_key) }));
  }

  /* ----------------------------------------------------------- world facts */

  /**
   * Record an observation of the world.
   *
   * A newer observation SUPERSEDES an older one for the same subject and
   * property rather than replacing it. The old row stays readable forever,
   * because "what did Nyst believe at 14:02, and on what basis" is the
   * question a customer will eventually need answered.
   */
  async recordFact(scope: TenantScope, input: WorldFactInput): Promise<WorldFact> {
    const id = randomUUID();
    const previous = (await this.db.query(
      `SELECT fact_id FROM nyst_world_facts
       WHERE environment_id=$1 AND subject_ref=$2 AND property=$3 AND provider=$4 AND superseded_at IS NULL
       ORDER BY observed_at DESC LIMIT 1`,
      [scope.environment_id, input.subject_ref, input.property, input.provider])).rows[0];

    const inserted = await this.db.query(
      `INSERT INTO nyst_world_facts(fact_id,organization_id,project_id,environment_id,subject_ref,provider,property,
         value,value_type,observed_at,fresh_until,evidence_id,source_type,authoritative,provenance,adapter_version,supersedes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [id, scope.organization_id, scope.project_id, scope.environment_id, input.subject_ref, input.provider, input.property,
        JSON.stringify(input.value), input.value.type, input.observed_at, input.fresh_until,
        input.evidence_id ?? null, input.source_type, input.authoritative,
        JSON.stringify(input.provenance ?? {}), input.adapter_version, previous ? previous.fact_id : null]);

    if (previous) {
      await this.db.query(`UPDATE nyst_world_facts SET superseded_at=now() WHERE fact_id=$1`, [previous.fact_id]);
    }
    return hydrateFact(inserted.rows[0]!);
  }

  /** Current, non-superseded facts for a set of subjects. */
  async currentFacts(scope: TenantScope, subjectRefs: readonly string[]): Promise<WorldFact[]> {
    if (!subjectRefs.length) return [];
    return (await this.db.query(
      `SELECT * FROM nyst_world_facts
       WHERE environment_id=$1 AND subject_ref = ANY($2::text[]) AND superseded_at IS NULL
       ORDER BY observed_at DESC`,
      [scope.environment_id, subjectRefs])).rows.map(hydrateFact);
  }

  /** Every observation ever recorded for one subject and property, newest first. */
  async factHistory(scope: TenantScope, subjectRef: string, property: string): Promise<WorldFact[]> {
    return (await this.db.query(
      `SELECT * FROM nyst_world_facts WHERE environment_id=$1 AND subject_ref=$2 AND property=$3
       ORDER BY observed_at DESC, recorded_at DESC`,
      [scope.environment_id, subjectRef, property])).rows.map(hydrateFact);
  }

  /* ----------------------------------------------------------- evaluation */

  /**
   * Evaluate one instance and durably record the verdict.
   *
   * The evaluation itself is the pure function in invariantEngine.ts. This
   * method's job is to gather the inputs, persist the result, and advance the
   * instance — including the continuation disposition, which is deliberately
   * NOT just a restatement of the verdict.
   */
  async evaluate(scope: TenantScope, instanceId: string, options: {
    held_capabilities?: readonly string[];
    now?: Date;
  } = {}): Promise<{ instance: OutcomeInstance; evaluation: OutcomeEvaluationResult }> {
    const instance = await this.instance(scope, instanceId);
    if (!instance) throw Object.assign(new Error("Unknown OutcomeInstance"), { statusCode: 404 });
    const contract = await this.contract(scope, instance.outcome_contract_id);
    if (!contract) throw new Error("The OutcomeInstance references a contract that no longer exists");

    const now = options.now ?? new Date();
    const subjectRefs = subjectReferences(instance.subject);
    const required = resolveInvariants(contract.required_invariants, subjectRefs);
    const optional = resolveInvariants(contract.optional_invariants, subjectRefs);
    const facts = await this.currentFacts(scope, [...new Set([...required, ...optional].map((item) => item.subject_ref))]);

    const evaluation = evaluateOutcome({
      required, optional,
      context: {
        facts, held_capabilities: options.held_capabilities ?? [],
        freshness_seconds: contract.freshness_seconds, now,
      },
    });

    const disposition = continuationFor(evaluation.verdict);
    const timedOut = now.getTime() > new Date(instance.deadline_at).getTime();
    const lifecycle: OutcomeLifecycle = timedOut && evaluation.verdict !== "satisfied" ? "timed_out"
      : evaluation.verdict === "satisfied" ? "settled" : "open";

    const sequence = instance.evaluation_sequence + 1;
    await this.db.query(
      `INSERT INTO nyst_outcome_evaluations(outcome_evaluation_id,outcome_instance_id,environment_id,project_id,organization_id,
         evaluation_sequence,status,verdict,detail,completed_at)
       VALUES($1,$2,$3,$4,$5,$6,'completed',$7,$8,now())`,
      [randomUUID(), instanceId, scope.environment_id, scope.project_id, scope.organization_id,
        sequence, evaluation.verdict, JSON.stringify(evaluationDetail(evaluation))]);

    const updated = await this.db.query(
      `UPDATE nyst_outcome_instances
         SET verdict=$2, lifecycle=$3, continuation_disposition=$4,
             coverage_numerator=$5, coverage_denominator=$6,
             evaluation_sequence=$7,
             satisfied_at=CASE WHEN $2='satisfied' AND satisfied_at IS NULL THEN now() ELSE satisfied_at END,
             completed_at=CASE WHEN $3 IN ('settled','timed_out','cancelled') THEN now() ELSE NULL END
       WHERE outcome_instance_id=$1 AND evaluation_sequence=$8
       RETURNING *`,
      [instanceId, evaluation.verdict, lifecycle, disposition,
        evaluation.coverage.numerator, evaluation.coverage.denominator, sequence, instance.evaluation_sequence]);

    if (!updated.rows.length) {
      // Someone else evaluated concurrently. Their verdict is at least as
      // fresh as ours, so we do not overwrite it — a stale evaluator must
      // never move an instance backwards.
      const current = await this.instance(scope, instanceId);
      return { instance: current!, evaluation };
    }
    return { instance: hydrateInstance(updated.rows[0]!), evaluation };
  }

  async evaluations(scope: TenantScope, instanceId: string): Promise<Record<string, unknown>[]> {
    return (await this.db.query(
      `SELECT outcome_evaluation_id,evaluation_sequence,status,verdict,detail,requested_at,completed_at
       FROM nyst_outcome_evaluations WHERE outcome_instance_id=$1 AND environment_id=$2
       ORDER BY evaluation_sequence DESC`,
      [instanceId, scope.environment_id])).rows;
  }

  /* ------------------------------------------------------------- receipts */

  /**
   * Sign a statement about the world.
   *
   * An Outcome Receipt is issued for any settled verdict, not only a happy
   * one: "Nyst could not establish that this employee lost access, and here is
   * exactly which invariant it could not establish" is the more valuable
   * document of the two, and the one a customer needs during an incident.
   */
  async issueReceipt(scope: TenantScope, instanceId: string, signer: Signer): Promise<Record<string, unknown>> {
    const instance = await this.instance(scope, instanceId);
    if (!instance) throw Object.assign(new Error("Unknown OutcomeInstance"), { statusCode: 404 });
    const contract = await this.contract(scope, instance.outcome_contract_id);
    if (!contract) throw new Error("The OutcomeInstance references a contract that no longer exists");
    const latest = (await this.evaluations(scope, instanceId))[0];
    if (!latest) throw Object.assign(new Error("This outcome has never been evaluated"), { statusCode: 409 });

    const payload = {
      receipt_type: "nyst.outcome.v1",
      outcome_instance_id: instance.outcome_instance_id,
      outcome_spec: contract.outcome_spec,
      outcome_spec_version: contract.outcome_spec_version,
      outcome_contract_id: contract.outcome_contract_id,
      contract_version: instance.contract_version,
      desired_outcome_statement: contract.desired_outcome_statement,
      subject: instance.subject,
      mode: instance.mode,
      verdict: instance.verdict,
      verdict_definition: OUTCOME_VERDICT_DEFINITIONS[instance.verdict],
      continuation_disposition: instance.continuation_disposition,
      coverage: { numerator: instance.coverage_numerator, denominator: instance.coverage_denominator },
      evaluation_sequence: instance.evaluation_sequence,
      invariants: (latest.detail as { required?: unknown }).required ?? [],
      started_at: instance.started_at,
      satisfied_at: instance.satisfied_at,
      issued_for_environment: scope.environment_id,
    };
    // Signed over the canonical form, so a receipt that has been re-ordered,
    // re-indented or round-tripped through a different JSON writer still
    // verifies, and one whose CONTENT changed does not.
    // canonicalHash is prefixed ("sha256:..."); the column stores the bare
    // digest so it is directly comparable with any other sha256 hex.
    const hash = canonicalHash(payload).replace(/^sha256:/, "");
    const signature = signer.sign(payload);

    const inserted = await this.db.query(
      `INSERT INTO nyst_outcome_receipts(outcome_receipt_id,outcome_instance_id,environment_id,project_id,organization_id,
         verdict,payload,payload_hash,signature,key_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (outcome_instance_id) DO NOTHING
       RETURNING outcome_receipt_id,verdict,payload,payload_hash,signature,key_id,issued_at`,
      [randomUUID(), instanceId, scope.environment_id, scope.project_id, scope.organization_id,
        instance.verdict, JSON.stringify(payload), hash, signature.signature_b64, signature.key_id]);
    if (inserted.rows.length) return inserted.rows[0]!;

    // A receipt already exists. It is immutable, so return the original rather
    // than issuing a second statement about the same instant.
    return (await this.db.query(
      `SELECT outcome_receipt_id,verdict,payload,payload_hash,signature,key_id,issued_at
       FROM nyst_outcome_receipts WHERE outcome_instance_id=$1`, [instanceId])).rows[0]!;
  }

  async receipt(scope: TenantScope, instanceId: string): Promise<Record<string, unknown> | null> {
    return (await this.db.query(
      `SELECT outcome_receipt_id,verdict,payload,payload_hash,signature,key_id,issued_at
       FROM nyst_outcome_receipts WHERE outcome_instance_id=$1 AND environment_id=$2 AND organization_id=$3`,
      [instanceId, scope.environment_id, scope.organization_id])).rows[0] ?? null;
  }
}

/* ============================================================== helpers */

/**
 * Continuation is not a synonym for the verdict.
 *
 * SATISFIED permits continuation. UNSATISFIED and INDETERMINATE both HOLD it —
 * not because they mean the same thing, but because what software may do next
 * is the same in both cases: nothing automatic. The verdict is what carries
 * the difference, and the incident text says which one it is.
 *
 * `blocked` is deliberately NOT reachable from a verdict. It belongs to the
 * AUTHORITY layer: a Freeze, an AutonomyLine, or an exhausted Blast Radius
 * budget blocks continuation regardless of what the world looks like. Deriving
 * it here would blur the layer that says "what is true" into the layer that
 * says "what you may do", which is exactly what v0.3.0 exists to separate.
 */
export function continuationFor(verdict: OutcomeVerdict): ContinuationDisposition {
  switch (verdict) {
    case "satisfied": return "allowed";
    // Nyst observed the world and it does not match. A human may authorize
    // remediation; nothing proceeds on its own.
    case "unsatisfied": return "hold";
    // Nyst could not see. Proceeding would be acting on an assumption.
    case "indeterminate": return "hold";
  }
}

function evaluationDetail(evaluation: OutcomeEvaluationResult): Record<string, unknown> {
  const shape = (item: InvariantEvaluation) => ({
    invariant_id: item.invariant_id, statement: item.statement, operator: item.operator,
    result: item.result, reason: item.reason,
    facts_used: item.facts_used, evidence_ids: item.evidence_ids,
    missing_facts: item.missing_facts, contradictions: item.contradictions,
    oldest_observed_at: item.oldest_observed_at,
  });
  return {
    verdict: evaluation.verdict,
    required: evaluation.required.map(shape),
    optional: evaluation.optional.map(shape),
    coverage: evaluation.coverage,
    primary_reason: evaluation.primary_reason,
  };
}

/**
 * Subject placeholders, resolved to concrete references.
 *
 * The pack declares invariants against `{github_subject}`; an instance's
 * subject supplies the repository and login that make it concrete.
 */
export function subjectReferences(subject: Record<string, unknown>): Record<string, string> {
  const value = (key: string): string => String(subject[key] ?? "");
  const refs: Record<string, string> = {};
  if (subject.github_repository && subject.github_login) {
    refs["{github_subject}"] = `github:${value("github_repository")}:${value("github_login")}`;
  }
  if (subject.okta_user_id) refs["{okta_subject}"] = `okta:user:${value("okta_user_id")}`;
  if (subject.aws_principal) refs["{aws_subject}"] = `aws:principal:${value("aws_principal")}`;
  return refs;
}

/**
 * Reject anything that smells like executable policy.
 *
 * The contract stores invariants as data. If a field ever arrives carrying a
 * function, a script, a URL to fetch, or an expression to evaluate, that is a
 * different product with a different threat model, and it does not get to
 * appear by accident.
 */
function assertInvariantsAreDeclarative(invariants: readonly Invariant[]): void {
  for (const invariant of invariants) {
    for (const [key, value] of Object.entries(invariant)) {
      if (typeof value === "function") {
        throw Object.assign(new Error(`Invariant ${invariant.invariant_id} carries executable code in ${key}. Invariants are data, never code.`), { statusCode: 400 });
      }
    }
    if (!invariant.invariant_id || !/^[a-z][a-z0-9_]{2,80}$/.test(invariant.invariant_id)) {
      throw Object.assign(new Error(`Invalid invariant id: ${invariant.invariant_id}`), { statusCode: 400 });
    }
    if (!invariant.statement || invariant.statement.length < 5) {
      throw Object.assign(new Error(`Invariant ${invariant.invariant_id} has no human-readable statement`), { statusCode: 400 });
    }
  }
}

function assertSubjectMatchesSchema(subject: Record<string, unknown>, schema: Record<string, string>): void {
  for (const [field, type] of Object.entries(schema)) {
    const value = subject[field];
    if (value === undefined || value === null) {
      throw Object.assign(new Error(`The subject is missing the required field ${field}`), { statusCode: 400 });
    }
    if (type === "string" && typeof value !== "string") {
      throw Object.assign(new Error(`The subject field ${field} must be a string`), { statusCode: 400 });
    }
  }
}

function hydrateContract(row: Record<string, unknown>): OutcomeContract {
  return {
    outcome_contract_id: String(row.outcome_contract_id),
    outcome_spec: String(row.outcome_spec),
    outcome_spec_version: String(row.outcome_spec_version),
    contract_version: Number(row.contract_version),
    agent_id: row.agent_id ? String(row.agent_id) : null,
    subject_schema: row.subject_schema as Record<string, string>,
    desired_outcome_statement: String(row.desired_outcome_statement),
    required_invariants: row.required_invariants as Invariant[],
    optional_invariants: (row.optional_invariants ?? []) as Invariant[],
    evidence_requirements: (row.evidence_requirements ?? {}) as Record<string, readonly string[]>,
    freshness_seconds: Number(row.freshness_seconds),
    capability_requirements: (row.capability_requirements ?? []) as string[],
    effect_dependencies: (row.effect_dependencies ?? []) as string[],
    timeout_seconds: Number(row.timeout_seconds),
    exception_policy: (row.exception_policy ?? {}) as Record<string, unknown>,
    remediation_policy: (row.remediation_policy ?? {}) as Record<string, unknown>,
    continuation_policy: (row.continuation_policy ?? {}) as Record<string, unknown>,
    activated_at: row.activated_at ? new Date(String(row.activated_at)).toISOString() : null,
  };
}

function hydrateInstance(row: Record<string, unknown>): OutcomeInstance {
  return {
    outcome_instance_id: String(row.outcome_instance_id),
    outcome_contract_id: String(row.outcome_contract_id),
    contract_version: Number(row.contract_version),
    agent_id: row.agent_id ? String(row.agent_id) : null,
    subject: row.subject as Record<string, unknown>,
    subject_key: String(row.subject_key),
    mode: row.mode as "shadow" | "canary" | "enforced",
    verdict: row.verdict as OutcomeVerdict,
    lifecycle: row.lifecycle as OutcomeLifecycle,
    continuation_disposition: row.continuation_disposition as ContinuationDisposition,
    coverage_numerator: Number(row.coverage_numerator),
    coverage_denominator: Number(row.coverage_denominator),
    evidence_sequence: Number(row.evidence_sequence),
    evaluation_sequence: Number(row.evaluation_sequence),
    started_at: new Date(String(row.started_at)).toISOString(),
    deadline_at: new Date(String(row.deadline_at)).toISOString(),
    satisfied_at: row.satisfied_at ? new Date(String(row.satisfied_at)).toISOString() : null,
    completed_at: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
  };
}

function hydrateFact(row: Record<string, unknown>): WorldFact {
  return {
    fact_id: String(row.fact_id),
    subject_ref: String(row.subject_ref),
    provider: String(row.provider),
    property: String(row.property),
    value: row.value as FactValue,
    observed_at: new Date(String(row.observed_at)).toISOString(),
    fresh_until: new Date(String(row.fresh_until)).toISOString(),
    evidence_id: row.evidence_id ? String(row.evidence_id) : null,
    source_type: String(row.source_type),
    authoritative: row.authoritative === true,
    adapter_version: String(row.adapter_version),
  };
}
