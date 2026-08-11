import type { ClockAttestation, ClockAttestor } from "../src/core/clock.js";
import { Ed25519Signer } from "../src/core/signing.js";
import { GitHubRestClient } from "../src/providers/github/githubClient.js";
import { GitHubRepositoryPermissionProvider } from "../src/providers/github/githubProvider.js";
import { GitHubRepositoryPermissionService } from "../src/providers/github/githubService.js";
import { createGitHubRepositoryPermissionSpec } from "../src/providers/github/githubSpec.js";
import {
  GitHubTransportError,
  type GitHubCredentialSource,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubPermission,
  type GitHubTransport,
} from "../src/providers/github/types.js";
import { NystRuntime, type NystRuntimeOptions } from "../src/runtime/nystRuntime.js";
import { EffectRegistry } from "../src/runtime/registry.js";
import { createMemoryStore } from "../src/store/memoryStore.js";
import type { Store } from "../src/store/store.js";

export const TEST_GITHUB_TOKEN = "github_pat_TEST_SECRET_DO_NOT_PERSIST";

export class MutableClock implements ClockAttestor {
  private tick = 0;
  constructor(private current = "2026-08-07T12:00:00.000Z") {}
  now(): ClockAttestation {
    const timestamp = new Date(new Date(this.current).getTime() + this.tick++ * 1000).toISOString();
    return { source: "local_system_clock", timestamp, trusted: false };
  }
  advance(milliseconds: number): void {
    this.current = new Date(new Date(this.current).getTime() + milliseconds).toISOString();
    this.tick = 0;
  }
}

export class StaticCredentialSource implements GitHubCredentialSource {
  async resolve(reference: string): Promise<string> {
    if (reference !== "env:NYST_GITHUB_TOKEN") throw new Error("unknown credential reference");
    return TEST_GITHUB_TOKEN;
  }
}

export interface GitHubFixtureOptions {
  role?: string;
  direct_role?: string;
  direct?: boolean;
  organization_member?: boolean;
  private_repository?: boolean;
}

export class ScriptedGitHubTransport implements GitHubTransport {
  role: string;
  directRole: string | null;
  direct: boolean;
  organizationMember: boolean;
  privateRepository: boolean;
  mutationCount = 0;
  responseLossAfterEffect = false;
  failDefinitelyBeforeSend = false;
  failMayHaveBeenSentBeforeEffect = false;
  successfulResponseWithoutEffect = false;
  malformedPermissionResponse = false;
  permissionNoneAs200WithoutRoleName = false;
  permissionRoleNameNull = false;
  permissionRoleNameEmpty = false;
  responseDelayMs = 0;
  inheritedRoleAfterRemoval: string | null = null;
  inheritedRoleAfterSet: string | null = null;
  postMutationReads: string[] = [];
  forceStatus: number | null = null;
  forceHeaders: Record<string, string> = {};
  mutationStatus: number | null = null;
  permissionBaseOverride: "admin" | "write" | "read" | "none" | null = null;
  permissionPrincipalOverride: { login: string; id: number; node_id: string; type: "User" } | null = null;
  beforeMutation: (() => void | Promise<void>) | null = null;
  readonly requests: Array<{ method: string; url: string; authorizationPresent: boolean }> = [];
  private serial = 0;
  private mutationOccurred = false;

  constructor(options: GitHubFixtureOptions = {}) {
    this.role = options.role ?? "read";
    this.directRole = options.direct_role ?? null;
    this.direct = options.direct ?? true;
    this.organizationMember = options.organization_member ?? true;
    this.privateRepository = options.private_repository ?? true;
  }

