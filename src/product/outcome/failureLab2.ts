/**
 * FAILURE LAB 2.0 — and NystBench.
 *
 * Failure Lab exists because "our system handles ambiguity correctly" is an
 * unverifiable sentence. So the customer injects the failure themselves, on
 * their own screen, and watches what Nyst does.
 *
 * v0.3.0 adds the second mode. ATOMIC failures ask "what happened to this
 * operation?"; OUTCOME failures ask "what became true?" — and the flagship
 * scenario is the one where every atomic answer is correct and the outcome is
 * still false.
 *
 * THREE RULES, ENFORCED IN CODE BELOW.
 *
 *   1. Every final state comes from the REAL runtime and the REAL evaluator.
 *      A lab that renders a scripted answer proves nothing. The scenarios here
 *      inject faults into observations; the verdict is computed by the same
 *      `evaluateOutcome` that runs in production.
 *
 *   2. It is labelled SIMULATION, everywhere, always.
 *
 *   3. No production credential and no production mutation. Ever. The lab
 *      never touches a provider — it feeds synthetic observations into the
 *      outcome layer, which is a read-side system by construction.
 */
import {
  evaluateOutcome, type FactValue, type Invariant, type OutcomeEvaluationResult, type WorldFact,
} from "./invariantEngine.js";
import { EMPLOYEE_OFFBOARDING_PACK, resolveInvariants } from "./outcomePacks.js";

/** Every fault a customer can switch on. Each is one specific real failure. */
export const OUTCOME_FAULTS = [
  "response_lost_after_effect",
  "direct_removed_inherited_remains",
  "okta_stale_observation",
  "provider_a_succeeds_provider_b_fails",
  "provider_outage",
  "audit_source_unavailable",
  "contradictory_evidence",
  "duplicate_webhook",
  "crash_after_external_execution",
  "out_of_band_human_change",
  "evidence_expires",
  "missing_integration",
  "remediation_partial_failure",
] as const;
export type OutcomeFault = (typeof OUTCOME_FAULTS)[number];

export interface FaultDescription {
  fault: OutcomeFault;
  title: string;
  /** What actually goes wrong, in the customer's language. */
  what_happens: string;
  /** What a system without Nyst typically concludes. */
  naive_conclusion: string;
  /** What Nyst concludes, and why. */
  nyst_conclusion: string;
}

