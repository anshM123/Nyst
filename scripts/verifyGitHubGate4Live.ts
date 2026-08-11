/** Gate-4 bounded live canary: real effect, locally discarded response, restart, reconcile, restore. */
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { verifyResolution } from "../dist/src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../dist/src/model/metadata.js";
import {
  FetchGitHubTransport,
  GitHubRestClient,
} from "../dist/src/providers/github/githubClient.js";
import { GitHubRepositoryPermissionProvider } from "../dist/src/providers/github/githubProvider.js";
import { GitHubRepositoryPermissionService } from "../dist/src/providers/github/githubService.js";
import { createGitHubRepositoryPermissionSpec } from "../dist/src/providers/github/githubSpec.js";
import { readGitHubPermissionSnapshot } from "../dist/src/providers/github/githubSnapshot.js";
import {
  EnvironmentGitHubCredentialSource,
  GitHubTransportError,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubTransport,
} from "../dist/src/providers/github/types.js";
import { NystRuntime } from "../dist/src/runtime/nystRuntime.js";
import { ProcessCrashError } from "../dist/src/runtime/provider.js";
import { EffectRegistry } from "../dist/src/runtime/registry.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";

class DiscardAfterMutationTransport implements GitHubTransport {
  mutationAttempts = 0;
  discardNextMutation = true;
  private readonly inner: GitHubTransport;
  constructor(inner: GitHubTransport) { this.inner = inner; }
  async send(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const mutation = request.method === "PUT" || request.method === "DELETE";
    if (mutation) this.mutationAttempts++;
    const response = await this.inner.send(request);
    if (mutation && this.discardNextMutation) {
      this.discardNextMutation = false;
      throw new GitHubTransportError("Injected response loss after real GitHub consequence", "may_have_been_sent");
    }
    return response;
  }
}

const databaseUrl = required("DATABASE_URL");
const owner = process.env.NYST_GITHUB_OWNER ?? "nyst-ai-outcomes";
const repository = process.env.NYST_GITHUB_REPOSITORY ?? "nyst-permission-fixture";
const principal = process.env.NYST_GITHUB_PRINCIPAL ?? "chikookutti-cyber";
if (required("NYST_GITHUB_BASELINE_PERMISSION") !== "read" ||
    required("NYST_GITHUB_TEST_PERMISSION") !== "write") {
  throw new Error("Gate-4 live canary is locked to reversible read -> write -> read");
}

const credential_ref = "env:NYST_GITHUB_TOKEN";
const clock = new LocalSystemClock();
const transport = new DiscardAfterMutationTransport(new FetchGitHubTransport());
const client = new GitHubRestClient(new EnvironmentGitHubCredentialSource(), { clock, transport });
const store = await createPostgresStore(databaseUrl);
const registry = new EffectRegistry();
registry.register(createGitHubRepositoryPermissionSpec());
const signer = Ed25519Signer.ephemeral("gate4-live-canary");
const provider = new GitHubRepositoryPermissionProvider(client, clock);
const input = (desired_permission: "read" | "write") => ({
  owner, repository, principal, desired_permission, credential_ref,
});
const snapshot = () => readGitHubPermissionSnapshot(client, input("read"));
const runId = new Date().toISOString().replace(/[^0-9]/g, "");
const businessKey = `gate4-live:${runId}:response-loss`;
const started = Date.now();
let mutationAttempted = false;
let restored = false;

