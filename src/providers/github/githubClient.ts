import {
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GitHubContractError,
  GitHubCredentialError,
  GitHubTransportError,
  type GitHubApiResponse,
  type GitHubClientOptions,
  type GitHubCredentialSource,
  type GitHubDirectCollaborator,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubMutationPermission,
  type GitHubPermissionObservation,
  type GitHubPrincipalIdentity,
  type GitHubRepositoryIdentity,
  type GitHubRepositoryInvitation,
  type GitHubSafeHeaders,
  type GitHubTransport,
} from "./types.js";

const OWNER_OR_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export class FetchGitHubTransport implements GitHubTransport {
  constructor(private readonly maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES) {}

  async send(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout_ms);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: request.body }),
        redirect: "error",
        signal: controller.signal,
      });
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > this.maxResponseBytes) {
        throw new GitHubContractError("GitHub response exceeded the configured size limit");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxResponseBytes) {
        throw new GitHubContractError("GitHub response exceeded the configured size limit");
      }
      let body: unknown = null;
      if (bytes.byteLength > 0) {
        const text = new TextDecoder().decode(bytes);
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new GitHubContractError("GitHub returned malformed JSON");
        }
      }
      const headers: Record<string, string> = {};
      for (const name of ["x-github-request-id", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return { status: response.status, headers, body };
    } catch (error) {
      if (error instanceof GitHubContractError || error instanceof GitHubTransportError) throw error;
      // Once fetch is invoked, platform errors do not reliably prove that no
      // request bytes crossed the consequence boundary.
      throw new GitHubTransportError("GitHub transport failed", "may_have_been_sent");
    } finally {
      clearTimeout(timer);
    }
  }
}

