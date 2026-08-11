import { Ed25519Signer, type Signer } from "../src/core/signing.js";
import { OffboardingCoordinator } from "../src/offboarding/offboardingCoordinator.js";
import type { OffboardingRunIntent } from "../src/offboarding/offboardingRun.js";
import { GitHubRestClient } from "../src/providers/github/githubClient.js";
import { GitHubRepositoryPermissionProvider } from "../src/providers/github/githubProvider.js";
import { GitHubRepositoryPermissionService } from "../src/providers/github/githubService.js";
import { createGitHubRepositoryPermissionSpec } from "../src/providers/github/githubSpec.js";
import type { GitHubCredentialSource } from "../src/providers/github/types.js";
import { OktaRestClient } from "../src/providers/okta/oktaClient.js";
import { OktaUserSuspensionProvider } from "../src/providers/okta/oktaProvider.js";
import { OktaUserSuspensionService } from "../src/providers/okta/oktaService.js";
import { createOktaUserSuspensionSpec } from "../src/providers/okta/oktaSpec.js";
import { OKTA_CREDENTIAL_REF, type OktaCredentialSource } from "../src/providers/okta/types.js";
import { NystRuntime, type NystRuntimeOptions } from "../src/runtime/nystRuntime.js";
import { EffectRegistry } from "../src/runtime/registry.js";
import { createMemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";
import { MutableClock, ScriptedGitHubTransport, TEST_GITHUB_TOKEN } from "./githubHelpers.js";
import { ScriptedOktaTransport, TEST_OKTA_ORIGIN, TEST_OKTA_TOKEN, TEST_OKTA_USER_ID } from "./oktaHelpers.js";

class GitHubCredentials implements GitHubCredentialSource {
  async resolve(reference: string): Promise<string> {
    if (reference !== "env:NYST_GITHUB_TOKEN") throw new Error("bad GitHub credential reference");
    return TEST_GITHUB_TOKEN;
  }
}

class OktaCredentials implements OktaCredentialSource {
  async resolve(reference: string): Promise<string> {
    if (reference !== OKTA_CREDENTIAL_REF) throw new Error("bad Okta credential reference");
    return TEST_OKTA_TOKEN;
  }
}

export function makeOffboardingHarness(
  store: Store = createMemoryStore(),
  options: NystRuntimeOptions = {},
  signerOverride?: Signer
) {
  const clock = new MutableClock();
  const oktaTransport = new ScriptedOktaTransport();
  const githubTransport = new ScriptedGitHubTransport();
  const oktaClient = new OktaRestClient(new OktaCredentials(), { clock, transport: oktaTransport });
  const githubClient = new GitHubRestClient(new GitHubCredentials(), { clock, transport: githubTransport });
  const registry = new EffectRegistry();
  registry.register(createOktaUserSuspensionSpec());
  registry.register(createGitHubRepositoryPermissionSpec());
  const signer = signerOverride ?? Ed25519Signer.ephemeral("gate6-test-key");
  const runtime = new NystRuntime(
    store,
    registry,
    [new OktaUserSuspensionProvider(oktaClient, clock), new GitHubRepositoryPermissionProvider(githubClient, clock)],
    signer,
    clock,
    options
  );
  const okta = new OktaUserSuspensionService(runtime, oktaClient, clock);
  const github = new GitHubRepositoryPermissionService(runtime, githubClient, clock);
  const coordinator = new OffboardingCoordinator(store, runtime, okta, github, clock);
  return { clock, store, signer, runtime, oktaTransport, githubTransport, coordinator };
}

export function offboardingIntent(overrides: Partial<Omit<OffboardingRunIntent, "created_at">> = {}): Omit<OffboardingRunIntent, "created_at"> {
  return {
    business_key: "gate6-run-1",
    subject: { subject_key: "employee-fixture-1", display_name: "Fixture Employee" },
    okta: { org: TEST_OKTA_ORIGIN, user_id: TEST_OKTA_USER_ID, credential_ref: OKTA_CREDENTIAL_REF },
    github: { owner: "ACME", repository: "Sandbox", principal: "Alice", baseline_permission: "read", credential_ref: "env:NYST_GITHUB_TOKEN" },
    ...overrides,
  };
}
