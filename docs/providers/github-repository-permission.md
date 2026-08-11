# GitHub repository permission — Gate 3 provider semantics

Current release fixture: future destructive canaries target the private disposable `nyst-ai-outcomes/nyst-permission-fixture` repository. Historical Gate 3/4/6 evidence naming `nyst-ai-outcomes/nyst.ai` remains accurate for those frozen runs; that repository is now reserved for Nyst source.

Status: design locked before implementation on 2026-08-07; implementation and bounded live verification subsequently passed Gate 3. Gate-4 adversarial evidence is recorded separately in `github-gate4-verification.md`.

## Official contract researched

Nyst pins GitHub REST API version `2026-03-10`, the newest supported version on 2026-08-07, and sends `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10`, and a fixed Nyst `User-Agent`.

Official sources:

- [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2026-03-10)
- [Repository collaborator endpoints](https://docs.github.com/en/rest/collaborators/collaborators?apiVersion=2026-03-10)
- [Repository endpoints](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10)
- [User endpoints](https://docs.github.com/en/rest/users/users?apiVersion=2026-03-10)
- [REST API best practices and rate-limit handling](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2026-03-10)
- [REST API troubleshooting, including ambiguous 404 and rate-limit responses](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api?apiVersion=2026-03-10)
- [Keeping API credentials secure](https://docs.github.com/en/rest/authentication/keeping-your-api-credentials-secure?apiVersion=2026-03-10)

The relevant provider operations are:

- `GET /orgs/{org}` to establish that the owner is an organization.
- `GET /repos/{owner}/{repo}` to establish repository visibility and capture stable repository `id` and `node_id`.
- `GET /users/{username}` to resolve the principal and capture stable user `id`, `node_id`, and canonical login.
- `GET /orgs/{org}/members/{username}` to establish active organization membership before any role-setting PUT, preventing the supported path from becoming an outside-collaborator invitation.
- `GET /repos/{owner}/{repo}/collaborators?affiliation=direct` to establish the direct-collaborator relationship. GitHub documents `direct` as collaborators with permissions directly on an organization repository regardless of organization membership. The returned `role_name` is still the highest role across all grant sources, not proof of the direct role.
- `GET /repos/{owner}/{repo}/collaborators/{username}/permission` to observe the highest effective repository role after repository, team, organization, and enterprise grants.
- `PUT /repos/{owner}/{repo}/collaborators/{username}` with `pull`, `triage`, `push`, `maintain`, or `admin` to change an existing collaborator. `201` means an invitation was created; `204` is the supported existing-collaborator response.
- `DELETE /repos/{owner}/{repo}/collaborators/{username}` to remove the direct collaborator relationship.

GitHub documents that removal returns immediately while additional permission updates may continue in the background. It also explicitly warns that organization permissions can preserve repository access after direct removal.

Fine-grained PAT, GitHub App user token, and GitHub App installation token are supported by the relevant collaborator endpoints. The least-privilege live fixture credential is restricted to the one disposable repository with:

- Repository `Administration: write` for PUT/DELETE.
- Repository `Metadata: read` for repository, collaborator, and permission observations.
- Organization `Members: read` to establish private organization membership for the target principal.

A short-lived GitHub App installation token is preferred for production. A repository-scoped, expiring fine-grained PAT is acceptable only for the bounded Gate 3 canary. Classic PATs are not the target credential model.

## Exact supported effect

The single versioned effect is `github.repository_permission_change`.

Its promise is:

> For one stable GitHub user and one organization-owned repository, use the direct-collaborator mutation surface to attempt an exact standard effective repository role goal, then independently report whether the user's highest effective repository role equals that goal.

The public desired roles are `none`, `read`, `triage`, `write`, `maintain`, and `admin`. Mutation normalization is centralized:

| Nyst role | GitHub mutation value | Exact effective proof |
| --- | --- | --- |
| `none` | DELETE | permission is `none`/meaningfully absent after visibility and identity preconditions, and the user is absent from the direct list |
| `read` | `pull` | `role_name = read` |
| `triage` | `triage` | `role_name = triage` |
| `write` | `push` | `role_name = write` |
| `maintain` | `maintain` | `role_name = maintain` |
| `admin` | `admin` | `role_name = admin` |

The legacy `permission` field is never used to prove `triage` or `maintain`: GitHub maps those to `read` and `write`. Exact non-custom proof uses `role_name`.

## Scope and preconditions

Supported:

- GitHub.com at the fixed `https://api.github.com` origin only.
- Private organization-owned repositories. Requiring a private fixture makes a successful repository metadata read meaningful evidence that the credential can see the protected resource.
- Stable repository and principal IDs resolved before mutation and persisted in the DispatchPlan.
- Standard GitHub repository roles only.
- A designated active organization member who is an existing direct collaborator for a role change or removal.
- A no-write preexisting-goal path when the goal and required direct relationship already match.

Unsupported and rejected before consequence:

- Personal repositories, GitHub Enterprise Server hosts, arbitrary API-host overrides, custom repository roles, repository invitations, unresolved/renamed identities, a role grant to someone who is not already a direct collaborator, and any topology whose required repository/principal/direct relationship cannot be established.
- A removal request when direct access is absent but inherited effective access remains. This endpoint cannot remove the inherited grant, so Nyst must not pretend it can satisfy the offboarding goal.
- Outside collaborators in this first version. GitHub documents that PUT returns `204` for an organization member but may return `201` and create an invitation for another target. Nyst revalidates active membership immediately before PUT and treats any unexpected `201` as an unsupported provider outcome, never as access proof.

Owner, repository, and login inputs are case-normalized for logical identity, but the resolved stable IDs and canonical provider names are persisted and revalidated before mutation and during observation. Path components are strictly validated and URL-encoded.

## Direct assignment versus effective access

GitHub does not expose the exact direct assigned role separately from the highest effective role in these endpoints. `affiliation=direct` can establish whether a direct relationship exists, but its `role_name` still reflects the highest role across repository, teams, organization, and enterprise.

Therefore Nyst does **not** promise that it can prove the exact source-specific direct role. It uses direct mutation as the mechanism and effective permission as the controlled goal:

- Direct removal plus inherited `write` is not effective removal.
- A direct downgrade plus inherited `write` is not an effective downgrade to `read`.
- A custom `role_name` is unsupported, not collapsed into a base role.
- Effective goal satisfaction never proves which grant source caused it.

## Evidence and state standards

Mutation responses are corroborative execution evidence only. A `204` can never produce `verified`; a `201` is an unsupported invitation outcome and never proves effective access.

GitHub provides no action/idempotency correlation on later permission reads. Consequently this Gate 3 adapter does not claim provider-proven attribution and does not emit `verified`. That state remains defined for providers that can supply an authoritative action-correlated event/read, but it is intentionally unreachable for this EffectSpec version.

`satisfied_unattributed` requires an authoritative, current, identity-checked read proving the exact effective goal:

- repository metadata is readable and its stable ID matches the DispatchPlan;
- principal identity is readable and its stable ID matches the DispatchPlan;
- `role_name` exactly equals a supported non-custom desired role, or meaningful absence is established for `none`;
- the direct relationship is present for a non-`none` goal and absent for `none`;
- no contradictory active evidence exists.

This covers both a preexisting goal and a goal observed after a mutation or lost response. The state is deliberately unattributed because another actor or inherited grant could have produced the same effective state.

`not_applied` requires an authoritative post-window observation proving the exact desired goal is absent while repository visibility, credential validity, stable repository identity, and stable principal identity are all established. Generic 404, 401/403, 422, 5xx, timeout, or a stale pre-window read is never absence proof.

`pending` is used while the consistency window remains open and an authoritative read still shows the old role after a possible/successful mutation. A recognized 403/429 rate-limit response also produces `pending`/`hold` with a bounded provider-informed `next_check_at`; it never preserves an older continuation authorization. Each reconciliation performs one bounded observation set, never loops indefinitely, and never writes while polling.

`unprovable` is used for authentication/authorization failure, ambiguous 404, identity mismatch/rename, inaccessible repository, unsupported custom role/topology, malformed response, contradictory terminal observations, exhausted consistency window without a reliable proof basis, or other unresolved provider ambiguity.

`compensated` is unsupported. Gate 3 does not invent a rollback policy for repository access.

## Retry and continuation

There is no provider idempotency key. The persisted plan is stable, but that does not make a blind repeat safe.

- Pending, unprovable, satisfied-unattributed, and any may-have-been-sent path forbid retry.
- A controlled retry may be authorized only when current authoritative evidence proves the goal absent **and** the durable runtime proves the provider request definitely did not cross the send boundary. The runtime revalidates resolution/evidence sequences and owns the retry claim immediately before consequence.
- At most one controlled retry is available, reusing the exact persisted DispatchPlan.
- Reconciliation never writes.

Exact effective goal satisfaction is sufficient for dependent continuation even without attribution, so `satisfied_unattributed` may allow continuation. This is safe for the defined goal: for offboarding, effective permission must be `none`, not merely direct removal. Pending, unprovable, not-applied, wrong-role, inherited-higher-access, identity mismatch, custom role, or contradiction always blocks continuation.

Continuation authorization is sequence-bound and must be revalidated immediately before the caller's downstream consequence. Gate 3 does not claim permanent authorization and does not turn Nyst into a workflow engine.

## Consistency and rate-limit policy

One reconciliation run performs a fixed, bounded set of reads with no mutating call. No infinite poll loop exists. The initial consistency window is five minutes for permission change/removal; observations before its deadline can remain pending. Callers/schedulers use signed `next_check_at` values and explicitly invoke reconciliation again.

The client permits only the allowlisted `Retry-After`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers across its transport boundary. Version 1.0.0 does not sleep inside the provider or claim that it owns scheduling. It records a bounded next check using `Retry-After` first, then `X-RateLimit-Reset`, then a one-minute default; the result is clamped between one and five minutes. Rate limiting blocks continuation and never causes mutation redispatch. Nyst does not deliberately provoke live rate limits.

## DispatchPlan and secrets

Before any consequence, the durable plan contains only non-secret material:

- provider and API version;
- operation kind (`set_permission`, `remove_collaborator`, or `observe_only`);
- canonical owner/repository/login plus stable repository and principal IDs/node IDs;
- the active-organization-member precondition;
- exact normalized desired role and GitHub mutation role;
- credential reference, not credential material;
- consistency deadline and Nyst action correlation.

The token comes from a credential provider at request time. It is never accepted in semantic input, stored in action/evidence/resolution data, included in errors, or logged. Authorization headers and raw response headers are never persisted; only an allowlist such as request ID and bounded rate-limit timing may enter evidence.

## Live verification requirement

Gate 3 can pass only after bounded mutation canaries against a dedicated disposable organization repository and dedicated test collaborator, followed by independent reads and fixture restoration. At design time this workspace has no `NYST_GITHUB_TOKEN`, fixture configuration, GitHub CLI authentication, or signed-in browser session. Local/replay tests cannot substitute for that live gate.