export class GitHubRestClient {
  private readonly transport: GitHubTransport;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: GitHubCredentialSource,
    private readonly options: GitHubClientOptions
  ) {
    this.transport = options.transport ?? new FetchGitHubTransport(options.max_response_bytes);
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  async getOrganization(org: string, credentialRef: string): Promise<GitHubApiResponse<{ login: string; id: string }>> {
    const response = await this.request("GET", `/orgs/${this.owner(org)}`, credentialRef, null);
    return { ...response, data: response.status === 200 ? parseOrganization(response.data) : null };
  }

  async getRepository(owner: string, repository: string, credentialRef: string): Promise<GitHubApiResponse<GitHubRepositoryIdentity>> {
    const response = await this.request(
      "GET",
      `/repos/${this.owner(owner)}/${this.repository(repository)}`,
      credentialRef,
      null
    );
    return { ...response, data: response.status === 200 ? parseRepository(response.data) : null };
  }

  /**
   * WHO IS THIS CREDENTIAL? (v0.3.3)
   *
   * `GET /user` — the one GitHub call that needs NO configuration at all. It
   * answers the only question a connection preflight should ask: does this
   * token work, and whose is it.
   *
   * This exists because the preflight it replaces demanded three operator
   * environment variables and then required a PRIVATE repository in which a
   * NAMED principal was a DIRECT collaborator — a test fixture wearing a
   * preflight's clothes. No customer could ever satisfy it, so no
   * customer-supplied credential could ever reach "verified".
   *
   * Read-only and unambiguously so: it cannot mutate anything, which keeps
   * invariant I20 true by construction rather than by inspection.
   */
  async getAuthenticatedUser(credentialRef: string): Promise<GitHubApiResponse<GitHubPrincipalIdentity>> {
    const response = await this.request("GET", "/user", credentialRef, null);
    return { ...response, data: response.status === 200 ? parseUser(response.data) : null };
  }

  /**
   * PROVING `github:repository:read` WITHOUT BEING TOLD WHICH REPOSITORY.
   *
   * `GET /user/repos?per_page=1` is scoped to the credential itself, so it
   * needs no operator configuration and no fixture topology — and performing it
   * successfully IS the proof that this credential can read repositories.
   *
   * One page of one item: the cheapest possible request that still constitutes
   * a real read. An empty list is still a successful read (the account may
   * genuinely have no repositories), so the CAPABILITY is proved by the 200,
   * never by the row count.
   */
  async listAccessibleRepositories(credentialRef: string): Promise<GitHubApiResponse<number>> {
    const response = await this.request("GET", "/user/repos?per_page=1", credentialRef, null);
    return { ...response, data: response.status === 200 && Array.isArray(response.data) ? response.data.length : null };
  }

  /** The same idea for `github:organization:read`. See the note above. */
  async listAccessibleOrganizations(credentialRef: string): Promise<GitHubApiResponse<number>> {
    const response = await this.request("GET", "/user/orgs?per_page=1", credentialRef, null);
    return { ...response, data: response.status === 200 && Array.isArray(response.data) ? response.data.length : null };
  }

  async getUser(login: string, credentialRef: string): Promise<GitHubApiResponse<GitHubPrincipalIdentity>> {
    const response = await this.request("GET", `/users/${this.login(login)}`, credentialRef, null);
    return { ...response, data: response.status === 200 ? parseUser(response.data) : null };
  }

  async checkOrganizationMember(
    owner: string,
    login: string,
    credentialRef: string
  ): Promise<GitHubApiResponse<boolean>> {
    const response = await this.request(
      "GET",
      `/orgs/${this.owner(owner)}/members/${this.login(login)}`,
      credentialRef,
      null
    );
    return {
      ...response,
      data: response.status === 204 ? true : response.status === 404 ? false : null,
    };
  }

  async listDirectCollaborators(
    owner: string,
    repository: string,
    credentialRef: string
  ): Promise<GitHubApiResponse<GitHubDirectCollaborator[]>> {
    const all: GitHubDirectCollaborator[] = [];
    let lastHeaders: GitHubSafeHeaders = emptyHeaders();
    for (let page = 1; page <= 10; page++) {
      const response = await this.request(
        "GET",
        `/repos/${this.owner(owner)}/${this.repository(repository)}/collaborators?affiliation=direct&per_page=100&page=${page}`,
        credentialRef,
        null
      );
      lastHeaders = response.headers;
      if (response.status !== 200) return { status: response.status, data: null, headers: response.headers };
      const items = parseDirectCollaborators(response.data);
      all.push(...items);
      if (items.length < 100) return { status: 200, data: all, headers: response.headers };
    }
    throw new GitHubContractError("Direct collaborator listing exceeded the bounded pagination limit");
  }

  async getPermission(
    owner: string,
    repository: string,
    login: string,
    credentialRef: string
  ): Promise<GitHubApiResponse<GitHubPermissionObservation>> {
    const response = await this.request(
      "GET",
      `/repos/${this.owner(owner)}/${this.repository(repository)}/collaborators/${this.login(login)}/permission`,
      credentialRef,
      null
    );
    if (response.status === 404) {
      return {
        status: 404,
        data: { status: "absent", permission: "none", role_name: "none", user: null },
        headers: response.headers,
      };
    }
    return { ...response, data: response.status === 200 ? parsePermission(response.data) : null };
  }

  async listRepositoryInvitations(
    owner: string,
    repository: string,
    credentialRef: string
  ): Promise<GitHubApiResponse<GitHubRepositoryInvitation[]>> {
    const response = await this.request(
      "GET",
      `/repos/${this.owner(owner)}/${this.repository(repository)}/invitations?per_page=100&page=1`,
      credentialRef,
      null
    );
    return {
      ...response,
      data: response.status === 200 ? parseInvitations(response.data) : null,
    };
  }

  async setPermission(
    owner: string,
    repository: string,
    login: string,
    permission: GitHubMutationPermission,
    credentialRef: string
  ): Promise<GitHubApiResponse<null>> {
    const response = await this.request(
      "PUT",
      `/repos/${this.owner(owner)}/${this.repository(repository)}/collaborators/${this.login(login)}`,
      credentialRef,
      JSON.stringify({ permission })
    );
    return { ...response, data: null };
  }

  async removeCollaborator(
    owner: string,
    repository: string,
    login: string,
    credentialRef: string
  ): Promise<GitHubApiResponse<null>> {
    const response = await this.request(
      "DELETE",
      `/repos/${this.owner(owner)}/${this.repository(repository)}/collaborators/${this.login(login)}`,
      credentialRef,
      null
    );
    return { ...response, data: null };
  }

  private async request(
    method: GitHubHttpRequest["method"],
    path: string,
    credentialRef: string,
    body: string | null
  ): Promise<GitHubApiResponse<unknown>> {
    let token: string;
    try {
      token = await this.credentials.resolve(credentialRef);
    } catch (error) {
      if (error instanceof GitHubCredentialError) throw error;
      throw new GitHubCredentialError("GitHub credential resolution failed");
    }
    if (!token || /[\r\n]/.test(token)) throw new GitHubCredentialError("GitHub credential is malformed");
    const response = await this.transport.send({
      method,
      url: `${GITHUB_API_ORIGIN}${path}`,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "Nyst-Effect-Control/1.0",
        ...(body === null ? {} : { "Content-Type": "application/json" }),
      },
      body,
      timeout_ms: this.timeoutMs,
    });
    return { status: response.status, data: response.body, headers: safeHeaders(response.headers) };
  }

  private owner(value: string): string {
    if (!OWNER_OR_LOGIN.test(value)) throw new GitHubContractError("Invalid GitHub owner");
    return encodeURIComponent(value);
  }

  private login(value: string): string {
    if (!OWNER_OR_LOGIN.test(value)) throw new GitHubContractError("Invalid GitHub principal login");
    return encodeURIComponent(value);
  }

  private repository(value: string): string {
    if (!REPOSITORY.test(value) || value === "." || value === "..") {
      throw new GitHubContractError("Invalid GitHub repository name");
    }
    return encodeURIComponent(value);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubContractError(`Malformed GitHub ${label} response`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new GitHubContractError(`Malformed GitHub ${label}`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if ((typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) && typeof value !== "string") {
    throw new GitHubContractError(`Malformed GitHub ${label}`);
  }
  const result = String(value);
  if (!/^\d+$/.test(result)) throw new GitHubContractError(`Malformed GitHub ${label}`);
  return result;
}

function parseOrganization(value: unknown): { login: string; id: string } {
  const body = record(value, "organization");
  return { login: text(body.login, "organization login"), id: identifier(body.id, "organization id") };
}

function parseRepository(value: unknown): GitHubRepositoryIdentity {
  const body = record(value, "repository");
  const owner = record(body.owner, "repository owner");
  if (owner.type !== "Organization") throw new GitHubContractError("Repository is not organization-owned");
  if (typeof body.private !== "boolean") throw new GitHubContractError("Malformed GitHub repository visibility");
  return {
    owner: text(owner.login, "repository owner login"),
    owner_id: identifier(owner.id, "repository owner id"),
    name: text(body.name, "repository name"),
    id: identifier(body.id, "repository id"),
    node_id: text(body.node_id, "repository node id"),
    private: body.private,
  };
}

function parseUser(value: unknown): GitHubPrincipalIdentity {
  const body = record(value, "user");
  if (body.type !== "User") throw new GitHubContractError("Target principal is not a GitHub user");
  return {
    login: text(body.login, "user login"),
    id: identifier(body.id, "user id"),
    node_id: text(body.node_id, "user node id"),
  };
}

function parseDirectCollaborators(value: unknown): GitHubDirectCollaborator[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new GitHubContractError("Malformed GitHub direct collaborator response");
  }
  return value.map((item) => {
    const body = record(item, "direct collaborator");
    return {
      ...parseUser({ ...body, type: body.type ?? "User" }),
      role_name: text(body.role_name, "direct collaborator role_name"),
    };
  });
}

function parsePermission(value: unknown): GitHubPermissionObservation {
  const body = record(value, "permission");
  const permission = text(body.permission, "permission");
  if (!["admin", "write", "read", "none"].includes(permission)) {
    throw new GitHubContractError("GitHub returned an unsupported base permission");
  }
  // GitHub may temporarily omit role_name during collaborator removal. Exact
  // absence remains "none"; a granted base permission without its exact role
  // is preserved as "unknown" so it cannot satisfy a goal or pass preflight.
  const rawRoleName = body.role_name;
  const missingRoleName = rawRoleName === null || rawRoleName === undefined ||
    (typeof rawRoleName === "string" && rawRoleName.trim().length === 0);
  if (!missingRoleName && typeof rawRoleName !== "string") {
    throw new GitHubContractError(`Malformed GitHub role_name (type ${typeof rawRoleName})`);
  }
  const roleName = missingRoleName
    ? permission === "none" ? "none" : "unknown"
    : rawRoleName as string;
  const expectedBase = roleName === "admin" ? "admin"
    : roleName === "write" || roleName === "maintain" ? "write"
    : roleName === "read" || roleName === "triage" ? "read"
    : roleName === "none" ? "none"
    : null;
  if (expectedBase !== null && permission !== expectedBase) {
    throw new GitHubContractError("GitHub permission and role_name were inconsistent");
  }
  return {
    status: "present",
    permission: permission as GitHubPermissionObservation["permission"],
    role_name: roleName,
    user: parseUser(body.user),
  };
}

function parseInvitations(value: unknown): GitHubRepositoryInvitation[] {
  if (!Array.isArray(value) || value.length >= 100) {
    throw new GitHubContractError("Malformed or unbounded GitHub invitations response");
  }
  return value.map((item) => {
    const body = record(item, "repository invitation");
    const invitee = body.invitee === null || body.invitee === undefined
      ? null
      : record(body.invitee, "repository invitation invitee");
    return {
      id: identifier(body.id, "repository invitation id"),
      invitee_id: invitee ? identifier(invitee.id, "repository invitation invitee id") : null,
      invitee_login: invitee ? text(invitee.login, "repository invitation invitee login") : null,
      permission: text(body.permissions ?? body.permission, "repository invitation permission"),
    };
  });
}

function safeHeaders(headers: Readonly<Record<string, string>>): GitHubSafeHeaders {
  const get = (name: string) => {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    const value = entry?.[1] ?? null;
    return value !== null && value.length <= 200 && !/[\r\n]/.test(value) ? value : null;
  };
  return {
    request_id: get("x-github-request-id"),
    retry_after: get("retry-after"),
    rate_limit_remaining: get("x-ratelimit-remaining"),
    rate_limit_reset: get("x-ratelimit-reset"),
    oauth_scopes: get("x-oauth-scopes"),
  };
}

function emptyHeaders(): GitHubSafeHeaders {
  return { request_id: null, retry_after: null, rate_limit_remaining: null, rate_limit_reset: null };
}