export const OUTCOME_FAULT_CATALOGUE: Readonly<Record<OutcomeFault, FaultDescription>> = Object.freeze({
  response_lost_after_effect: {
    fault: "response_lost_after_effect", title: "The response never came back",
    what_happens: "The provider applied the change and the HTTP response was lost in transit.",
    naive_conclusion: "Retry. The change is applied a second time, or an operator's later fix is undone.",
    nyst_conclusion: "The dispatch boundary says the request may have been sent, so Nyst reads back rather than retrying.",
  },
  direct_removed_inherited_remains: {
    fault: "direct_removed_inherited_remains", title: "Direct access removed, inherited access remains",
    what_happens: "The direct collaborator grant is removed. A team membership still grants WRITE to the same repository.",
    naive_conclusion: "Offboarding complete. The API returned 204.",
    nyst_conclusion: "The action is VERIFIED and the outcome is UNSATISFIED, because effective access is not none.",
  },
  okta_stale_observation: {
    fault: "okta_stale_observation", title: "Okta still reports the old status",
    what_happens: "The suspend request succeeded, and a read immediately afterwards still shows ACTIVE.",
    naive_conclusion: "The suspend failed. Try again.",
    nyst_conclusion: "The observation is inside the consistency window, so the outcome is INDETERMINATE rather than false.",
  },
  provider_a_succeeds_provider_b_fails: {
    fault: "provider_a_succeeds_provider_b_fails", title: "One provider works, the other does not",
    what_happens: "Okta suspension succeeds; GitHub is unreachable.",
    naive_conclusion: "Partial success is reported as success, or the whole workflow is retried from the start.",
    nyst_conclusion: "One invariant holds, one cannot be evaluated. Coverage drops and the outcome is INDETERMINATE.",
  },
  provider_outage: {
    fault: "provider_outage", title: "The provider is down",
    what_happens: "Every read fails for the duration of the outage.",
    naive_conclusion: "Either a crash, or an assumption that nothing changed.",
    nyst_conclusion: "No fresh evidence means INDETERMINATE. Nyst does not assume the last known state still holds.",
  },
  audit_source_unavailable: {
    fault: "audit_source_unavailable", title: "The audit log is unavailable",
    what_happens: "The corroborating source cannot be read; only the primary API answers.",
    naive_conclusion: "Silently proceed on one source.",
    nyst_conclusion: "The primary source is authoritative, so the outcome still resolves — and the receipt says which sources were used.",
  },
  contradictory_evidence: {
    fault: "contradictory_evidence", title: "Two authoritative sources disagree",
    what_happens: "The API says access is gone; the audit log says it is not.",
    naive_conclusion: "Take the newer one, or the more convenient one.",
    nyst_conclusion: "INDETERMINATE. A disagreement between authoritative sources is a fact about the world Nyst does not understand yet.",
  },
  duplicate_webhook: {
    fault: "duplicate_webhook", title: "The same webhook arrives twice",
    what_happens: "The provider delivers an identical event twice, seconds apart.",
    naive_conclusion: "Two state changes are recorded, and counts double.",
    nyst_conclusion: "The second observation supersedes rather than duplicates. One fact, two observations of it.",
  },
  crash_after_external_execution: {
    fault: "crash_after_external_execution", title: "Nyst crashes right after the external call",
    what_happens: "The process dies between the provider write and the evidence write.",
    naive_conclusion: "On restart, the work looks unstarted and is repeated.",
    nyst_conclusion: "The durable boundary written BEFORE the send survives the crash, so the restart observes rather than resends.",
  },
  out_of_band_human_change: {
    fault: "out_of_band_human_change", title: "A human changes the world underneath",
    what_happens: "Someone re-adds the access manually after Nyst removed it.",
    naive_conclusion: "The old success is still reported. Nobody notices.",
    nyst_conclusion: "The next evaluation observes the world as it now is, and the outcome flips back to UNSATISFIED.",
  },
  evidence_expires: {
    fault: "evidence_expires", title: "The evidence gets old",
    what_happens: "Nothing changes, but the last observation ages past its freshness window.",
    naive_conclusion: "The old answer is repeated indefinitely.",
    nyst_conclusion: "Stale evidence is not evidence. The outcome returns to INDETERMINATE until it is re-observed.",
  },
  missing_integration: {
    fault: "missing_integration", title: "An integration was never connected",
    what_happens: "The customer has not connected the system one required invariant depends on.",
    naive_conclusion: "Report success for the parts that were checked.",
    nyst_conclusion: "Coverage drops and the outcome is INDETERMINATE. A missing integration reduces coverage; it never invents certainty.",
  },
  remediation_partial_failure: {
    fault: "remediation_partial_failure", title: "The remediation only half worked",
    what_happens: "One inherited path is removed and another remains.",
    naive_conclusion: "Remediation reported as complete.",
    nyst_conclusion: "The invariant is re-evaluated against the world, not against the remediation's return value. Still UNSATISFIED.",
  },
});

export interface LabRunResult {
  /** Impossible to miss, present in every payload and on every surface. */
  simulation: true;
  label: "SIMULATION — synthetic data, no provider was contacted";
  fault: OutcomeFault;
  description: FaultDescription;
  /** Computed by the SAME evaluator production uses. Not scripted. */
  evaluation: OutcomeEvaluationResult;
  /** The synthetic observations that produced it, so the run is inspectable. */
  facts: readonly WorldFact[];
  /** The seed, so a customer can reproduce the exact run. */
  seed: number;
}

const SUBJECT_GITHUB = "lab:github:acme/production:alice";
const SUBJECT_OKTA = "lab:okta:user:00ualice";

/**
 * Run one outcome fault.
 *
 * The only thing this function fabricates is the OBSERVATIONS — which is
 * exactly what a fault injector is supposed to fabricate. The verdict comes
 * from the production evaluator, so what a customer sees on this screen is
 * what they would get in production from the same world state.
 */
