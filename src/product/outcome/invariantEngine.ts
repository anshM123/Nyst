/**
 * THE DETERMINISTIC INVARIANT ENGINE.
 *
 * This is the safety path. There is no LLM in it, no expression language, no
 * `eval`, no user-supplied code of any kind. An invariant is a small typed
 * record with one of nine operators, and evaluating it is a pure function of
 * (invariant, WorldFacts, now).
 *
 * That constraint is the product. A customer can read every invariant Nyst is
 * enforcing on their behalf and know exactly what it will do, and an auditor
 * can replay any historical evaluation and get the same answer. Neither is
 * possible if the safety decision runs arbitrary code.
 *
 * THREE-VALUED, ON PURPOSE.
 *
 * Every evaluation returns `true`, `false`, or `indeterminate`. The third is
 * not a failure mode, it is the honest answer to "we could not see". A missing
 * fact, a stale fact, and two authoritative sources that disagree are all
 * indeterminate — and an outcome is never SATISFIED on an indeterminate
 * invariant. Collapsing indeterminate into false would make Nyst cry wolf;
 * collapsing it into true would make Nyst lie.
 */

/** The complete operator set. There are no others, and none of them is code. */
export const INVARIANT_OPERATORS = [
  "equals", "not_equals", "exists", "all", "any", "count", "zero", "freshness", "capability_present",
] as const;
export type InvariantOperator = (typeof INVARIANT_OPERATORS)[number];

export type InvariantResult = "true" | "false" | "indeterminate";

/** A typed value as stored on a WorldFact. Comparison never guesses a type. */
export type FactValue =
  | { type: "string"; value: string }
  | { type: "integer"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "string_set"; value: readonly string[] }
  | { type: "timestamp"; value: string }
  | { type: "absent" };

export interface WorldFact {
  fact_id: string;
  subject_ref: string;
  provider: string;
  property: string;
  value: FactValue;
  observed_at: string;
  fresh_until: string;
  evidence_id: string | null;
  source_type: string;
  /** Corroborative facts cannot, alone, establish a required invariant. */
  authoritative: boolean;
  adapter_version: string;
}

/**
 * One invariant.
 *
 * `subject_ref` and `property` name the fact. `expected` is a literal, never a
 * reference to another fact — comparing two moving values is a different and
 * much more dangerous feature, and this product does not need it.
 */
export interface Invariant {
  invariant_id: string;
  /** The sentence shown to a human when this invariant is the reason. */
  statement: string;
  operator: InvariantOperator;
  /** Which subject this is about, resolved against the OutcomeInstance subject. */
  subject_ref: string;
  /** Which property of that subject. Not used by `capability_present`. */
  property: string;
  /** The literal being compared against. Shape depends on the operator. */
  expected?: FactValue;
  /**
   * For `all` / `any` / `count` / `zero`: the members being quantified over.
   * `any` is only permitted when `any_is_safe` is explicitly true, because
   * "at least one source says access is gone" is usually the WRONG question.
   */
  members?: readonly string[];
  any_is_safe?: boolean;
  /** For `count`: the exact expected cardinality. */
  expected_count?: number;
  /** For `freshness`: how recent the fact must be, in seconds. */
  max_age_seconds?: number;
  /** For `capability_present`: the capability token that must be held. */
  capability?: string;
  /**
   * Whether a corroborative (non-authoritative) fact may satisfy this. Default
   * false: a required invariant demands authoritative evidence.
   */
  accepts_corroborative?: boolean;
}

export interface InvariantEvaluation {
  invariant_id: string;
  statement: string;
  operator: InvariantOperator;
  result: InvariantResult;
  /** The fact ids this evaluation actually rested on. */
  facts_used: readonly string[];
  /** The atomic evidence ids behind those facts. */
  evidence_ids: readonly string[];
  /** The oldest observation this rested on, so freshness is auditable. */
  oldest_observed_at: string | null;
  /** Facts that were required and absent. */
  missing_facts: readonly string[];
  /** Authoritative sources that disagreed. Any contradiction is indeterminate. */
  contradictions: readonly string[];
  /** Why the engine returned what it returned, in one sentence a person reads. */
  reason: string;
}

