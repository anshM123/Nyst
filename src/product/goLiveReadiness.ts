/**
 * GO-LIVE READINESS (Phase 13) and the formal product labels.
 *
 * Readiness is computed for one exact triple:
 *
 *     Agent + Environment + EffectSpec
 *
 * Every label below has ONE formal definition, and the product may only use a
 * label when its definition is currently satisfied. In particular
 * "Protected by Nyst" requires the workload to ACTUALLY route through Enforced
 * (or an Enforced Canary scope) with every runtime condition true right now —
 * not that a config field exists, not that an EffectSpec is enabled.
 */
import type { EnvironmentMode } from "./controlPlane.js";
import type { IntegrationReadiness } from "./readiness.js";

/**
 * The complete set of workload labels. There are no others, and none of them
 * is decorative.
 */
export const WORKLOAD_LABELS = ["Not configured", "Shadow", "Canary", "Enforced", "Blocked", "Frozen", "Protected"] as const;
export type WorkloadLabel = (typeof WORKLOAD_LABELS)[number];

export const WORKLOAD_LABEL_DEFINITIONS: Readonly<Record<WorkloadLabel, string>> = Object.freeze({
  "Not configured":
    "This Agent and EffectSpec are not set up in this environment. Nyst is doing nothing for this workload.",
  Shadow:
    "Nyst is evaluating this workload with the real EffectSpec semantics but is NOT controlling it. Nothing is prevented.",
  Canary:
    "This exact Agent and EffectSpec are inside a deterministic enforcement scope. Nyst controls these actions; other workloads in this environment are not controlled.",
  Enforced:
    "The environment is Enforced, so every consequential action for this workload routes through Nyst safety control.",
  Blocked:
    "The workload is configured for enforcement but cannot currently execute safely: a required readiness condition is false.",
  Frozen:
    "An Emergency Freeze covering this scope is active. No new consequential provider mutation may begin. Read-only reconciliation continues.",
  Protected:
    "The workload is actually routing through Nyst control (Enforced, or an Enforced Canary scope) AND every required runtime condition is currently satisfied.",
});

/** One readiness condition, with a truthful reason when it is not met. */
export interface ReadinessCheck {
  id:
    | "agent_configured" | "effect_spec_enabled" | "integration_configured" | "credential_resolvable"
    | "preflight_recent" | "capabilities_sufficient" | "policy_bound" | "not_frozen" | "rollout_mode_configured"
    | "observation_semantics" | "recovery_behavior_known" | "webhook_configured";
  label: string;
  satisfied: boolean;
  /** Blocking checks make the workload Blocked; advisory ones only inform. */
  blocking: boolean;
  detail: string;
}

export interface GoLiveReadiness {
  agent_id: string | null;
  agent_name: string | null;
  effect_name: string;
  spec_version: string | null;
  environment_mode: EnvironmentMode;
  execution_mode: EnvironmentMode;
  label: WorkloadLabel;
  label_definition: string;
  protected_by_nyst: boolean;
  checks: readonly ReadinessCheck[];
  blocking_failures: readonly string[];
  next_step: string;
}

export interface GoLiveInput {
  agent_id: string | null;
  agent_name: string | null;
  agent_status: "active" | "paused" | "retired" | null;
  effect_name: string;
  spec_version: string | null;
  spec_enabled: boolean;
  environment_mode: EnvironmentMode;
  execution_mode: EnvironmentMode;
  integration: IntegrationReadiness | null;
  /** True when the effect needs no external provider credential (the dev fake). */
  credential_free_effect: boolean;
  policy_bound: boolean;
  /** Which immutable policy version would actually bind. Null when none would. */
  policy_description?: string | null;
  frozen: boolean;
  /** What the covering freeze is scoped to, for a truthful label. Null when none. */
  freeze_scope_description?: string | null;
  observation_semantics_available: boolean;
  recovery_behavior_known: boolean;
  webhook_required: boolean;
  webhook_configured: boolean;
}

