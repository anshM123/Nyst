/**
 * Bounded Gate-5 canary for a dedicated synthetic Okta user.
 * Secrets are process-environment only and are never printed or persisted.
 * Required: DATABASE_URL, NYST_OKTA_ORG, NYST_OKTA_USER_ID, NYST_OKTA_ACCESS_TOKEN.
 * Optional: NYST_OKTA_EXPECTED_LOGIN.
 */
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { verifyResolution } from "../dist/src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../dist/src/model/metadata.js";
import { FetchOktaTransport, OktaRestClient } from "../dist/src/providers/okta/oktaClient.js";
import { OktaUserSuspensionProvider } from "../dist/src/providers/okta/oktaProvider.js";
import { OktaUserSuspensionService } from "../dist/src/providers/okta/oktaService.js";
import { readOktaUserSnapshot } from "../dist/src/providers/okta/oktaSnapshot.js";
import { createOktaUserSuspensionSpec } from "../dist/src/providers/okta/oktaSpec.js";
import {
  EnvironmentOktaCredentialSource,
  OKTA_CREDENTIAL_REF,
  OktaTransportError,
  type OktaHttpRequest,
  type OktaHttpResponse,
  type OktaTransport,
} from "../dist/src/providers/okta/types.js";
import { NystRuntime } from "../dist/src/runtime/nystRuntime.js";
import { EffectRegistry } from "../dist/src/runtime/registry.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";

class ResponseDroppingTransport implements OktaTransport {
  lifecycleWrites = 0;
  dropNextSuspendResponse = false;
  private readonly inner: OktaTransport;
  constructor(inner: OktaTransport) { this.inner = inner; }
  async send(request: OktaHttpRequest): Promise<OktaHttpResponse> {
    const lifecycle = request.method === "POST" && request.url.includes("/lifecycle/");
    if (lifecycle) this.lifecycleWrites++;
    const response = await this.inner.send(request);
    if (this.dropNextSuspendResponse && request.url.endsWith("/lifecycle/suspend") && response.status === 200) {
      this.dropNextSuspendResponse = false;
      throw new OktaTransportError("Okta response deliberately discarded after provider consequence", "may_have_been_sent");
    }
    return response;
  }
}

const databaseUrl = required("DATABASE_URL");
const org = required("NYST_OKTA_ORG");
const userId = required("NYST_OKTA_USER_ID");
const expectedLogin = process.env.NYST_OKTA_EXPECTED_LOGIN ?? null;
const clock = new LocalSystemClock();
const transport = new ResponseDroppingTransport(new FetchOktaTransport());
const client = new OktaRestClient(new EnvironmentOktaCredentialSource(), { clock, transport });
const store = await createPostgresStore(databaseUrl);
const registry = new EffectRegistry(); registry.register(createOktaUserSuspensionSpec());
const signer = Ed25519Signer.ephemeral("gate5-live-canary");
const provider = new OktaUserSuspensionProvider(client, clock);
const runtime = new NystRuntime(store, registry, [provider], signer, clock);
const service = new OktaUserSuspensionService(runtime, client, clock);
const input = (desired_status: "active" | "suspended") => ({ org, user_id: userId, desired_status, credential_ref: OKTA_CREDENTIAL_REF });
const snapshot = () => readOktaUserSnapshot(client, { org, user_id: userId, credential_ref: OKTA_CREDENTIAL_REF });
const runId = new Date().toISOString().replace(/[^0-9]/g, "");
let restored = false;
let emergencyCleanup = false;

try {
  const initial = await snapshot();
  assertFixture(initial.user.status === "ACTIVE", "fixture must start ACTIVE");
  assertFixture(initial.user.transitioning_to_status === null, "fixture must not be transitioning");
  assertFixture(initial.user.source_type === "OKTA", "fixture must be Okta-sourced");
  if (expectedLogin) assertFixture(initial.user.login === expectedLogin, "fixture login mismatch");

  const normalSuspend = await service.commit(`gate5-live:${runId}:normal:suspend`, input("suspended"), EMPTY_CONTEXT);
  assertResolution(normalSuspend.resolution, "normal suspend");
  assertFixture((await snapshot()).user.status === "SUSPENDED", "normal suspend read-back failed");
  const normalRestore = await service.commit(`gate5-live:${runId}:normal:restore`, input("active"), EMPTY_CONTEXT);
  assertResolution(normalRestore.resolution, "normal restore");
  assertFixture((await snapshot()).user.status === "ACTIVE", "normal restore read-back failed");

  const beforeLossWrites = transport.lifecycleWrites;
  transport.dropNextSuspendResponse = true;
  const loss = await service.commit(`gate5-live:${runId}:loss:suspend`, input("suspended"), EMPTY_CONTEXT);
  assertFixture(transport.lifecycleWrites - beforeLossWrites === 1, "ambiguous action performed more than one lifecycle write");
  const restarted = new NystRuntime(store, registry, [provider], signer, clock);
  const recovered = await restarted.recover(loss.action.action_id);
  assertResolution(recovered, "response-loss recovery");
  assertFixture((await snapshot()).user.status === "SUSPENDED", "response-loss read-back failed");
  assertFixture(transport.lifecycleWrites - beforeLossWrites === 1, "recovery redispatched the lifecycle operation");

  const lossRestore = await service.commit(`gate5-live:${runId}:loss:restore`, input("active"), EMPTY_CONTEXT);
  assertResolution(lossRestore.resolution, "response-loss restore");
  const final = await snapshot();
  restored = final.user.status === "ACTIVE" && final.user.id === initial.user.id && final.user.login === initial.user.login;
  assertFixture(restored, "final independent read did not prove baseline restoration");

  console.log(JSON.stringify({
    gate: 5, live: true, provider: "okta", tenant_host: new URL(org).hostname,
    user_id: initial.user.id, transitions: ["ACTIVE->SUSPENDED", "SUSPENDED->ACTIVE", "ACTIVE->SUSPENDED(response_lost)", "SUSPENDED->ACTIVE"],
    lifecycle_writes: transport.lifecycleWrites, ambiguous_action_writes: 1,
    resolutions_signed: true, final_status: final.user.status, fixture_restored: restored,
  }));
} finally {
  if (!restored) {
    try {
      const current = await snapshot();
      if (current.user.status === "SUSPENDED") {
        const cleanup = await service.commit(`gate5-live:${runId}:finally:restore`, input("active"), EMPTY_CONTEXT);
        assertResolution(cleanup.resolution, "finally restore");
      }
      restored = (await snapshot()).user.status === "ACTIVE";
    } catch {
      try {
        emergencyCleanup = true;
        const response = await client.unsuspendUser(org, userId, OKTA_CREDENTIAL_REF);
        restored = response.status === 200 && (await snapshot()).user.status === "ACTIVE";
      } catch { restored = false; }
    }
    if (!restored) console.error("GATE5_LIVE_CLEANUP_FAILED");
    if (emergencyCleanup) console.error("GATE5_LIVE_EMERGENCY_CLEANUP_USED");
  }
  await store.close();
}

function required(name: string): string {
  const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value;
}
function assertFixture(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function assertResolution(resolution: Parameters<typeof verifyResolution>[1], label: string): void {
  assertFixture(resolution.effect.state === "satisfied_unattributed", `${label} did not reach exact goal`);
  assertFixture(resolution.control.retry === "forbidden", `${label} did not forbid retry`);
  assertFixture(verifyResolution(signer, resolution), `${label} signature failed`);
}
