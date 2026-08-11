import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { ControlDecision } from "../model/controlDecision.js";

export type EnvironmentMode = "shadow" | "enforced";
export type FailureScenario = "response_lost" | "timeout_before_send" | "delayed_observation" | "reconcile_rate_limit" | "duplicate_caller" | "process_crash" | "offboarding_demo";

export interface ConservativePolicy {
  policy_version_id: string;
  execution_mode: "automatic" | "approval_required";
  retry_mode: "never";
  auto_continuation: boolean;
  auto_compensation: boolean;
  reconcile_timeout_seconds: number;
}

export interface ShadowObservation {
  transport: "success" | "definitely_not_sent" | "ambiguous";
  authoritative_goal_observed: boolean | null;
  attempted_retry: boolean;
  attempted_continuation: boolean;
  /** EffectSpec-shaped provider facts. These are observations, never Nyst-controlled consequences. */
  provider_state?: Record<string, unknown>;
}

export interface ShadowAssessment {
  classification: "observed_fact_and_counterfactual";
  observed_ambiguous: boolean;
  retry_would_have_been_blocked: boolean;
  continuation_would_have_been_blocked: boolean;
  language: "detected";
  note: string;
}

/** Shadow never claims Nyst controlled or prevented an external consequence. */
export function assessShadow(observation: ShadowObservation): ShadowAssessment {
  const ambiguous = observation.transport === "ambiguous" || observation.authoritative_goal_observed === null;
  return {
    classification: "observed_fact_and_counterfactual",
    observed_ambiguous: ambiguous,
    retry_would_have_been_blocked: observation.attempted_retry && ambiguous,
    continuation_would_have_been_blocked: observation.attempted_continuation && observation.authoritative_goal_observed !== true,
    language: "detected",
    note: "Shadow Mode observed caller-supplied execution facts and reports what Enforced Mode would have blocked; it did not prevent the action.",
  };
}

/** A customer policy may only reduce an already-derived runtime decision. */
export function constrainDecision(decision: ControlDecision, policy: ConservativePolicy): ControlDecision {
  const retry = "forbidden" as const;
  const continuation = policy.auto_continuation ? decision.continuation : "blocked" as const;
  const recovery = policy.auto_compensation ? decision.recovery : (decision.recovery === "compensate" ? "escalate" : decision.recovery);
  const primary = decision.primary === "retry" ? "escalate"
    : decision.primary === "continue" && continuation !== "allowed" ? "hold"
    : decision.primary === "compensate" && recovery !== "compensate" ? "escalate"
    : decision.primary;
  return { ...decision, primary, retry, continuation, recovery };
}

export function deterministicExplanation(action: Record<string, unknown>, evidence: Record<string, unknown>[], resolution: Record<string, unknown> | null): Record<string, unknown> {
  const effect = String(resolution?.effect_state ?? "unresolved");
  const decision = String(resolution?.primary_directive ?? "investigate");
  const facts = evidence.map((item) => ({
    sequence: Number(item.seq ?? 0),
    source: String(item.source ?? "unknown"),
    fact: String(item.observed_disposition ?? item.kind ?? "observation"),
    attribution: String(item.attribution ?? "unknown"),
    strength: String(item.strength ?? "unknown"),
  }));
  return {
    generated_from: "durable_structured_evidence",
    effect_name: String(action.effect_name ?? "unknown"),
    effect_state: effect,
    decision,
    facts,
    therefore: {
      retry: String(resolution?.retry_disposition ?? "not_allowed"),
      continuation: String(resolution?.continuation_disposition ?? "blocked"),
      recovery: decision === "compensate" ? "supported compensation may be authorized" : decision === "continue" ? "continuation may be authorized" : "none automatically authorized",
    },
  };
}

export function validateWebhookTarget(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid webhook URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new Error("Webhook URL must be credential-free HTTPS");
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa") || privateAddress(host)) throw new Error("Webhook target must be a public HTTPS host");
  return url;
}