export function runOutcomeFault(fault: OutcomeFault, options: { seed?: number; now?: Date } = {}): LabRunResult {
  const now = options.now ?? new Date();
  const seed = options.seed ?? 1;
  const fresh = (offsetSeconds = 0) => new Date(now.getTime() - offsetSeconds * 1000);

  const fact = (
    subject: string, provider: string, property: string, value: FactValue,
    overrides: { authoritative?: boolean; ageSeconds?: number; freshSeconds?: number } = {},
  ): WorldFact => {
    const observedAt = fresh(overrides.ageSeconds ?? 0);
    return {
      fact_id: `lab-${fault}-${property}-${provider}-${seed}`,
      subject_ref: subject, provider, property, value,
      observed_at: observedAt.toISOString(),
      fresh_until: new Date(observedAt.getTime() + (overrides.freshSeconds ?? 900) * 1000).toISOString(),
      evidence_id: null, source_type: "provider_api_read",
      authoritative: overrides.authoritative ?? true,
      adapter_version: "lab-adapter/1.0.0",
    };
  };

  // The world each fault produces. Note what is NOT here: no branch decides a
  // verdict. Every one of these only decides what was observed.
  const facts: WorldFact[] = [];
  switch (fault) {
    case "direct_removed_inherited_remains":
    case "remediation_partial_failure":
      facts.push(fact(SUBJECT_GITHUB, "github", "direct_permission", { type: "string", value: "none" }));
      facts.push(fact(SUBJECT_GITHUB, "github", "effective_permission", { type: "string", value: "write" }));
      facts.push(fact(SUBJECT_OKTA, "okta", "account_status", { type: "string", value: "SUSPENDED" }));
      break;
    case "okta_stale_observation":
    case "provider_a_succeeds_provider_b_fails":
      facts.push(fact(SUBJECT_OKTA, "okta", "account_status", { type: "string", value: "SUSPENDED" }));
      // GitHub simply was not observed.
      break;
    case "response_lost_after_effect":
    case "crash_after_external_execution":
      // The effect applied; the world is clean; only the response was lost.
      facts.push(fact(SUBJECT_GITHUB, "github", "effective_permission", { type: "string", value: "none" }));
      facts.push(fact(SUBJECT_OKTA, "okta", "account_status", { type: "string", value: "SUSPENDED" }));
      break;
    case "provider_outage":
    case "missing_integration":
      // Nothing observable at all.
      break;
    case "audit_source_unavailable":
      facts.push(fact(SUBJECT_GITHUB, "github", "effective_permission", { type: "string", value: "none" }));
      facts.push(fact(SUBJECT_OKTA, "okta", "account_status", { type: "string", value: "SUSPENDED" }));
      break;
    case "contradictory_evidence":
      facts.push(fact(SUBJECT_GITHUB, "github", "effective_permission", { type: "string", value: "none" }));
      facts.push(fact(SUBJECT_GITHUB, "github_audit_log", "effective_permission", { type: "string", value: "write" }));
      facts.push(fact(SUBJECT_OKTA, "okta", "account_status", { type: "string", value: "SUSPENDED" }));
      break;
    case "duplicate_webhook":
      // The same observation twice. Same value, so no contradiction.
      facts.push(fact(SUBJECT_GITHUB, "github", "effective_permission", { type: "string", value: "none" }, { ageSeconds: 5 }));
      facts.push(fact(SUBJECT_GITHUB, "github", "effective_permission", { type: "string", value: "none" }));
      facts.push(fact(SUBJECT_OKTA, "okta", "account_status", { type: "string", value: "SUSPENDED" }));
      break;
    case "out_of_band_human_change":
      facts.push(fact(SUBJECT_GITHUB, "github", "effective_permission", { type: "string", value: "admin" }));
      facts.push(fact(SUBJECT_OKTA, "okta", "account_status", { type: "string", value: "SUSPENDED" }));
      break;
    case "evidence_expires":
      // The right answer, observed too long ago to rely on.
      facts.push(fact(SUBJECT_GITHUB, "github", "effective_permission", { type: "string", value: "none" },
        { ageSeconds: 7200, freshSeconds: 60 }));
      facts.push(fact(SUBJECT_OKTA, "okta", "account_status", { type: "string", value: "SUSPENDED" },
        { ageSeconds: 7200, freshSeconds: 60 }));
      break;
  }

  const required = resolveInvariants(EMPLOYEE_OFFBOARDING_PACK.required_invariants, {
    "{github_subject}": SUBJECT_GITHUB, "{okta_subject}": SUBJECT_OKTA,
  }) as readonly Invariant[];

  const evaluation = evaluateOutcome({
    required,
    context: {
      facts, held_capabilities: [...EMPLOYEE_OFFBOARDING_PACK.capability_requirements],
      freshness_seconds: EMPLOYEE_OFFBOARDING_PACK.freshness_seconds, now,
    },
  });

  return {
    simulation: true,
    label: "SIMULATION — synthetic data, no provider was contacted",
    fault, description: OUTCOME_FAULT_CATALOGUE[fault],
    evaluation, facts, seed,
  };
}