  async send(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (this.responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs));
    }
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();
    if (url.origin !== "https://api.github.com") throw new Error("unexpected API origin");
    if (request.headers.Authorization !== `Bearer ${TEST_GITHUB_TOKEN}`) {
      throw new Error("credential was not supplied to transport");
    }
    this.requests.push({
      method: request.method,
      url: request.url,
      authorizationPresent: Object.keys(request.headers).some((key) => key.toLowerCase() === "authorization"),
    });
    const headers = { "x-github-request-id": `TEST-${++this.serial}`, ...this.forceHeaders };
    if (this.forceStatus !== null) return { status: this.forceStatus, headers, body: { message: "injected" } };

    if (request.method === "GET" && path === "/orgs/acme") {
      return { status: 200, headers, body: { login: "Acme", id: 10 } };
    }
    if (request.method === "GET" && path === "/repos/acme/sandbox") {
      return {
        status: 200,
        headers,
        body: {
          id: 20,
          node_id: "R_repo20",
          name: "Sandbox",
          private: this.privateRepository,
          owner: { login: "Acme", id: 10, type: "Organization" },
        },
      };
    }
    if (request.method === "GET" && path === "/users/alice") {
      return { status: 200, headers, body: user() };
    }
    if (request.method === "GET" && path === "/orgs/acme/members/alice") {
      return { status: this.organizationMember ? 204 : 404, headers, body: null };
    }
    if (
      request.method === "GET" &&
      path === "/repos/acme/sandbox/collaborators" &&
      url.searchParams.get("affiliation") === "direct"
    ) {
      return {
        status: 200,
        headers,
        body: this.direct ? [{ ...user(), permissions: {}, role_name: this.directRole ?? this.role }] : [],
      };
    }
    if (request.method === "GET" && path === "/repos/acme/sandbox/collaborators/alice/permission") {
      if (this.malformedPermissionResponse) {
        return { status: 200, headers, body: { permission: "write", role_name: 42, user: user() } };
      }
      const role = this.currentReadRole();
      return role === "none"
        ? this.permissionNoneAs200WithoutRoleName
          ? { status: 200, headers, body: { permission: "none", role_name: null, user: user() } }
          : { status: 404, headers, body: { message: "Not Found" } }
        : {
            status: 200,
            headers,
            body: {
              permission: this.permissionBaseOverride ?? basePermission(role),
              role_name: this.permissionRoleNameEmpty && this.mutationOccurred
                ? ""
                : this.permissionRoleNameNull && this.mutationOccurred ? null : role,
              user: this.permissionPrincipalOverride ?? user(),
            },
          };
    }
    if (request.method === "GET" && path === "/repos/acme/sandbox/invitations") {
      return { status: 200, headers, body: [] };
    }
    if (request.method === "PUT" && path === "/repos/acme/sandbox/collaborators/alice") {
      if (this.failDefinitelyBeforeSend) {
        throw new GitHubTransportError("injected before-send failure", "definitely_not_sent");
      }
      if (this.failMayHaveBeenSentBeforeEffect) {
        throw new GitHubTransportError("injected ambiguous send failure", "may_have_been_sent");
      }
      await this.beforeMutation?.();
      this.mutationCount++;
      this.mutationOccurred = true;
      if (!this.successfulResponseWithoutEffect) {
        const body = JSON.parse(request.body ?? "{}") as { permission?: string };
        this.role = this.inheritedRoleAfterSet ?? fromMutationPermission(body.permission);
        this.direct = true;
      }
      if (this.responseLossAfterEffect) {
        throw new GitHubTransportError("injected response loss", "may_have_been_sent");
      }
      return { status: this.mutationStatus ?? (this.organizationMember ? 204 : 201), headers, body: null };
    }
    if (request.method === "DELETE" && path === "/repos/acme/sandbox/collaborators/alice") {
      if (this.failDefinitelyBeforeSend) {
        throw new GitHubTransportError("injected before-send failure", "definitely_not_sent");
      }
      if (this.failMayHaveBeenSentBeforeEffect) {
        throw new GitHubTransportError("injected ambiguous send failure", "may_have_been_sent");
      }
      await this.beforeMutation?.();
      this.mutationCount++;
      this.mutationOccurred = true;
      if (!this.successfulResponseWithoutEffect) {
        this.direct = false;
        this.role = this.inheritedRoleAfterRemoval ?? "none";
      }
      if (this.responseLossAfterEffect) {
        throw new GitHubTransportError("injected response loss", "may_have_been_sent");
      }
      return { status: this.mutationStatus ?? 204, headers, body: null };
    }
    return { status: 404, headers, body: { message: "fixture route not found" } };
  }

  private currentReadRole(): string {
    if (this.mutationOccurred && this.postMutationReads.length > 0) {
      return this.postMutationReads.shift()!;
    }
    return this.role;
  }
}

export function makeGitHubHarness(
  options: GitHubFixtureOptions = {},
  store: Store = createMemoryStore(),
  runtimeOptions: NystRuntimeOptions = {}
) {
  const clock = new MutableClock();
  const transport = new ScriptedGitHubTransport(options);
  const client = new GitHubRestClient(new StaticCredentialSource(), { clock, transport });
  const spec = createGitHubRepositoryPermissionSpec();
  const registry = new EffectRegistry();
  registry.register(spec);
  const provider = new GitHubRepositoryPermissionProvider(client, clock);
  const signer = Ed25519Signer.ephemeral("github-test-key");
  const runtime = new NystRuntime(store, registry, [provider], signer, clock, runtimeOptions);
  const service = new GitHubRepositoryPermissionService(runtime, client, clock);
  return { clock, transport, client, spec, registry, store, provider, signer, runtime, service };
}

export function githubInput(desired_permission: GitHubPermission = "write") {
  return {
    owner: "ACME",
    repository: "Sandbox",
    principal: "Alice",
    desired_permission,
    credential_ref: "env:NYST_GITHUB_TOKEN",
  };
}

function user() {
  return { login: "Alice", id: 30, node_id: "U_user30", type: "User" };
}

function basePermission(role: string): "admin" | "write" | "read" | "none" {
  if (role === "admin") return "admin";
  if (role === "write" || role === "maintain") return "write";
  if (role === "read" || role === "triage") return "read";
  return "none";
}

function fromMutationPermission(value: string | undefined): string {
  switch (value) {
    case "pull": return "read";
    case "triage": return "triage";
    case "push": return "write";
    case "maintain": return "maintain";
    case "admin": return "admin";
    default: throw new Error("unsupported mutation permission");
  }
}
