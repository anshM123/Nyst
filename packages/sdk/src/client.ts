/**
 * NystClient — the typed HTTP client for the Nyst API.
 *
 * Deliberately thin. Every safety decision is made by the Nyst control plane
 * and returned to you; this client does not derive, infer, cache or soften
 * any of it. If you find yourself wanting a helper here that decides whether
 * something is safe, that helper belongs on the server.
 */
import type {
  ActionSummary, ControlDecision, ExecuteActionInput, FactValue, OutcomeEvaluation, OutcomeInstance,
  OutcomeVerdict, Resolution, ShadowEvaluationInput,
} from "./types.js";

export interface NystClientOptions {
  /** e.g. "https://nyst.internal.example.com". HTTP(S) only. */
  baseUrl: string;
  /** An API key issued from Settings. Never a session cookie. */
  apiKey: string;
  /** Override for tests or for a proxied fetch. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number;
}

export interface ExecuteActionResult {
  action_id: string;
  resolution: Resolution;
}

export class NystApiError extends Error {
  constructor(readonly status: number, readonly response: unknown, readonly requestId?: string) {
    super(`Nyst API returned HTTP ${status}`);
    this.name = "NystApiError";
  }
}

export class NystClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(options: NystClientOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) throw new Error("Nyst SDK requires an HTTP(S) base URL");
    if (!options.apiKey) throw new Error("Nyst SDK requires an API key");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Execute a consequential action under Nyst control.
   *
   * Returns once Nyst has an EffectState and a ControlDecision. For an
   * ambiguous execution that is `pending` with `hold`: that is the correct
   * answer, not a failure, and it is exactly the case your code must handle.
   */
  execute(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    return this.#request<ExecuteActionResult>("POST", "/v1/actions", input);
  }

  /** Ask Nyst to re-observe an unresolved action now rather than on its schedule. */
  reconcile(actionId: string): Promise<{ resolution: Resolution }> {
    return this.#request("POST", `/v1/actions/${assertActionId(actionId)}/reconcile`, {});
  }

  listActions(filters: Readonly<Record<string, string>> = {}): Promise<readonly ActionSummary[]> {
    const query = new URLSearchParams(filters).toString();
    return this.#request("GET", query ? `/v1/actions?${query}` : "/v1/actions");
  }

  getAction(id: string): Promise<Record<string, unknown>> {
    return this.#request("GET", `/v1/actions/${assertActionId(id)}`);
  }

  /** The observations Nyst actually used, in the order it recorded them. */
  evidence(id: string): Promise<readonly Record<string, unknown>[]> {
    return this.#request("GET", `/v1/actions/${assertActionId(id)}/evidence`);
  }

  resolutions(id: string): Promise<readonly Resolution[]> {
    return this.#request("GET", `/v1/actions/${assertActionId(id)}/resolutions`);
  }

  /** The signed receipt, plus whether its signature verifies. */
  receipt(id: string): Promise<{ receipt: Resolution; signature_valid: boolean | null }> {
    return this.#request("GET", `/v1/actions/${assertActionId(id)}/receipt`);
  }

  /**
   * Shadow evaluation: tell Nyst what your software observed and what it was
   * about to do. Nyst applies the real EffectSpec semantics and reports what
   * Enforced Mode WOULD have decided. It does not control anything.
   */
  evaluateShadow(input: ShadowEvaluationInput): Promise<Record<string, unknown>> {
    return this.#request("POST", "/v1/shadow/evaluations", input);
  }

  overview(): Promise<Record<string, unknown>> {
    return this.#request("GET", "/v1/overview");
  }

  /* ==================================================== THE OUTCOME LAYER */

  /**
   * Open a real-world outcome.
   *
   * `subjectKey` is YOUR stable identity for it. Calling this twice with the
   * same key returns the same outcome rather than starting a second
   * offboarding for the same person — the outcome-layer equivalent of Nyst's
   * atomic action identity guarantee.
   */
  openOutcome(input: {
    outcome_contract_id: string;
    subject: Readonly<Record<string, unknown>>;
    subject_key: string;
    agent_id?: string;
  }): Promise<{ instance: OutcomeInstance; created: boolean }> {
    return this.#request("POST", "/v1/outcomes", input);
  }

