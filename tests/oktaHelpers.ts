import type { ClockAttestation } from "../src/core/clock.js";
import { Ed25519Signer } from "../src/core/signing.js";
import { OktaRestClient } from "../src/providers/okta/oktaClient.js";
import { OktaUserSuspensionProvider } from "../src/providers/okta/oktaProvider.js";
import { OktaUserSuspensionService } from "../src/providers/okta/oktaService.js";
import { createOktaUserSuspensionSpec } from "../src/providers/okta/oktaSpec.js";
import {
  OKTA_CREDENTIAL_REF,
  OktaTransportError,
  type OktaCredentialSource,
  type OktaHttpRequest,
  type OktaHttpResponse,
  type OktaTransport,
} from "../src/providers/okta/types.js";
import { NystRuntime, type NystRuntimeOptions } from "../src/runtime/nystRuntime.js";
import { EffectRegistry } from "../src/runtime/registry.js";
import { createMemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";
import { MutableClock } from "./githubHelpers.js";

export const TEST_OKTA_TOKEN = "TEST_OKTA_ACCESS_TOKEN_DO_NOT_PERSIST";
export const TEST_OKTA_ORIGIN = "https://integrator-1234567.okta.com";
export const TEST_OKTA_USER_ID = "00u1234567890ABCDEF0";

class StaticOktaCredentialSource implements OktaCredentialSource {
  async resolve(reference: string): Promise<string> {
    if (reference !== OKTA_CREDENTIAL_REF) throw new Error("unknown credential reference");
    return TEST_OKTA_TOKEN;
  }
}

export interface OktaFixtureOptions {
  status?: string;
  source_type?: string;
  roles?: unknown[];
  transitioning_to_status?: string | null;
}

export class ScriptedOktaTransport implements OktaTransport {
  status: string;
  sourceType: string;
  roles: unknown[];
  transitioningToStatus: string | null;
  login = "fixture.user@example.test";
  userId = TEST_OKTA_USER_ID;
  mutationCount = 0;
  responseLossAfterEffect = false;
  failDefinitelyBeforeSend = false;
  failMayHaveBeenSentBeforeEffect = false;
  successfulResponseWithoutEffect = false;
  forceReadStatus: number | null = null;
  forceReadHeaders: Record<string, string> = {};
  mutationStatus: number | null = null;
  postMutationReads: string[] = [];
  malformedUser: "none" | "invalid_json_shape" | "missing_status" | "oversized_simulated" = "none";
  beforeMutation: (() => void | Promise<void>) | null = null;
  readonly requests: Array<{ method: string; url: string; authorizationPresent: boolean }> = [];
  private serial = 0;
  private mutationOccurred = false;

  constructor(options: OktaFixtureOptions = {}) {
    this.status = options.status ?? "ACTIVE";
    this.sourceType = options.source_type ?? "OKTA";
    this.roles = options.roles ?? [];
    this.transitioningToStatus = options.transitioning_to_status ?? null;
  }

  async send(request: OktaHttpRequest): Promise<OktaHttpResponse> {
    const url = new URL(request.url);
    if (url.origin !== TEST_OKTA_ORIGIN) throw new Error("unexpected Okta origin");
    if (request.headers.Authorization !== `Bearer ${TEST_OKTA_TOKEN}`) throw new Error("credential not supplied");
    this.requests.push({ method: request.method, url: request.url, authorizationPresent: true });
    const headers = { "x-okta-request-id": `req-test-${++this.serial}`, ...this.forceReadHeaders };
    const userPath = `/api/v1/users/${TEST_OKTA_USER_ID}`.toLowerCase();
    if (request.method === "GET" && url.pathname.toLowerCase() === userPath) {
      if (this.forceReadStatus !== null) return { status: this.forceReadStatus, headers, body: { errorCode: "injected" } };
      if (this.malformedUser === "invalid_json_shape") return { status: 200, headers, body: [] };
      const currentStatus = this.currentReadStatus();
      const body: Record<string, unknown> = {
        id: this.userId,
        status: currentStatus,
        transitioningToStatus: this.transitioningToStatus,
        lastUpdated: "2026-08-07T12:00:00.000Z",
        statusChanged: "2026-08-07T12:00:00.000Z",
        profile: { login: this.login, email: this.login },
        credentials: { provider: { type: this.sourceType, name: this.sourceType } },
      };
      if (this.malformedUser === "missing_status") delete body.status;
      return { status: 200, headers, body };
    }
    if (request.method === "GET" && url.pathname.toLowerCase() === `${userPath}/roles`) {
      if (this.forceReadStatus !== null) return { status: this.forceReadStatus, headers, body: { errorCode: "injected" } };
      return { status: 200, headers, body: this.roles };
    }
    if (request.method === "POST" && ["suspend", "unsuspend"].some((op) => url.pathname.toLowerCase() === `${userPath}/lifecycle/${op}`)) {
      if (this.failDefinitelyBeforeSend) throw new OktaTransportError("injected before-send", "definitely_not_sent");
      if (this.failMayHaveBeenSentBeforeEffect) throw new OktaTransportError("injected ambiguous send", "may_have_been_sent");
      await this.beforeMutation?.();
      this.mutationCount++;
      this.mutationOccurred = true;
      if (!this.successfulResponseWithoutEffect && (this.mutationStatus === null || this.mutationStatus === 200)) {
        this.status = url.pathname.endsWith("/suspend") ? "SUSPENDED" : "ACTIVE";
      }
      if (this.responseLossAfterEffect) throw new OktaTransportError("injected response loss", "may_have_been_sent");
      return { status: this.mutationStatus ?? 200, headers, body: null };
    }
    return { status: 404, headers, body: { errorCode: "fixture_route_missing" } };
  }

  private currentReadStatus(): string {
    if (this.mutationOccurred && this.postMutationReads.length > 0) return this.postMutationReads.shift()!;
    return this.status;
  }
}

export function makeOktaHarness(options: OktaFixtureOptions = {}, store: Store = createMemoryStore(), runtimeOptions: NystRuntimeOptions = {}) {
  const clock = new MutableClock();
  const transport = new ScriptedOktaTransport(options);
  const client = new OktaRestClient(new StaticOktaCredentialSource(), { clock, transport });
  const spec = createOktaUserSuspensionSpec();
  const registry = new EffectRegistry();
  registry.register(spec);
  const provider = new OktaUserSuspensionProvider(client, clock);
  const signer = Ed25519Signer.ephemeral("okta-test-key");
  const runtime = new NystRuntime(store, registry, [provider], signer, clock, runtimeOptions);
  const service = new OktaUserSuspensionService(runtime, client, clock);
  return { clock, transport, client, spec, registry, store, provider, signer, runtime, service };
}

export function oktaInput(desired_status: "active" | "suspended" = "suspended") {
  return { org: TEST_OKTA_ORIGIN, user_id: TEST_OKTA_USER_ID, desired_status, credential_ref: OKTA_CREDENTIAL_REF };
}