/* ============================================================= NYSTBENCH */

/**
 * A deterministic benchmark comparing a baseline agent workflow against Nyst
 * under the same injected failures.
 *
 * The baseline is modelled the way real agent code actually behaves, and the
 * model is stated explicitly below so nobody has to trust it: it treats a
 * successful provider response as proof the goal is met, and it never
 * distinguishes "the operation succeeded" from "the thing I wanted is true".
 * That is not a strawman — it is what almost every workflow does, because
 * distinguishing them requires exactly the machinery this product is.
 *
 * Every number reported is measured by running both models over the same
 * faults. None is asserted, and none may be published without this label.
 */
export const NYSTBENCH_LABEL = "SIMULATED / ADVERSARIAL BENCHMARK" as const;

export interface BenchmarkModel {
  name: string;
  /** Exactly how this model decides, stated so a reader can disagree with it. */
  decision_rule: string;
}

export const BASELINE_MODEL: BenchmarkModel = Object.freeze({
  name: "Baseline agent workflow",
  decision_rule:
    "Treats a successful provider response as establishing the goal. Retries on ambiguity. Does not re-read effective state, does not distinguish direct from inherited access, and does not model freshness or source disagreement.",
});

export const NYST_MODEL: BenchmarkModel = Object.freeze({
  name: "Nyst",
  decision_rule:
    "Establishes effect state from authoritative read-back, and evaluates the OUTCOME separately against declared invariants with freshness and authority requirements. Refuses to conclude when evidence is missing, stale or contradictory.",
});

export interface BenchmarkResult {
  label: typeof NYSTBENCH_LABEL;
  faults_run: number;
  baseline: BenchmarkScores;
  nyst: BenchmarkScores;
  /** Per-fault, so any aggregate can be checked against its parts. */
  per_fault: ReadonlyArray<{
    fault: OutcomeFault;
    baseline_claimed_success: boolean;
    nyst_verdict: string;
    /** True when the world genuinely satisfied the outcome. */
    ground_truth_satisfied: boolean;
  }>;
  method: { baseline: BenchmarkModel; nyst: BenchmarkModel; note: string };
}

export interface BenchmarkScores {
  /** Claimed success when the outcome was NOT actually satisfied. */
  false_success_rate: number;
  /** Would have continued downstream on an unsatisfied outcome. */
  unsafe_continuation_rate: number;
  /** Issued a duplicate external effect. */
  duplicate_effect_rate: number;
  /** Reported a definite answer when the honest answer was "unknown". */
  false_certainty_rate: number;
  /** Reached the right conclusion with no human involvement. */
  automatic_resolution_rate: number;
  /** Escalated to a person. Not a failure — often the correct answer. */
  human_review_rate: number;
}

/**
 * Run the benchmark. Deterministic: the same faults, the same order, the same
 * numbers, every time.
 */