export interface InvariantContext {
  facts: readonly WorldFact[];
  /** Capability tokens currently held, for `capability_present`. */
  held_capabilities: readonly string[];
  /** Contract-level freshness ceiling. A fact older than this is never used. */
  freshness_seconds: number;
  now: Date;
}

/**
 * Evaluate one invariant. Pure: same inputs, same output, forever.
 */
export function evaluateInvariant(invariant: Invariant, context: InvariantContext): InvariantEvaluation {
  const base = {
    invariant_id: invariant.invariant_id, statement: invariant.statement, operator: invariant.operator,
    facts_used: [] as string[], evidence_ids: [] as string[], oldest_observed_at: null as string | null,
    missing_facts: [] as string[], contradictions: [] as string[],
  };

  if (invariant.operator === "capability_present") {
    const capability = invariant.capability ?? "";
    const held = context.held_capabilities.includes(capability);
    return {
      ...base,
      result: held ? "true" : "false",
      reason: held
        ? `The capability ${capability} is currently held.`
        : `The capability ${capability} is not held, so Nyst cannot observe what this invariant is about.`,
    };
  }

  const quantified = invariant.operator === "all" || invariant.operator === "any"
    || invariant.operator === "count" || invariant.operator === "zero";

  if (quantified) return evaluateQuantified(invariant, context, base);

  const selected = selectFact(invariant, context);
  if (selected.kind === "missing") {
    return { ...base, result: "indeterminate", missing_facts: [factKey(invariant.subject_ref, invariant.property)],
      reason: selected.reason };
  }
  if (selected.kind === "contradiction") {
    return { ...base, result: "indeterminate", contradictions: selected.contradictions,
      facts_used: selected.facts.map((fact) => fact.fact_id),
      evidence_ids: evidenceOf(selected.facts),
      oldest_observed_at: oldest(selected.facts),
      reason: selected.reason };
  }

  const fact = selected.fact;
  const used = {
    facts_used: [fact.fact_id], evidence_ids: evidenceOf([fact]), oldest_observed_at: fact.observed_at,
  };

  switch (invariant.operator) {
    case "exists":
      return { ...base, ...used, result: fact.value.type === "absent" ? "false" : "true",
        reason: fact.value.type === "absent"
          ? `${invariant.property} was observed to be absent for ${invariant.subject_ref}.`
          : `${invariant.property} exists for ${invariant.subject_ref}.` };
    case "freshness": {
      const maxAge = invariant.max_age_seconds ?? context.freshness_seconds;
      const ageSeconds = (context.now.getTime() - new Date(fact.observed_at).getTime()) / 1000;
      return { ...base, ...used, result: ageSeconds <= maxAge ? "true" : "false",
        reason: ageSeconds <= maxAge
          ? `The observation is ${Math.round(ageSeconds)}s old, within the ${maxAge}s window.`
          : `The observation is ${Math.round(ageSeconds)}s old, outside the ${maxAge}s window this invariant requires.` };
    }
    case "equals":
    case "not_equals": {
      if (!invariant.expected) {
        return { ...base, ...used, result: "indeterminate",
          reason: "The invariant declares no expected value, so nothing can be compared." };
      }
      const comparison = compare(fact.value, invariant.expected);
      if (comparison === null) {
        // Different types are not "not equal"; they are incomparable, and
        // guessing which one the customer meant is exactly how a safety system
        // produces a confident wrong answer.
        return { ...base, ...used, result: "indeterminate",
          reason: `The observed value is a ${fact.value.type} and the invariant expects a ${invariant.expected.type}. Nyst will not compare across types.` };
      }
      const matches = invariant.operator === "equals" ? comparison : !comparison;
      return { ...base, ...used, result: matches ? "true" : "false",
        reason: `${invariant.property} for ${invariant.subject_ref} is ${describe(fact.value)}; the invariant requires it ${invariant.operator === "equals" ? "to be" : "not to be"} ${describe(invariant.expected)}.` };
    }
    default:
      return { ...base, ...used, result: "indeterminate", reason: "Unsupported operator." };
  }
}