export function privateAddress(host: string): boolean {
  if (!isIP(host)) return false;
  if (host.includes(":")) {
    const normalized = host.toLowerCase();
    if(normalized.startsWith("::ffff:")){const mapped=normalized.slice(7);return privateAddress(mapped)}
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("2001:db8");
  }
  const [a = 0, b = 0] = host.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 100 && b >= 64 && b <= 127) || (a===198&&(b===18||b===19||b===51)) || (a===203&&b===0);
}

export function assessEffectShadow(effectName: string, observation: ShadowObservation): ShadowAssessment & { semantics: Record<string, unknown> } {
  const state = observation.provider_state ?? {};
  const base = assessShadow(observation);
  if (effectName === "fake.repository_permission_change") {
    rejectUnknown(state, ["current_permission", "desired_permission", "attributed"]);
    return { ...base, semantics: { observed: state, inferred: "fake permission equality and attribution", counterfactual: base } };
  }
  if (effectName === "github.repository_permission_change") {
    rejectUnknown(state, ["effective_role", "desired_role", "direct_role", "inherited_access"]);
    const effective = requiredString(state, "effective_role");
    const desired = requiredString(state, "desired_role");
    const inherited = requiredBoolean(state, "inherited_access");
    if (!["none","read","triage","write","maintain","admin"].includes(effective) || !["none","read","triage","write","maintain","admin"].includes(desired)) throw new Error("Unsupported GitHub role in Shadow observation");
    const goal = effective === desired && !inherited;
    return { ...base, continuation_would_have_been_blocked: observation.attempted_continuation && !goal, semantics: { observed: state, inferred: inherited ? "inherited access prevents direct-role attribution" : "effective and desired direct roles compared", counterfactual: { continuation: goal ? "allowed" : "blocked" } } };
  }
  if (effectName === "okta.user_suspension_change") {
    rejectUnknown(state, ["current_status", "desired_status"]);
    const current = requiredString(state, "current_status");
    const desired = requiredString(state, "desired_status");
    if (!["ACTIVE","SUSPENDED"].includes(current) || !["ACTIVE","SUSPENDED"].includes(desired)) throw new Error("Unsupported Okta lifecycle state in Shadow observation");
    const goal = current === desired;
    return { ...base, continuation_would_have_been_blocked: observation.attempted_continuation && !goal, semantics: { observed: state, inferred: "Okta lifecycle state compared with intended lifecycle state", counterfactual: { continuation: goal ? "allowed" : "blocked" } } };
  }
  if (effectName === "stripe.refund" || effectName === "stripe.payment_capture") {
    rejectUnknown(state, ["object_matches_intent", "attributed", "provider_status"]);
    const matches = requiredBoolean(state, "object_matches_intent");
    const attributed = requiredBoolean(state, "attributed");
    return { ...base, continuation_would_have_been_blocked: observation.attempted_continuation && !(matches && attributed), semantics: { observed: state, inferred: matches ? (attributed ? "object matches intent and action attribution" : "matching object lacks action attribution") : "provider object does not match intended parameters", counterfactual: { continuation: matches && attributed ? "allowed" : "blocked" } } };
  }
  throw new Error("Shadow evaluation requires a registered EffectSpec-specific observation schema");
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown Shadow provider_state field: ${unknown[0]}`);
}
function requiredString(value: Record<string, unknown>, key: string): string { const item=value[key];if(typeof item!=="string"||!item)throw new Error(`Shadow provider_state.${key} is required`);return item; }
function requiredBoolean(value: Record<string, unknown>, key: string): boolean { const item=value[key];if(typeof item!=="boolean")throw new Error(`Shadow provider_state.${key} is required`);return item; }

export function signWebhook(secret: string, timestamp: string, body: string,eventId?:string): string {
  return `v1=${createHmac("sha256", secret).update(eventId?`${timestamp}.${eventId}.${body}`:`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyWebhook(secret: string, timestamp: string, body: string, signature: string, now = Date.now(),eventId?:string): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || Math.abs(now - parsed) > 5 * 60_000) return false;
  const expected = signWebhook(secret, timestamp, body,eventId);
  const left = Buffer.from(signature); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
