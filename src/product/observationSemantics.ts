/**
 * OBSERVATION SEMANTICS (v0.3.2 Phases 22 and 24).
 *
 * WHAT THIS EXISTS TO PREVENT.
 *
 * Nyst mutates a provider, reads back immediately, and the provider says the
 * change has not happened. There are two completely different reasons for that,
 * and they demand opposite answers:
 *
 *   the change did not apply           -> NOT_APPLIED, and say so
 *   the provider has not caught up yet -> PENDING, and look again
 *
 * Guessing wrong in the second case is the worst failure this system can have.
 * It is not "Nyst refused to answer" — it is Nyst stating confidently that
 * access was not removed when it was, or that it was removed when it was not.
 *
 * WHY THIS IS NOT `sleep(2000)`.
 *
 * A sleep is a guess about a provider's internals, encoded as a magic number,
 * that nobody can revisit because nothing records what it was for. It is also
 * wrong in both directions at once: too short for a provider having a bad day,
 * and pure latency added to every action for a provider that was already
 * consistent.
 *
 * What replaces it is a DECLARATION per EffectSpec: how this provider is
 * authoritatively observed, how long its reads are trusted, how long it may
 * plausibly take to converge, and how long Nyst will keep asking before it
 * stops and says so. Those are properties of the provider, they belong with the
 * EffectSpec, and they are the kind of thing that gets MEASURED and updated
 * rather than guessed once.
 *
 * EVERY VALUE BELOW IS A DECLARED EXPECTATION, NOT A MEASUREMENT. None of these
 * has been calibrated against a live provider. `measured_at: null` says so, and
 * a live verification pass is what turns it into a number anyone should trust.
 */

export type ObservationMechanism =
  /** A direct read of the resource that was changed. The strongest. */
  | "resource_read"
  /** A read of a derived or aggregated view. Weaker: it can lag its own source. */
  | "derived_read"
  /** The provider tells us. Strong when it arrives, silent when it does not. */
  | "provider_webhook"
  /** An audit log. Authoritative about the past, often slow about the present. */
  | "audit_log";

export interface EffectObservationSemantics {
  effect_name: string;
  /** How the world is authoritatively observed for THIS effect. */
  mechanism: ObservationMechanism;
  /**
   * How long an observation stays trustworthy. After this, a fact is stale and
   * an outcome depending on it becomes INDETERMINATE rather than keeping a
   * verdict nothing currently supports.
   */
  freshness_seconds: number;
  /**
   * How long this provider may plausibly take to converge after a mutation.
   *
   * A contradictory read INSIDE this window means PENDING. Outside it, repeated
   * contradiction is evidence of NOT_APPLIED. This is the number that must be
   * measured rather than assumed — and until it is, it is deliberately
   * generous, because being slow is recoverable and being wrong is not.
   */
  convergence_window_seconds: number;
  /**
   * How long Nyst keeps re-observing before it stops and says it cannot tell.
   *
   * There is always an end. An outcome that is never resolved is worse than one
   * honestly marked INDETERMINATE, because it looks like work in progress.
   */
  reconciliation_deadline_seconds: number;
  /** The floor between two observations of the same subject. */
  minimum_observation_interval_seconds: number;
  /**
   * When this window was last measured against the live provider.
   *
   * `null` means DECLARED, NOT MEASURED. Everything here is currently null, and
   * that is the honest state until a live verification pass runs.
   */
  measured_at: string | null;
  /** Why these numbers are what they are, for whoever revisits them. */
  rationale: string;
}

/**
 * The declared semantics, per effect.
 *
 * Conservative on purpose. A convergence window that is too LONG costs latency
 * on a rare disagreement; one that is too SHORT produces a confident wrong
 * answer. Those are not symmetric, and the asymmetry decides every number here.
 */
export const OBSERVATION_SEMANTICS: readonly EffectObservationSemantics[] = Object.freeze([
  {
    effect_name: "github.repository_permission_change",
    mechanism: "resource_read",
    freshness_seconds: 900,
    // GitHub's permission endpoints are widely observed to lag a write, and
    // effective permission is DERIVED from org role, team membership and direct
    // grant — several sources that need not converge together.
    convergence_window_seconds: 60,
    reconciliation_deadline_seconds: 3600,
    minimum_observation_interval_seconds: 5,
    measured_at: null,
    rationale:
      "Effective GitHub permission is derived from org role, team membership and direct collaborator "
      + "grant. Those settle independently, so an immediate read-back can disagree with a write that "
      + "did apply. DECLARED, NOT MEASURED — the window is generous until a live pass measures it.",
  },
  {
    effect_name: "okta.user_suspension",
    mechanism: "resource_read",
    freshness_seconds: 900,
    // A user status transition is a single record on a single object, which is
    // the shape most likely to be immediately consistent.
    convergence_window_seconds: 30,
    reconciliation_deadline_seconds: 1800,
    minimum_observation_interval_seconds: 5,
    measured_at: null,
    rationale:
      "Okta user status is one field on one object, so it should converge quickly. Session revocation "
      + "downstream of it may not. DECLARED, NOT MEASURED.",
  },
  {
    effect_name: "stripe.refund",
    mechanism: "resource_read",
    freshness_seconds: 900,
    convergence_window_seconds: 30,
    reconciliation_deadline_seconds: 1800,
    minimum_observation_interval_seconds: 5,
    measured_at: null,
    rationale:
      "A refund object is readable by id immediately after creation. Its downstream STATE may take "
      + "far longer, and that is a different question from whether the refund exists. DECLARED, NOT MEASURED.",
  },
]);