function evaluateQuantified(
  invariant: Invariant,
  context: InvariantContext,
  base: Omit<InvariantEvaluation, "result" | "reason">,
): InvariantEvaluation {
  const members = invariant.members ?? [];
  if (!members.length) {
    return { ...base, result: "indeterminate",
      reason: "The invariant quantifies over an empty set of members, so it asserts nothing." };
  }
  if (invariant.operator === "any" && invariant.any_is_safe !== true) {
    // `any` is refused unless the contract author explicitly marked it safe.
    // "At least one source says the access is gone" is almost never the right
    // question — the right question is "does any source still see access?".
    return { ...base, result: "indeterminate",
      reason: "The `any` operator was used without an explicit any_is_safe declaration, so Nyst will not evaluate it." };
  }

  const perMember = members.map((member) => {
    // Each member is evaluated as a plain, unquantified invariant against its
    // own subject. Stripping `members` prevents infinite delegation.
    const { members: _quantified, ...single } = invariant;
    return {
      member,
      evaluation: evaluateInvariant({ ...single, operator: memberOperator(invariant), subject_ref: member }, context),
    };
  });

  const facts = perMember.flatMap((item) => item.evaluation.facts_used);
  const evidence = perMember.flatMap((item) => item.evaluation.evidence_ids);
  const missing = perMember.flatMap((item) => item.evaluation.missing_facts);
  const contradictions = perMember.flatMap((item) => item.evaluation.contradictions);
  const observed = perMember.map((item) => item.evaluation.oldest_observed_at).filter((value): value is string => value !== null);
  const shared = {
    facts_used: facts, evidence_ids: [...new Set(evidence)], missing_facts: missing, contradictions,
    oldest_observed_at: observed.length ? observed.sort()[0]! : null,
  };

  const results = perMember.map((item) => item.evaluation.result);
  const trues = results.filter((value) => value === "true").length;
  const falses = results.filter((value) => value === "false").length;
  const unknown = results.filter((value) => value === "indeterminate").length;

  switch (invariant.operator) {
    case "all":
      if (falses > 0) {
        const failing = perMember.filter((item) => item.evaluation.result === "false").map((item) => item.member);
        return { ...base, ...shared, result: "false", reason: `Not every member satisfies this: ${failing.join(", ")}.` };
      }
      if (unknown > 0) {
        const unseen = perMember.filter((item) => item.evaluation.result === "indeterminate").map((item) => item.member);
        return { ...base, ...shared, result: "indeterminate",
          reason: `Nyst could not establish this for ${unseen.join(", ")}, so it will not claim it holds for all of them.` };
      }
      return { ...base, ...shared, result: "true", reason: `All ${members.length} members satisfy this.` };
    case "any":
      if (trues > 0) return { ...base, ...shared, result: "true", reason: "At least one member satisfies this." };
      if (unknown > 0) {
        return { ...base, ...shared, result: "indeterminate",
          reason: "No member was observed to satisfy this, and some could not be observed at all." };
      }
      return { ...base, ...shared, result: "false", reason: "No member satisfies this." };
    case "count": {
      if (unknown > 0) {
        return { ...base, ...shared, result: "indeterminate",
          reason: "Some members could not be observed, so a count would be a guess." };
      }
      const expected = invariant.expected_count ?? 0;
      return { ...base, ...shared, result: trues === expected ? "true" : "false",
        reason: `${trues} of ${members.length} members satisfy this; the invariant requires exactly ${expected}.` };
    }
    case "zero": {
      if (unknown > 0) {
        // The most important indeterminate in the product. "We saw no access"
        // and "we could not look" are the same output to a careless engine, and
        // they are opposite facts.
        const unseen = perMember.filter((item) => item.evaluation.result === "indeterminate").map((item) => item.member);
        return { ...base, ...shared, result: "indeterminate",
          reason: `Nyst could not observe ${unseen.join(", ")}, so it cannot claim there are none. Not seeing access is not the same as seeing no access.` };
      }
      return { ...base, ...shared, result: trues === 0 ? "true" : "false",
        reason: trues === 0 ? "No member satisfies this, as required."
          : `${trues} member(s) still satisfy this, and the invariant requires none.` };
    }
    default:
      return { ...base, ...shared, result: "indeterminate", reason: "Unsupported quantified operator." };
  }
}