export function evaluateGoLiveReadiness(input: GoLiveInput): GoLiveReadiness {
  const integration = input.integration;
  const checks: ReadinessCheck[] = [
    { id: "agent_configured", label: "Agent identity configured", blocking: true,
      satisfied: input.agent_id !== null && input.agent_status === "active",
      detail: input.agent_id === null ? "No Agent is bound to this workload, so Nyst cannot answer who caused an action."
        : input.agent_status === "active" ? `Bound to ${input.agent_name ?? input.agent_id}.`
        : `The Agent is ${input.agent_status}, so it may not take new consequential actions.` },
    { id: "effect_spec_enabled", label: "Exact EffectSpec version enabled", blocking: true,
      satisfied: input.spec_enabled && input.spec_version !== null,
      detail: input.spec_enabled ? `Version ${input.spec_version} is enabled in this environment.` : "No version of this EffectSpec is enabled here." },
    { id: "integration_configured", label: "Integration configured", blocking: !input.credential_free_effect,
      satisfied: input.credential_free_effect || integration?.configured === true,
      detail: input.credential_free_effect ? "This development effect needs no external provider credential."
        : integration?.configured ? "A credential reference is stored." : "No credential reference is configured for this provider." },
    { id: "credential_resolvable", label: "Credential currently resolvable", blocking: !input.credential_free_effect,
      satisfied: input.credential_free_effect || integration?.credential_available === true,
      detail: input.credential_free_effect ? "Not applicable."
        : integration?.credential_available ? "The reference resolved through the SecretProvider." : (integration?.reason ?? "The credential reference did not resolve.") },
    { id: "preflight_recent", label: "Read-only preflight successful and recent", blocking: !input.credential_free_effect,
      satisfied: input.credential_free_effect || integration?.preflight_verified === true,
      detail: input.credential_free_effect ? "Not applicable."
        : integration?.preflight_verified ? `Last verified ${integration.last_preflight_at}.`
        : integration?.preflight_stale ? "The last successful preflight is outside the 12-hour trust window."
        : "No successful read-only preflight has been recorded." },
    { id: "capabilities_sufficient", label: "Required capabilities granted", blocking: !input.credential_free_effect,
      satisfied: input.credential_free_effect || integration?.capabilities_sufficient === true,
      detail: input.credential_free_effect ? "Not applicable."
        : integration?.capabilities_sufficient ? "Every capability this workload requires was observed as granted."
        : (integration?.missing_capabilities ?? []).length ? `The provider did not grant: ${(integration?.missing_capabilities ?? []).join(", ")}.`
        : "Capability sufficiency has not been observed, so Nyst will not assume it." },
    // Phase 1F: resolved through the production policy resolver, so this names
    // the exact immutable version this workload would bind. It previously only
    // asked whether any policy row existed in the environment.
    { id: "policy_bound", label: "Effective policy resolves", blocking: true, satisfied: input.policy_bound,
      detail: input.policy_bound
        ? (input.policy_description ?? "An immutable policy version binds this workload.")
        : "No policy version would bind this EffectSpec: neither an EffectSpec-specific policy nor an environment fallback exists." },
    // Phase 1E: this asks whether a freeze COVERS THIS WORKLOAD, using the
    // identical predicate admission uses. It previously asked whether any
    // freeze existed in the environment, so one narrowly scoped freeze marked
    // every unrelated workload Frozen.
    { id: "not_frozen", label: "Not covered by a freeze", blocking: true, satisfied: !input.frozen,
      detail: input.frozen
        ? `An Emergency Freeze scoped to ${input.freeze_scope_description ?? "this scope"} covers this workload.`
        : "No active freeze covers this Agent and EffectSpec." },
    { id: "rollout_mode_configured", label: "Rollout mode configured", blocking: false, satisfied: true,
      detail: `The environment is ${input.environment_mode}; this workload executes as ${input.execution_mode}.` },
    { id: "observation_semantics", label: "Observation semantics available", blocking: true, satisfied: input.observation_semantics_available,
      detail: input.observation_semantics_available ? "Nyst can independently observe this effect's external state."
        : "Nyst has no authoritative observation method for this effect, so it could not resolve ambiguity." },
    { id: "recovery_behavior_known", label: "Recovery behaviour known", blocking: false, satisfied: input.recovery_behavior_known,
      detail: input.recovery_behavior_known ? "Compensation support for this effect is documented in the Effect Registry."
        : "Recovery behaviour for this effect is undocumented; escalation is the only safe path." },
    { id: "webhook_configured", label: "Webhook configured", blocking: input.webhook_required, satisfied: !input.webhook_required || input.webhook_configured,
      detail: !input.webhook_required ? "This workflow does not require outbound decision webhooks."
        : input.webhook_configured ? "A signed decision webhook endpoint is enabled." : "This workflow needs a webhook endpoint and none is enabled." },
  ];

  const blocking = checks.filter((check) => check.blocking && !check.satisfied);
  const label = deriveLabel(input, blocking.length === 0);

  return {
    agent_id: input.agent_id, agent_name: input.agent_name,
    effect_name: input.effect_name, spec_version: input.spec_version,
    environment_mode: input.environment_mode, execution_mode: input.execution_mode,
    label, label_definition: WORKLOAD_LABEL_DEFINITIONS[label],
    // The single most over-claimable statement in the product. It is true only
    // when Nyst is actually controlling the workload AND nothing is blocking.
    protected_by_nyst: label === "Protected",
    checks,
    blocking_failures: blocking.map((check) => `${check.label}: ${check.detail}`),
    next_step: nextStep(label, blocking),
  };
}

function deriveLabel(input: GoLiveInput, allBlockingSatisfied: boolean): WorkloadLabel {
  if (input.frozen) return "Frozen";
  if (input.agent_id === null && !input.spec_enabled) return "Not configured";
  if (input.execution_mode === "shadow") return "Shadow";
  if (!allBlockingSatisfied) return "Blocked";
  // Controlling AND healthy. Only here may the product say "Protected".
  return "Protected";
}

function nextStep(label: WorkloadLabel, blocking: readonly ReadinessCheck[]): string {
  switch (label) {
    case "Not configured": return "Create an Agent and enable the exact EffectSpec version for this environment.";
    case "Shadow": return "Review the Shadow findings, then promote this Agent and EffectSpec to a Canary scope.";
    case "Blocked": return `Resolve: ${blocking.map((check) => check.label).join("; ")}.`;
    case "Frozen": return "Investigate the incident, then release the Emergency Freeze with explicit confirmation.";
    case "Canary": return "Watch the Canary scope, then move the environment to Enforced when the evidence supports it.";
    case "Enforced": return "Nothing outstanding.";
    case "Protected": return "Nothing outstanding. Expand protection to the next workload.";
  }
}