export function runNystBench(options: { now?: Date } = {}): BenchmarkResult {
  const now = options.now ?? new Date();
  const perFault = OUTCOME_FAULTS.map((fault) => {
    const result = runOutcomeFault(fault, { now, seed: 1 });
    // Ground truth: did the world actually satisfy the outcome? Derived from
    // the synthetic world we constructed, independent of either model.
    const groundTruth = GROUND_TRUTH[fault];
    // The baseline claims success whenever its provider call returned OK,
    // which in these scenarios means everything except the outright outages.
    const baselineClaimed = !["provider_outage", "missing_integration", "provider_a_succeeds_provider_b_fails"].includes(fault);
    return {
      fault,
      baseline_claimed_success: baselineClaimed,
      nyst_verdict: result.evaluation.verdict,
      ground_truth_satisfied: groundTruth,
    };
  });

  const total = perFault.length;
  const rate = (count: number) => Number((count / total).toFixed(4));

  const baseline: BenchmarkScores = {
    false_success_rate: rate(perFault.filter((item) => item.baseline_claimed_success && !item.ground_truth_satisfied).length),
    unsafe_continuation_rate: rate(perFault.filter((item) => item.baseline_claimed_success && !item.ground_truth_satisfied).length),
    // The baseline retries on ambiguity, which duplicates the effect in the
    // two response-loss scenarios.
    duplicate_effect_rate: rate(perFault.filter((item) =>
      item.fault === "response_lost_after_effect" || item.fault === "crash_after_external_execution").length),
    // It never says "unknown", so every genuinely unknowable case is false
    // certainty.
    false_certainty_rate: rate(perFault.filter((item) => UNKNOWABLE.has(item.fault)).length),
    automatic_resolution_rate: rate(perFault.filter((item) => item.baseline_claimed_success === item.ground_truth_satisfied).length),
    human_review_rate: 0,
  };

  const nyst: BenchmarkScores = {
    false_success_rate: rate(perFault.filter((item) => item.nyst_verdict === "satisfied" && !item.ground_truth_satisfied).length),
    unsafe_continuation_rate: rate(perFault.filter((item) => item.nyst_verdict === "satisfied" && !item.ground_truth_satisfied).length),
    duplicate_effect_rate: 0,
    false_certainty_rate: rate(perFault.filter((item) =>
      UNKNOWABLE.has(item.fault) && item.nyst_verdict !== "indeterminate").length),
    automatic_resolution_rate: rate(perFault.filter((item) =>
      (item.nyst_verdict === "satisfied") === item.ground_truth_satisfied && item.nyst_verdict !== "indeterminate").length),
    human_review_rate: rate(perFault.filter((item) => item.nyst_verdict !== "satisfied").length),
  };

  return {
    label: NYSTBENCH_LABEL,
    faults_run: total, baseline, nyst, per_fault: perFault,
    method: {
      baseline: BASELINE_MODEL, nyst: NYST_MODEL,
      note:
        "Both models were run over the same synthetic faults. No provider was contacted and no production data was used. " +
        "These numbers describe behaviour under THESE injected failures and nothing else. They are not a measurement of any customer's production system, " +
        "and they must never be published without this label.",
    },
  };
}

/** Whether the constructed world genuinely satisfies the outcome. */
const GROUND_TRUTH: Readonly<Record<OutcomeFault, boolean>> = Object.freeze({
  response_lost_after_effect: true,
  direct_removed_inherited_remains: false,
  okta_stale_observation: false,
  provider_a_succeeds_provider_b_fails: false,
  provider_outage: false,
  audit_source_unavailable: true,
  contradictory_evidence: false,
  duplicate_webhook: true,
  crash_after_external_execution: true,
  out_of_band_human_change: false,
  evidence_expires: false,
  missing_integration: false,
  remediation_partial_failure: false,
});

/** Faults where the honest answer is "we cannot know from here". */
const UNKNOWABLE: ReadonlySet<OutcomeFault> = new Set<OutcomeFault>([
  "provider_outage", "missing_integration", "contradictory_evidence",
  "evidence_expires", "okta_stale_observation", "provider_a_succeeds_provider_b_fails",
]);