/** Which per-member operator a quantifier delegates to. */
function memberOperator(invariant: Invariant): InvariantOperator {
  return invariant.expected ? "equals" : "exists";
}

type Selection =
  | { kind: "fact"; fact: WorldFact }
  | { kind: "missing"; reason: string }
  | { kind: "contradiction"; contradictions: string[]; facts: WorldFact[]; reason: string };

/**
 * Choose the fact this invariant rests on.
 *
 * Three ways this can fail to produce one, and each is a different sentence:
 * nothing was observed, everything observed is stale, or two authoritative
 * sources disagree.
 */
function selectFact(invariant: Invariant, context: InvariantContext): Selection {
  const candidates = context.facts.filter(
    (fact) => fact.subject_ref === invariant.subject_ref && fact.property === invariant.property);
  if (!candidates.length) {
    return { kind: "missing", reason: `Nyst has no observation of ${invariant.property} for ${invariant.subject_ref}.` };
  }

  const fresh = candidates.filter((fact) => {
    const ageSeconds = (context.now.getTime() - new Date(fact.observed_at).getTime()) / 1000;
    return ageSeconds <= (invariant.max_age_seconds ?? context.freshness_seconds)
      && new Date(fact.fresh_until).getTime() > context.now.getTime();
  });
  if (!fresh.length) {
    return { kind: "missing",
      reason: `Every observation of ${invariant.property} for ${invariant.subject_ref} is outside the freshness window, so Nyst will not rely on it.` };
  }

  const usable = invariant.accepts_corroborative === true ? fresh : fresh.filter((fact) => fact.authoritative);
  if (!usable.length) {
    return { kind: "missing",
      reason: `Only corroborative observations of ${invariant.property} exist for ${invariant.subject_ref}, and this invariant requires an authoritative source.` };
  }

  // Two authoritative sources that disagree is not a tie to be broken by
  // recency. It is a fact about the world Nyst does not understand yet.
  const authoritative = usable.filter((fact) => fact.authoritative);
  const distinct = new Set(authoritative.map((fact) => JSON.stringify(fact.value)));
  if (distinct.size > 1) {
    return {
      kind: "contradiction",
      contradictions: [...new Set(authoritative.map((fact) => `${fact.provider}=${describe(fact.value)}`))],
      facts: authoritative,
      reason: `Authoritative sources disagree about ${invariant.property} for ${invariant.subject_ref}: ${[...new Set(authoritative.map((fact) => `${fact.provider} says ${describe(fact.value)}`))].join("; ")}.`,
    };
  }

  const newest = [...usable].sort((left, right) => right.observed_at.localeCompare(left.observed_at))[0]!;
  return { kind: "fact", fact: newest };
}

/** Typed comparison. Returns null when the two values are not comparable. */
function compare(observed: FactValue, expected: FactValue): boolean | null {
  if (observed.type === "absent" && expected.type === "absent") return true;
  if (observed.type !== expected.type) return null;
  switch (observed.type) {
    case "string": return observed.value === (expected as { value: string }).value;
    case "integer": return observed.value === (expected as { value: number }).value;
    case "boolean": return observed.value === (expected as { value: boolean }).value;
    case "timestamp": return new Date(observed.value).getTime() === new Date((expected as { value: string }).value).getTime();
    case "string_set": {
      const left = [...observed.value].sort();
      const right = [...(expected as { value: readonly string[] }).value].sort();
      return left.length === right.length && left.every((item, index) => item === right[index]);
    }
    default: return null;
  }
}

