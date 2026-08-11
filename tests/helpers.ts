import { FixedClock } from "../src/core/clock.js";
import { Ed25519Signer } from "../src/core/signing.js";
import { createEngine, type Engine } from "../src/engine/resolver.js";
import { EMPTY_CONTEXT, type ActionContext } from "../src/model/metadata.js";
import { createMemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";
import {
  createFakeSpec,
  observeFakeProvider,
  type FakeScenario,
} from "../src/fake/fakeSpec.js";
import type { EffectSpec } from "../src/spec/effectSpec.js";
import type { OutcomeResolution } from "../src/model/resolution.js";
import type { ActionRecord } from "../src/model/action.js";

export interface Harness {
  store: Store;
  signer: Ed25519Signer;
  clock: FixedClock;
  engine: Engine;
  spec: EffectSpec;
}

export function makeHarness(spec: EffectSpec = createFakeSpec()): Harness {
  const store = createMemoryStore();
  const signer = Ed25519Signer.ephemeral("test-key");
  const clock = new FixedClock();
  const engine = createEngine(store, signer, clock);
  return { store, signer, clock, engine, spec };
}

let n = 0;
export function uniqueKey(prefix = "bk"): string {
  return `${prefix}:${++n}`;
}

export const sampleInput = (over: Record<string, unknown> = {}) => ({
  repository_id: "repo_prod",
  principal_id: "alice",
  desired_permission: "none",
  ...over,
});

export async function runScenario(
  h: Harness,
  scenario: FakeScenario,
  opts: { business_key?: string; input?: Record<string, unknown>; context?: ActionContext } = {}
): Promise<{ action: ActionRecord; resolution: OutcomeResolution }> {
  const { engine, store, clock, spec } = h;
  const { action } = await engine.beginAction(
    spec,
    opts.business_key ?? uniqueKey(scenario),
    opts.input ?? sampleInput(),
    opts.context ?? EMPTY_CONTEXT
  );
  const dispatched = await engine.markDispatched(spec, action);
  await observeFakeProvider(store.evidence, clock, dispatched, scenario);
  const resolution = await engine.resolve(spec, action.action_id);
  return { action: dispatched, resolution };
}