  /**
   * Evaluate an outcome now.
   *
   * Returns one of exactly three verdicts. INDETERMINATE is not an error: it
   * is Nyst saying it could not see, and your code should treat it as
   * "do not proceed" rather than retrying until it changes.
   */
  evaluateOutcome(outcomeInstanceId: string): Promise<{ instance: OutcomeInstance; evaluation: OutcomeEvaluation }> {
    return this.#request("POST", `/v1/outcomes/${assertUuid(outcomeInstanceId)}/evaluate`, {});
  }

  getOutcome(outcomeInstanceId: string): Promise<OutcomeInstance> {
    return this.#request("GET", `/v1/outcomes/${assertUuid(outcomeInstanceId)}`);
  }

  listOutcomes(): Promise<readonly OutcomeInstance[]> {
    return this.#request("GET", "/v1/outcomes");
  }

  /** Every evaluation this outcome has had, newest first. */
  outcomeEvaluations(outcomeInstanceId: string): Promise<readonly Record<string, unknown>[]> {
    return this.#request("GET", `/v1/outcomes/${assertUuid(outcomeInstanceId)}/evaluations`);
  }

  /** The signed Outcome Receipt, if one has been issued. */
  outcomeReceipt(outcomeInstanceId: string): Promise<Record<string, unknown>> {
    return this.#request("GET", `/v1/outcomes/${assertUuid(outcomeInstanceId)}/receipt`);
  }

  /* ================================================== THE EVIDENCE LAYER */

  /**
   * Push an observation from one of your own systems.
   *
   * You push EVIDENCE. Nyst evaluates TRUTH. There is deliberately no way to
   * push a verdict through this method — a source that could assert an outcome
   * was satisfied could make Nyst lie on your behalf, and the receipt would be
   * worth nothing.
   *
   * `eventId` is your identity for the observation event. Retrying after a
   * network failure returns the original record rather than double-counting.
   */
  pushEvidence(input: {
    source_key: string;
    event_id: string;
    subject_ref: string;
    property: string;
    value: FactValue;
    observed_at: string;
    fresh_until?: string;
    provenance?: Readonly<Record<string, unknown>>;
    signature?: string;
  }): Promise<{ ingested_evidence_id: string; world_fact_id: string | null; replayed: boolean }> {
    return this.#request("POST", "/v1/evidence", input);
  }

  listEvidence(): Promise<readonly Record<string, unknown>[]> {
    return this.#request("GET", "/v1/evidence");
  }

  /* ============================================== THE SHADOW SURFACE */

  /**
   * Tell Nyst your Agent considers a workflow finished.
   *
   * Recorded as your Agent's CLAIM. It never moves a verdict: the entire value
   * of this call is the distance between what your Agent believes and what
   * Nyst independently observed.
   */
  declareComplete(input: {
    outcome_instance_id: string;
    declared_status: "complete" | "failed" | "abandoned";
    agent_id?: string;
  }): Promise<{ verdict: OutcomeVerdict; finding: Record<string, unknown> | null }> {
    return this.#request("POST", "/v1/shadow/completion-signals", input);
  }

  shadowMetrics(): Promise<Record<string, unknown>> {
    return this.#request("GET", "/v1/shadow/metrics");
  }

  /* ==================================================== AUTHORITY */

  /** Every Autonomy Line rule in this environment. */
  autonomyRules(): Promise<readonly Record<string, unknown>[]> {
    return this.#request("GET", "/v1/autonomy-rules");
  }

  /**
   * Issue a ContinuationGrant for one dependent consequence.
   *
   * Narrow, signed, single-use and expiring within the hour. It dies the
   * moment the outcome is re-evaluated, because it rests on the evidence that
   * existed when it was issued.
   */
  issueContinuationGrant(input: {
    outcome_instance_id: string;
    permitted_effects: readonly string[];
    resource_scope: readonly string[];
    expires_in_seconds?: number;
    exception_id?: string;
    agent_id?: string;
  }): Promise<Record<string, unknown>> {
    return this.#request("POST", "/v1/continuation-grants", input);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Nyst ${this.#apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect would send the Authorization header somewhere unintended.
        redirect: "error",
        signal: controller.signal,
      });
      const value = await response.json().catch(() => ({})) as unknown;
      if (!response.ok) {
        const requestId = typeof value === "object" && value && "request_id" in value
          ? String((value as { request_id: unknown }).request_id) : undefined;
        throw new NystApiError(response.status, value, requestId);
      }
      return value as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export type { ControlDecision };

function assertUuid(value: string): string {
  return assertActionId(value);
}

function assertActionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid action ID");
  }
  return encodeURIComponent(value);
}