function describe(value: FactValue): string {
  switch (value.type) {
    case "absent": return "absent";
    case "string_set": return `[${value.value.join(", ")}]`;
    default: return String((value as { value: unknown }).value);
  }
}

function factKey(subject: string, property: string): string { return `${subject}#${property}`; }
function evidenceOf(facts: readonly WorldFact[]): string[] {
  return [...new Set(facts.map((fact) => fact.evidence_id).filter((value): value is string => value !== null))];
}
function oldest(facts: readonly WorldFact[]): string | null {
  return facts.length ? [...facts].map((fact) => fact.observed_at).sort()[0]! : null;
}

/* ======================================================== OUTCOME VERDICT */

/** Exactly three. Lifecycle lives elsewhere and is never mixed in here. */
export const OUTCOME_VERDICTS = ["satisfied", "unsatisfied", "indeterminate"] as const;
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];

export const OUTCOME_VERDICT_DEFINITIONS: Readonly<Record<OutcomeVerdict, string>> = Object.freeze({
  satisfied: "Every required invariant has sufficient, fresh, authoritative evidence that it holds.",
  unsatisfied: "At least one required invariant is positively FALSE. Nyst observed the world and the world does not match.",
  indeterminate: "Missing, stale, conflicting or insufficient evidence prevents a conclusion. Nyst does not know, and will not guess.",
});

export interface OutcomeEvaluationResult {
  verdict: OutcomeVerdict;
  /** Every required invariant, in contract order. */
  required: readonly InvariantEvaluation[];
  /** Optional invariants, evaluated for information. They never change the verdict. */
  optional: readonly InvariantEvaluation[];
  /** How much of the contract Nyst could actually evaluate. */
  coverage: { numerator: number; denominator: number };
  /** The single invariant a human should read first. Null when satisfied. */
  primary_reason: string | null;
  /** Every distinct fact id the verdict rests on. */
  facts_used: readonly string[];
  evidence_ids: readonly string[];
}

/**
 * Combine invariant results into one verdict.
 *
 * UNSATISFIED beats INDETERMINATE. If Nyst positively observed that Alice
 * still has production access, the fact that it could not check a second thing
 * does not soften that: the outcome is false, and saying "we're not sure"
 * would be less true, not more cautious.
 */
export function combineVerdict(
  required: readonly InvariantEvaluation[],
  optional: readonly InvariantEvaluation[] = [],
): OutcomeEvaluationResult {
  const falses = required.filter((item) => item.result === "false");
  const unknowns = required.filter((item) => item.result === "indeterminate");
  const verdict: OutcomeVerdict = falses.length ? "unsatisfied" : unknowns.length ? "indeterminate" : "satisfied";

  const primary = falses[0] ?? unknowns[0] ?? null;
  const all = [...required, ...optional];
  return {
    verdict,
    required, optional,
    // Coverage is about what Nyst could SEE, not about what was true. An
    // invariant that evaluated to false is covered; one that came back
    // indeterminate is not.
    coverage: { numerator: required.filter((item) => item.result !== "indeterminate").length, denominator: required.length },
    primary_reason: primary ? primary.reason : null,
    facts_used: [...new Set(all.flatMap((item) => item.facts_used))],
    evidence_ids: [...new Set(all.flatMap((item) => item.evidence_ids))],
  };
}

/**
 * Evaluate a whole contract. Pure, and therefore replayable: an auditor with
 * the same contract version and the same facts gets the same verdict.
 */
export function evaluateOutcome(input: {
  required: readonly Invariant[];
  optional?: readonly Invariant[];
  context: InvariantContext;
}): OutcomeEvaluationResult {
  return combineVerdict(
    input.required.map((invariant) => evaluateInvariant(invariant, input.context)),
    (input.optional ?? []).map((invariant) => evaluateInvariant(invariant, input.context)),
  );
}
