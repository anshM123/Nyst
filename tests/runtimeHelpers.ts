import { FixedClock } from "../src/core/clock.js";
import { Ed25519Signer } from "../src/core/signing.js";
import { createFakeSpec } from "../src/fake/fakeSpec.js";
import { RuntimeFakeProvider } from "../src/fake/runtimeFakeProvider.js";
import { NystRuntime, type NystRuntimeOptions } from "../src/runtime/nystRuntime.js";
import { EffectRegistry } from "../src/runtime/registry.js";
import { createMemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";

export function makeRuntimeHarness(options: NystRuntimeOptions = {}, store?: Store) {
  const actualStore = store ?? createMemoryStore();
  const clock = new FixedClock();
  const signer = Ed25519Signer.ephemeral("runtime-test-key");
  const spec = createFakeSpec();
  const registry = new EffectRegistry();
  registry.register(spec);
  const provider = new RuntimeFakeProvider(clock);
  const runtime = new NystRuntime(actualStore, registry, [provider], signer, clock, options);
  return { store: actualStore, clock, signer, spec, registry, provider, runtime };
}

export const runtimeInput = (
  scenario: string,
  over: Record<string, unknown> = {}
) => ({
  repository_id: "repo_prod",
  principal_id: "alice",
  desired_permission: "none",
  scenario,
  ...over,
});