try {
  const initial = await snapshot();
  assert(initial.permission.role_name === "read", "fixture did not start at read");
  assert(initial.direct_collaborator !== null, "fixture principal is not a direct collaborator");
  const initialDirect = await client.listDirectCollaborators(owner, repository, credential_ref);
  const initialInvites = await client.listRepositoryInvitations(owner, repository, credential_ref);
  assert(initialDirect.status === 200 && initialDirect.data !== null, "initial collaborator inventory failed");
  assert(initialInvites.status === 200 && initialInvites.data !== null, "initial invitation inventory failed");

  let crashed = false;
  const firstRuntime = new NystRuntime(store, registry, [provider], signer, clock, {
    fault_injector(point) {
      if (!crashed && point === "before_reconciliation") {
        crashed = true;
        throw new ProcessCrashError("gate4_live_restart_before_reconciliation");
      }
    },
  });
  const firstService = new GitHubRepositoryPermissionService(firstRuntime, client, clock);
  mutationAttempted = true;
  await expectCrash(() => firstService.commit(businessKey, input("write"), EMPTY_CONTEXT));
  const action = await store.actions.findByIdentity("github.repository_permission_change", businessKey);
  assert(action?.dispatch_plan, "durable action/DispatchPlan missing after crash");
  const persistedPlan = JSON.stringify(action.dispatch_plan);
  assert(transport.mutationAttempts === 1, "response-loss action did not make exactly one provider write");

  const restartedRuntime = new NystRuntime(store, registry, [provider], signer, clock);
  const recovered = await restartedRuntime.recover(action.action_id);
  assert(recovered.effect.state === "satisfied_unattributed", "restart did not reconcile exact write goal");
  assert(recovered.control.retry === "forbidden", "restart authorized unsafe retry");
  assert(recovered.control.continuation === "allowed", "exact recovered goal did not permit continuation");
  assert(verifyResolution(signer, recovered), "recovered signature failed");
  assert(JSON.stringify((await store.actions.getAction(action.action_id))?.dispatch_plan) === persistedPlan,
    "DispatchPlan changed across restart");
  assert(transport.mutationAttempts === 1, "restart/reconciliation duplicated the provider write");
  const changed = await snapshot();
  assert(changed.permission.role_name === "write", "external read did not confirm write after response loss");

  const restoreService = new GitHubRepositoryPermissionService(restartedRuntime, client, clock);
  const restore = await restoreService.commit(`gate4-live:${runId}:restore`, input("read"), EMPTY_CONTEXT);
  assert(restore.resolution.effect.state === "satisfied_unattributed", "Nyst restore did not reach read");
  assert(verifyResolution(signer, restore.resolution), "restore signature failed");
  const final = await snapshot();
  restored = final.permission.role_name === "read" && final.direct_collaborator !== null;
  assert(restored, "fixture final role/direct relationship was not restored");
  const finalDirect = await client.listDirectCollaborators(owner, repository, credential_ref);
  const finalInvites = await client.listRepositoryInvitations(owner, repository, credential_ref);
  assert(finalDirect.status === 200 && finalDirect.data !== null, "final collaborator inventory failed");
  assert(finalInvites.status === 200 && finalInvites.data !== null, "final invitation inventory failed");
  assert(inventory(initialDirect.data) === inventory(finalDirect.data), "collaborator inventory changed");
  assert(invites(initialInvites.data) === invites(finalInvites.data), "invitation inventory changed");

  console.log(JSON.stringify({
    gate: 4,
    live: true,
    scenario: "real_effect_response_discard_restart_reconcile",
    action_id: action.action_id,
    repository_id: initial.repository.id,
    repository: `${initial.repository.owner}/${initial.repository.name}`,
    principal_id: initial.principal.id,
    desired_role: "write",
    observed_pre_state: "read",
    observed_post_state: changed.permission.role_name,
    final_effect_state: recovered.effect.state,
    final_control: recovered.control.primary,
    retry: recovered.control.retry,
    continuation: recovered.control.continuation,
    evidence_methods: recovered.effect.verification_methods,
    provider_write_count_for_action: 1,
    cleanup_write_count: transport.mutationAttempts - 1,
    duration_ms: Date.now() - started,
    final_role: final.permission.role_name,
    fixture_restored: restored,
    collaborator_inventory_restored: true,
    invitation_inventory_unchanged: true,
    resolution_signed: true,
  }));
} finally {
  if (mutationAttempted && !restored) {
    try {
      transport.discardNextMutation = false;
      const current = await snapshot();
      if (current.permission.role_name !== "read") {
        assert(current.direct_collaborator !== null, "cleanup refused because direct relationship disappeared");
        const response = await client.setPermission(owner, repository, principal, "pull", credential_ref);
        assert(response.status === 204, `emergency cleanup returned HTTP ${response.status}`);
      }
      const final = await snapshot();
      restored = final.permission.role_name === "read" && final.direct_collaborator !== null;
      if (!restored) console.error("GATE4_LIVE_CLEANUP_FAILED");
    } catch {
      console.error("GATE4_LIVE_CLEANUP_FAILED");
    }
  }
  await store.close();
}

async function expectCrash(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProcessCrashError) return;
    throw error;
  }
  throw new Error("expected injected process crash did not occur");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inventory(items: Array<{ id: string; role_name: string }>): string {
  return JSON.stringify(items.map((item) => [item.id, item.role_name]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
}

function invites(items: Array<{ id: string; invitee_id: string | null; permission: string }>): string {
  return JSON.stringify(items.map((item) => [item.id, item.invitee_id, item.permission]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
}
