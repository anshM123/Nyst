import { FixedClock } from "../core/clock.js";
import { Ed25519Signer } from "../core/signing.js";
import { verifyResolution } from "../engine/resolver.js";
import { createFakeSpec } from "../fake/fakeSpec.js";
import { RuntimeFakeProvider, type RuntimeFakeScenario } from "../fake/runtimeFakeProvider.js";
import { EMPTY_CONTEXT } from "../model/metadata.js";
import { NystRuntime } from "../runtime/nystRuntime.js";
import { ProcessCrashError } from "../runtime/provider.js";
import { EffectRegistry } from "../runtime/registry.js";
import { createMemoryStore } from "../store/memoryStore.js";
import type { FailureScenario } from "./controlPlane.js";

const LAB_EFFECT = "fake.repository_permission_change";

const scenarioMap: Record<Exclude<FailureScenario, "process_crash" | "offboarding_demo">, RuntimeFakeScenario> = {
  response_lost: "response_lost_after_effect",
  timeout_before_send: "definitely_not_sent",
  delayed_observation: "eventual_consistency",
  reconcile_rate_limit: "provider_read_unavailable",
  duplicate_caller: "definitely_applied",
};

export interface FailureLabResult {
  scenario: FailureScenario;
  effect_name: typeof LAB_EFFECT;
  seed: number;
  simulated: true;
  provider_credentials_used: false;
  action_id: string;
  created_actions: number;
  provider_mutations: number;
  final_effect_state: string;
  control: { primary: string; retry: string; continuation: string; recovery: string };
  resolution_id: string;
  signature_valid: boolean;
  evidence: Array<Record<string, unknown>>;
  timeline: Array<{ stage: string; detail: string }>;
  naive_behavior: string;
  nyst_behavior: string;
  duplicate_consequence_avoided_in_simulation: boolean;
}

/** Runs only the credential-free fake EffectSpec through the production runtime state machine. */
export async function runFailureLabEngine(scenario: FailureScenario, effectName: string, seed: number): Promise<FailureLabResult> {
  if (effectName !== LAB_EFFECT) throw new Error(`Failure Lab supports only ${LAB_EFFECT}; production EffectSpecs and credentials are unavailable`);
  if (!Number.isSafeInteger(seed)) throw new Error("Failure Lab seed must be a safe integer");

  const store = createMemoryStore();
  const clock = new FixedClock("2026-01-01T00:00:00.000Z");
  const signer = Ed25519Signer.ephemeral(`failure-lab-${seed}`);
  const spec = createFakeSpec();
  const registry = new EffectRegistry();
  registry.register(spec);
  const provider = new RuntimeFakeProvider(clock);
  let crashed = false;
  const runtime = new NystRuntime(store, registry, [provider], signer, clock, scenario === "process_crash" ? {
    fault_injector(point) {
      if (!crashed && point === "after_provider_mutation") {
        crashed = true;
        throw new ProcessCrashError(point);
      }
    },
  } : {});
  const providerScenario: RuntimeFakeScenario = scenario === "process_crash"
    ? "response_lost_after_effect"
    : scenario === "offboarding_demo"
      ? "response_lost_after_effect"
      : scenarioMap[scenario];
  const businessKey = `failure-lab:${scenario}:${seed}`;
  const input = { repository_id: `simulated-repository-${seed}`, principal_id: "simulated-principal", desired_permission: "none", scenario: providerScenario };

  let actionId = "";
  let createdActions = 0;
  let resolution;
  try {
    const first = await runtime.commit(LAB_EFFECT, businessKey, input, EMPTY_CONTEXT);
    actionId = first.action.action_id;
    createdActions += first.created ? 1 : 0;
    resolution = first.resolution;
    if (scenario === "duplicate_caller") {
      const duplicate = await runtime.commit(LAB_EFFECT, businessKey, input, EMPTY_CONTEXT);
      createdActions += duplicate.created ? 1 : 0;
      resolution = duplicate.resolution;
    }
  } catch (error) {
    if (!(error instanceof ProcessCrashError)) throw error;
    const action = await store.actions.findByIdentity(LAB_EFFECT, businessKey);
    if (!action) throw new Error("Failure Lab crash occurred before durable intent");
    actionId = action.action_id;
    createdActions = 1;
    const restarted = new NystRuntime(store, registry, [provider], signer, clock);
    resolution = await restarted.recover(actionId);
  }

  if (scenario === "delayed_observation") {
    resolution = await runtime.reconcile(actionId);
    resolution = await runtime.reconcile(actionId);
  }
  const evidence = await store.evidence.listForAction(actionId);
  const timeline = [
    { stage: "intent", detail: "Logical intent persisted" },
    { stage: "dispatch", detail: "Provider operation identity persisted and dispatch acquired" },
    ...evidence.map((item) => ({ stage: String(item.kind), detail: String((item.payload as Record<string, unknown>).detail ?? item.observed_disposition) })),
    { stage: "resolution", detail: `EffectState ${resolution.effect.state}; ${resolution.control.primary}` },
    { stage: "receipt", detail: "Signed resolution generated and verified" },
  ];
  const comparison = comparisonFor(scenario);
  return {
    scenario,
    effect_name: LAB_EFFECT,
    seed,
    simulated: true,
    provider_credentials_used: false,
    action_id: actionId,
    created_actions: createdActions,
    provider_mutations: provider.mutationCount(),
    final_effect_state: resolution.effect.state,
    control: {
      primary: resolution.control.primary,
      retry: resolution.control.retry,
      continuation: resolution.control.continuation,
      recovery: resolution.control.recovery,
    },
    resolution_id: resolution.resolution_id,
    signature_valid: verifyResolution(signer, resolution),
    evidence: evidence.map((item) => ({ seq: item.seq, kind: item.kind, strength: item.strength, observed_disposition: item.observed_disposition, attribution: item.attribution })),
    timeline,
    naive_behavior: comparison.naive,
    nyst_behavior: comparison.nyst,
    duplicate_consequence_avoided_in_simulation: provider.mutationCount() <= 1 && (scenario === "response_lost" || scenario === "duplicate_caller" || scenario === "process_crash" || scenario === "offboarding_demo"),
  };
}

function comparisonFor(scenario: FailureScenario): { naive: string; nyst: string } {
  switch (scenario) {
    case "response_lost": return { naive: "Retry after the missing response", nyst: "Forbid retry, observe external state, then derive control" };
    case "timeout_before_send": return { naive: "Treat transport failure as effect failure", nyst: "Record the proven not-sent boundary and derive from evidence" };
    case "delayed_observation": return { naive: "Retry before consistency settles", nyst: "Hold through bounded re-observation" };
    case "reconcile_rate_limit": return { naive: "Poll or redispatch aggressively", nyst: "Remain pending with retry forbidden" };
    case "duplicate_caller": return { naive: "Dispatch both calls", nyst: "Converge both calls on one durable logical action" };
    case "process_crash": return { naive: "Redispatch after restart", nyst: "Recover the persisted ambiguous operation through observation" };
    case "offboarding_demo": return { naive: "Continue downstream after an ambiguous first step", nyst: "Block downstream continuation until the prerequisite effect is resolved" };
  }
}