export function observationSemantics(effectName: string): EffectObservationSemantics | null {
  return OBSERVATION_SEMANTICS.find((entry) => entry.effect_name === effectName) ?? null;
}

/* ===================================================================== */

export type ContradictionVerdict =
  /** Inside the convergence window. Look again; claim nothing yet. */
  | { verdict: "pending"; reason: string; observe_again_after_seconds: number }
  /** Past the window, repeatedly contradicted. This is now evidence. */
  | { verdict: "not_applied"; reason: string }
  /** Past the reconciliation deadline. Nyst stops, and says it cannot tell. */
  | { verdict: "unprovable"; reason: string };

/**
 * A provider says the change is not there. What does that MEAN?
 *
 * The whole point is that it means different things at different times, and the
 * function makes the caller supply the time rather than deciding from a
 * constant somewhere.
 */
export function interpretContradiction(input: {
  effect_name: string;
  /** Seconds since the mutation was dispatched. */
  elapsed_seconds: number;
  /** How many times the provider has now contradicted it. */
  observations: number;
}): ContradictionVerdict {
  const semantics = observationSemantics(input.effect_name);
  if (!semantics) {
    // An effect with no declared semantics gets the most conservative answer
    // available. Nyst does not guess about a provider it has not characterised.
    return {
      verdict: "unprovable",
      reason:
        `No observation semantics are declared for ${input.effect_name}, so Nyst cannot distinguish `
        + "a change that did not apply from a provider that has not caught up. It will not guess.",
    };
  }

  if (input.elapsed_seconds >= semantics.reconciliation_deadline_seconds) {
    return {
      verdict: "unprovable",
      reason:
        `${input.effect_name} has been re-observed past its reconciliation deadline of `
        + `${semantics.reconciliation_deadline_seconds}s and never converged. Nyst stops here rather than `
        + "leaving an outcome open forever, and says plainly that it cannot establish what happened.",
    };
  }

  if (input.elapsed_seconds < semantics.convergence_window_seconds) {
    return {
      verdict: "pending",
      reason:
        `${input.effect_name} may take up to ${semantics.convergence_window_seconds}s to converge, and `
        + `${Math.round(input.elapsed_seconds)}s have passed. A contradictory read this early is not `
        + "evidence that the change did not apply.",
      observe_again_after_seconds: semantics.minimum_observation_interval_seconds,
    };
  }

  // Past the window. One contradiction is now meaningful; two is better, and
  // costs one more read on a question worth getting right.
  if (input.observations < 2) {
    return {
      verdict: "pending",
      reason:
        `${input.effect_name} is past its convergence window but has only been observed `
        + `${input.observations} time(s). One read is a data point; Nyst wants a second before calling it.`,
      observe_again_after_seconds: semantics.minimum_observation_interval_seconds,
    };
  }

  return {
    verdict: "not_applied",
    reason:
      `${input.effect_name} was observed ${input.observations} times over `
      + `${Math.round(input.elapsed_seconds)}s, past its ${semantics.convergence_window_seconds}s convergence `
      + "window, and the provider consistently reports the change is not present.",
  };
}

/* ===================================================================== */

/**
 * A provider refused to answer. That is NEVER evidence about the world.
 *
 * v0.3.2 Phase 24. A 429, a 500, a timeout or a network failure tells you
 * something about the PROVIDER and nothing whatsoever about whether the effect
 * happened. Turning one into `not_applied` would let a rate limit produce a
 * confident false statement about a customer's access — and the same read
 * retried a minute later would say the opposite.
 *
 * So there is exactly one answer: Nyst does not know yet, and will ask again.
 */
export function interpretProviderRefusal(input: {
  effect_name: string;
  status: number | null;
  retry_after_seconds: number | null;
}): { verdict: "pending"; reason: string; observe_again_after_seconds: number } {
  const semantics = observationSemantics(input.effect_name);
  const floor = semantics?.minimum_observation_interval_seconds ?? 5;

  // Honour the provider's own instruction when it gives one. Retrying sooner
  // than asked is how a rate limit becomes an outage.
  const wait = input.retry_after_seconds !== null && Number.isFinite(input.retry_after_seconds)
    ? Math.max(floor, Math.min(input.retry_after_seconds, 3600))
    : floor;

  const description = input.status === 429
    ? "rate limited"
    : input.status === null ? "unreachable" : `answering ${input.status}`;

  return {
    verdict: "pending",
    reason:
      `The provider is ${description}, which says something about the provider and NOTHING about whether `
      + `${input.effect_name} took effect. Nyst will observe again rather than infer an outcome from a `
      + "refusal to answer.",
    observe_again_after_seconds: wait,
  };
}
