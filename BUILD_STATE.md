# BUILD STATE

## Current status

**Nyst v0.2.1 full product-correctness release: PASS / RELEASED (2026-08-09). Gates 1–8 remain PASS / FROZEN.**

## v0.2.1 product-correctness verification evidence

- Canonical action presentation selects the newest durable resolution sequence and renders EffectState and ControlDecision as separate nested axes for all six effect states. Current proof cites only active, unsuperseded evidence referenced by the current resolution; complete audit history remains visible.
- Recovery, re-observation, policy deadlines, transition origins, scoped metrics, webhook state, EffectSpec readiness, integration preflight, API-key lifecycle, and onboarding progress are backed by persisted product state instead of cosmetic UI state.
- Failure Lab uses the real Nyst runtime with deterministic fake effects and no provider credentials. Shadow evaluation is EffectSpec-aware and never claims an external effect was prevented.
- Webhook delivery pins validated DNS addresses while retaining the original hostname for TLS/SNI, rejects unsafe A/AAAA results and redirects, bounds response size/time, signs stable event IDs, and retains immutable delivery history when disabled.
- Real-provider preflight is read-only. GitHub, Okta, and Stripe identity/scope checks do not mutate provider state; unavailable local credentials remain visibly blocked rather than falsely verified.
- The original supplied Nyst brand geometry is preserved in PNG mark, wordmark, domain-wordmark, and favicon assets.

Final clean-room database: `nyst_v021_release_20260809`, PostgreSQL 16.14 on loopback.

- `npm ci`: PASS, 69 packages installed / 70 audited.
- `npm audit`: **0 vulnerabilities**.
- Migrations from zero: PASS, `0001_init.sql` through `0009_product_correctness.sql`.
- Strict typecheck and build: PASS.
- Complete suite: **444 passed / 0 failed / 0 skipped** across **77 suites**, with PostgreSQL integration, direct-database attacks, property/model tests, concurrency stress, crash/restart recovery, signer failure, stale-decision, and malicious-adapter coverage executed.
- Chrome product verification: PASS at desktop and mobile (375 CSS-pixel content viewport); page `scrollWidth === clientWidth`, keyboard focus outline is 3px, webhook disable/restore retained 24 historical attempts, integration credential unavailability remained truthful, onboarding advanced only from persisted operations, API keys were revoked after testing, and policy creation required confirmation.
- Browser verification found one real asynchronous-control bug: the webhook enable/disable handler read `Event.currentTarget` after the confirmation callback began. The handler now captures the control, form, and desired state synchronously; a regression test was added and the corrected disable → restore flow passed.
- Preview-only API keys used for onboarding verification were revoked. Raw keys were shown once, never stored by Nyst, and were not added to source or Git.
- Real provider mutations performed for v0.2.1: **0**. Provider consequence semantics were unchanged; prior frozen live-provider evidence remains historical and the source repository was never used as a destructive fixture.
- Remaining documented boundaries: no managed-vault implementation is shipped; bundled credential sources resolve environment references only. Local software signing is not hardware-backed, local wall-clock time is not trusted, webhook delivery is at-least-once and consumers must deduplicate by event ID, and no Gate 9/billing/provisioning work was added.

Adversarial review covered duplicate dispatch, stale evidence/decisions, crash windows, unsafe defaults, provider-authority bypass, signing gaps, webhook DNS/redirect behavior, and MemoryStore/PostgresStore divergence. Twenty-four requested audit issue classes plus the independently discovered webhook test-isolation, SQL-join ambiguity, and asynchronous browser-control regressions were fixed or hardened with regression coverage.

## Historical v0.2.0 status

**Nyst v0.2.0 design-partner product: PASS / RELEASED (2026-08-09). Gates 1–8 remain PASS / FROZEN.**

## v0.2.0 design-partner release evidence

- The product path is `CONNECT → ROUTE → CONTROL → RECOVER → PROVE`; the seven-stage runtime and exactly six external EffectStates are unchanged.
- Shadow and Enforced are explicit modes. Shadow says “detected” and “would have blocked,” never “prevented.” Enforced actions receive immutable tenant, mode, and conservative policy-version bindings before provider preparation.
- Policies may require approval or reduce continuation/compensation authority. Retry remains `never` at the customer-policy layer and runtime safety floors remain non-bypassable.
- The Gateway SDK adds `actions.execute`, retrieval/reconciliation/receipt methods, and Shadow evaluation while preserving the v0.1 callable-actions surface.
- Signed decision webhooks use durable event IDs, HMAC verification, replay guidance, leases, bounded backoff, terminal attempts, redirect rejection, and configuration plus DNS-resolution SSRF defenses. Raw secrets remain environment references.
- Failure Lab is deterministic, explicitly simulated, credential-free, and restricted to Shadow/demo environments. Human review cannot force continuation, forge evidence, or mutate EffectState.
- Migration `0008_design_partner_product.sql` is additive and enforces action control binding, append-only mode audit, policies, webhooks, recovery, review, Failure Lab, and audit records in PostgreSQL.
- Production entry points provide structured logs, `/health`, database-backed `/ready`, graceful shutdown, and separate product/webhook-worker processes.

Final clean-room database: `nyst_v02_final_20260809`, PostgreSQL 16.14 on loopback.

- `npm ci`: PASS, 69 packages installed.
- Migrations from zero: PASS, `0001_init.sql` through `0008_design_partner_product.sql`.
- Strict typecheck and build: PASS.
- Complete suite: **410 passed / 0 failed / 0 skipped** across **73 suites**, with PostgreSQL integration executed.
- `npm audit`: **0 vulnerabilities**.
- Browser smoke: PASS in Chrome at desktop and 390×844; login, Overview, Failure Lab, and Settings rendered successfully.
- Secret scan: zero credential-pattern matches in the final PostgreSQL dump and zero real credential material in source. One tracked match is the explicit synthetic fixture in `tests/githubHelpers.ts`. `.secrets/` is ignored.
- No real provider mutation was performed because v0.2 did not change adapter semantics. The destructive fixture remains `nyst-ai-outcomes/nyst-permission-fixture`, never the source repository.
- Brand limitation: the referenced composite image was absent from the supplied attachment directory. The release preserves the existing Nyst mark/wordmark geometry as transparent SVG assets; pixel-faithful comparison to the unavailable reference was not independently possible.

Adversarial review found and fixed policy/mode binding gaps in legacy product-scoped recovery paths, a recovery SQL parameter type collision, unstable webhook payload event identity, shared-database webhook test coupling, and stale UI assertions. The final review found no new duplicate-dispatch path, stale-decision authority, provider-authority bypass, signing gap, unsafe default, or MemoryStore/PostgresStore semantic weakening.

There is no Gate 9. Gates 1–8 and their snapshot directories remain frozen. The active `Nyst.ai` tree is receiving only the bounded release-hardening changes authorized after the Gate-8 audit: real provider host routing, environment EffectSpec enforcement, pre-dispatch tenant ownership, current documentation/package identity, project/environment context switching, fixture separation, clean verification, and source publication.

Gate 1 remains preserved at `C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase1-frozen`.
The verified Gate-2 source/configuration snapshot is preserved at
`C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase2-frozen` (62 files, hash comparison: 0 mismatches).
The verified Gate-3 snapshot is preserved at
`C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase3-frozen` (77 files, hash comparison: 0 mismatches).
The verified Gate-4 snapshot is preserved at
`C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase4-frozen` (83 files, hash comparison: 0 mismatches; secrets and generated dependencies excluded).
The verified Gate-5 snapshot is preserved at
`C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase5-frozen` (100 files, SHA-256 comparison: 0 mismatches; `.git`, `.tools`, `.secrets`, `node_modules`, `dist`, and `.env` excluded).
The verified Gate-6 snapshot remains preserved and untouched at
`C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase6-frozen` (109 files, SHA-256 comparison: 0 mismatches; generated dependencies and secrets excluded).
The verified Gate-7 snapshot remains preserved and untouched at
`C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase7-frozen` (124 files, SHA-256 comparison: 0 mismatches; generated dependencies and secrets excluded).
The verified Gate-8 snapshot is preserved at
`C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase8-frozen` (139 files, SHA-256 comparison: 0 mismatches; `.git`, `.tools`, `.secrets`, `node_modules`, `dist`, `.env`, and logs excluded).

## Gate 3 implementation

- One production EffectSpec: `github.repository_permission_change`, version `1.0.0`.
- GitHub.com REST API is pinned to `2026-03-10` at a fixed `https://api.github.com` origin.
- Supported topology is deliberately narrow: private organization repository, active organization member, existing direct collaborator, standard exact roles only.
- Stable organization/repository/principal IDs and node IDs are captured before dispatch, persisted without secrets, and revalidated on every dispatch/observation.
- Exact `role_name` is authoritative for standard-role equality; `read`/`triage` and `write`/`maintain` are never collapsed. Custom roles and inconsistent base/role responses fail closed.
- A PUT that could invite a non-member/non-direct collaborator is rejected before consequence. An unexpected race-shaped `201` is recorded but never treated as access proof.
- Mutation responses are corroborative only. Independent permission/direct-relationship reads determine current effective goal truth.
- GitHub exposes no action-correlated permission read, so this spec intentionally never emits `verified`; exact goal presence is `satisfied_unattributed`.
- Removal is satisfied only when effective permission is `none` and the direct relationship is absent. Inherited access blocks offboarding continuation.
- Reconciliation never writes. Ambiguous writes, provider errors, stale authorization evidence, and open consistency windows forbid blind retry.
- A controlled retry is possible only after authoritative goal absence plus a durable definitely-not-sent boundary; otherwise the core clamps retry to forbidden.
- Compensation is unsupported. Continuation is sequence/evidence-bound and must be revalidated immediately before downstream consequence.
- Raw tokens are resolved only at request time from `env:NYST_GITHUB_TOKEN`; persisted artifacts retain only the credential reference.
- `scripts/verifyGitHubLive.ts` is a bounded reversible canary requiring two different non-none roles, preventing cleanup from creating an invitation.

## Runtime architecture

- `NystRuntime.commit(effect_name, business_key, input, context)` is the public commit entry point.
- Logical intent and the exact versioned `DispatchPlan` are durable before provider mutation.
- EffectSpecs are recovered by the version bound to the action. Missing historical versions fail closed.
- A durable runtime row serializes dispatch ownership. `claimed -> attempted` is the provider-consequence boundary: recovery may redispatch after a provably pre-send crash, but never after an attempted or ambiguous send.
- Initial dispatch plus at most one controlled retry reuse the same provider-operation identity.
- Guarded retry is atomically conditioned on both the current logical resolution sequence and the database-maintained evidence sequence. The evidence trigger and retry claim lock the same runtime row, closing the evidence-arrival/retry TOCTOU window.
- Reconciliation observes and appends; it never dispatches. Current resolution selection uses logical sequence, not wall-clock order.
- Provider event identity is deduplicated per action. Evidence and signed resolutions remain append-only.
- Continuation authorization revalidates the supplied resolution against current evidence. Compensation is a separate claimed operation and requires evidence of both the original attributed effect and the compensation.
- Runtime/provider behavior is deterministic under an injected clock. Tests retain the stateful fake adapter; Gate 3 adds the narrow production GitHub adapter described above.

## Phase 1 corrections retained

- Safety-floor substantive/transport calculations use active evidence only. Superseded substantive history cannot defeat a current transport-only ambiguity floor.
- The deterministic fake uses access-control semantics: repository, principal, desired permission, wrong permission, restoration/compensation, attribution, eventual consistency, absence, and transport ambiguity.
- Product documentation uses Nyst, the seven-stage runtime, access-first positioning, and the authorized gate order.

## Gate 2 hardening

- Contradictory active authoritative presence/absence and conflicting attribution fail closed to `unprovable`.
- Transport-only evidence never authorizes retry, and missing evidence never becomes `not_applied`.
- Retry budget exhaustion, stale retry/continuation decisions, unsupported compensation, inconsistent directives, malformed adapter output, provider observation failure, policy failure, and signer failure all fail closed.
- Terminal resolutions cannot retain a stale `next_check_at`; pending checks are deterministic from the injected clock.
- Runtime state, evidence, and resolution stores enforce action existence and duplicate rejection in both memory and PostgreSQL implementations.
- Signed receipts bind action identity, effect/control axes, cited evidence, policy/spec versions, logical resolution/evidence sequences, timestamps, and trust metadata.

## Latest local clean-room verification

Environment:

- Windows x64
- Node.js 24.16.0
- npm 11.13.0
- PostgreSQL 16.14, official EDB binaries, loopback-only test server with SCRAM authentication
- `pg` 8.16.3

Fresh final database: `outcome_gate5_cleanroom_20260808_1605`.

- Test service stopped and restarted before verification: passed
- `npm ci`: passed; 17 packages installed, 0 vulnerabilities
- `npm run migrate`: passed from migration zero (`0001_init.sql` through `0004_action_immutability.sql`)
- `npm run typecheck`: passed under strict TypeScript settings
- `npm run build`: passed
- Full `npm test` with `DATABASE_URL`: **305 passed / 0 failed / 0 skipped** across **59 suites** (2026-08-08 post-DPoP nonce-safety regression run)
- Gate-3 focused GitHub contract/runtime/evidence/packaging suite: **24 passed / 0 failed** before the final clean-room run.
- GitHub/PostgreSQL integration: **3 passed / 0 failed**, covering exact pre-write durability, 10-way GitHub-shaped contention, and crash-after-mutation restart recovery without redispatch.
- Existing PostgreSQL integration remains green, including 2/10/100-way core contention, collision, direct DB constraints, and atomic evidence-arrival/retry serialization.
- Gate-5 focused Okta suite: **80 passed / 0 failed / 0 skipped** across **7 suites**.
- Okta/PostgreSQL integration: **3 passed / 0 failed**, covering exact pre-write durability, ten-way contention plus crash/restart recovery, and direct immutable-identity/plan attacks.
- No lint script is configured; no lint result is claimed

Deterministic adversarial coverage includes:

- Fifteen injected crash boundaries from intent persistence through signed-resolution persistence
- Response loss after effect, provider throw after mutation, observation outage, eventual consistency, wrong parameters, goal-state preexistence, contradiction, supersession, and duplicate events
- Recovery/reconciliation contention, including ten concurrent reconcilers and repeated 100-way commit stress
- Property/model seeds `1`, `7`, `42`, `2026`, `65537`; concurrency/fault seeds `101`, `202`, `303`
- Backward wall-clock movement, stale retry/continuation decisions, retry/evidence TOCTOU, retry budget exhaustion, version pinning/missing versions, malformed states, policy/signing failures, and ambiguous compensation
- MemoryStore/PostgresStore schema and behavior parity checks

## Direct PostgreSQL attack results

All direct attacks were rejected by PostgreSQL, independently of application validation:

- Evidence UPDATE/DELETE: append-only trigger
- Resolution UPDATE/DELETE: append-only trigger
- Cross-action evidence supersession: `outcome_evidence_supersedes_same_action_fk`
- Seventh effect state: `outcome_resolutions_effect_state_check`
- Invalid control directive: `outcome_resolutions_primary_directive_check`
- Dispatching without a persisted plan: `outcome_actions_dispatch_needs_plan`
- Duplicate logical identity: `outcome_actions_identity_uq`
- Invalid runtime dispatch status: `outcome_runtime_dispatch_status_check`
- Claimed status without a claim token: `outcome_runtime_claim_consistency`

## Gate 3 live verification

Dedicated private fixture: `nyst-ai-outcomes/nyst.ai`; repository ID `1327104635`; principal `chikookutti-cyber`, user ID `314422525`.

- Live preflight established repository visibility/private status, stable repository and principal identities, active organization membership, direct collaboration, exact standard starting role `read`, and sufficient least-privilege read/write scope.
- Two independent reversible runs completed `read -> write -> read`; each run performed exactly two GitHub writes.
- Independent provider reads established both the changed role and restored role. Nyst emitted truthful `satisfied_unattributed` resolutions and both signatures verified.
- Final role was independently confirmed as `read`; direct collaborator inventory was restored exactly; repository invitation inventory was unchanged.
- Live database and gate logs contained zero raw `github_pat_` or Bearer-token matches. Only `env:NYST_GITHUB_TOKEN` credential references were persisted.
- The token was held only in the dedicated interactive PowerShell process environment, was never printed or passed on a command line, and was cleared by stopping that process after the final live check.

## Gate 4 adversarial verification

- Deterministic transport faults covered proven-before-send, ambiguous send/reset/timeout, real-shaped 401/403/404/409/422/429/500/502/503 behavior through the provider/core matrices, malformed reads, delay, stale reads, response loss after effect, and read outages.
- Sixteen GitHub-shaped runtime crash points plus all retained Gate-2 crash points recovered from the same action/plan with at most one provider write.
- Database-after-effect and signer-after-effect failures preserved evidence and recovered without redispatch.
- 2/10/100 concurrency, concurrent semantic collision, retry/evidence race, stale retry, stale continuation, inherited removal/downgrade, eventual consistency, duplicate/contradictory/superseded evidence, malicious specs, and seeded model/stress sequences remained safe.
- Migration `0004_action_immutability.sql` rejects direct DispatchPlan/input/spec/context identity rewrites, action deletion, and illegal persisted lifecycle transitions. Runtime claimant consistency and all prior direct DB attacks remain enforced.
- Final live response-loss action `b19aa205-c05b-438c-8a54-d2fd74004935` performed one real write, discarded the response after GitHub consequence, restarted, reconciled to signed `satisfied_unattributed`, and restored the fixture to `read` with unchanged collaborator/invitation inventories.
- Final secret scan: zero raw credential matches in production source, live/local databases, or gate logs; non-secret credential references persisted as designed.
- Full invariant mapping and defect record: `docs/providers/github-gate4-verification.md`.

## Gate 5 local implementation

- One production EffectSpec: `okta.user_suspension_change`, version `1.0.0`.
- Exact supported state goals are `active` and `suspended`. Legal mutations are `ACTIVE -> SUSPENDED` with `POST /api/v1/users/{id}/lifecycle/suspend` and `SUSPENDED -> ACTIVE` with `POST /api/v1/users/{id}/lifecycle/unsuspend`; `GET /api/v1/users/{id}` is authoritative current-state read-back.
- Scope is deliberately narrow: default `https://integrator-<digits>.okta.com` origin, existing stable user ID, Okta-sourced synthetic user, no admin-role assignments, no in-progress transition, and no custom domains/preview/EMEA/trial/arbitrary origins.
- Current documented unsupported statuses `STAGED`, `PROVISIONED`, `RECOVERY`, `PASSWORD_EXPIRED`, `LOCKED_OUT`, and `DEPROVISIONED`, plus unknown future strings, perform zero lifecycle writes and fail closed. Gate 5 does not create, activate, deactivate, delete, unlock, recover, provision, assign groups/apps, or manipulate passwords/MFA.
- Modern authentication design is an OAuth 2.0 API Services app using Client Credentials and `private_key_jwt`. Current lifecycle endpoints require OAuth scope `okta.users.manage`; `okta.roles.read` supports the fixture admin-role check. A custom admin role should constrain the app to user read plus only lifecycle suspend/unsuspend permissions and the required read-only role visibility. Org-authorization-server access tokens last one hour.
- Production requests resolve a short-lived access token only at call time from `env:NYST_OKTA_ACCESS_TOKEN`. Bearer tokens remain supported. DPoP-bound tokens additionally require an in-memory/process-environment DPoP signing key and create a fresh RFC 9449 proof bound to method, target URL, and access-token hash for every request; the proof header contains only the public JWK. Tokens, private keys, client assertions, Authorization/DPoP headers, and raw credential payloads are excluded from action input, DispatchPlan, evidence, resolutions, logs, errors, and Git.
- Stable identity is canonical tenant host plus Okta user ID. Login/email are corroborative mutable metadata and cannot redirect a persisted action.
- Lifecycle operations are officially non-idempotent. Ambiguous/may-have-been-sent dispatch never authorizes blind retry. One controlled retry is possible only after a durable definitely-not-sent boundary, authoritative current goal absence, and a current guarded decision.
- Mutation responses are corroborative only. Independent exact-ID read-back controls current truth. Version 1.0.0 does not request System Log scope or establish robust action correlation, so `verified` is intentionally unreachable; exact goal presence is `satisfied_unattributed`.
- Continuation is allowed only for the exact independently observed current status and is sequence/evidence-bound. The downstream-operation atomicity boundary remains unchanged from Gate 4.
- Observation `429` persists a provider-informed `next_check_at` using `Retry-After`, reset, then deterministic default precedence with a one-to-five-minute clamp. No production scheduler/worker executes that hint.
- The HTTP client enforces fixed encoded paths, HTTPS allowlisted origin, no URL credentials/port/path/query/fragment, redirect rejection, bounded timeout/body, allowlisted headers, safe errors, and no raw response/error persistence.
- `scripts/verifyOktaGate5Live.ts` packages the bounded normal and response-loss canaries plus restoration protection. Both bounded canaries executed successfully against the disposable Okta fixture.
- Current official provider research and full semantic design: `docs/providers/okta-user-suspension.md`.

### Gate 5 local adversarial evidence

- Transition/preexistence, unsupported-status, success-without-effect, response-loss, definitely-not-sent, may-have-been-sent, 400/401/403/404/429/500/502/503, malformed/missing/wrong-identity/transitional reads, stale reads, eventual progression, login change, rate-limit scheduling, and observation outage matrices are green.
- Sixteen runtime crash points, DB-failure-after-effect, signer-failure-after-effect, recovery/reconciliation contention, 2/10/100 duplicate commit, concurrent opposite-goal collision, stale retry, stale continuation, version pinning, malicious EffectSpec, receipt tampering, and observation deduplication are green.
- Deterministic property seeds: `5`, `17`, `42`, `2026`, `65537`; each executed 20 generated fault scenarios. Stress repeated response-loss recovery 25 times with ten concurrent reconcilers, always with one lifecycle write per logical action.
- Direct PostgreSQL attacks attempting tenant, user ID, desired status, operation, credential reference, spec version, and action deletion rewrites were rejected by migration `0004_action_immutability.sql`; no forward schema migration was required.
- Final clean-room run restarted PostgreSQL, ran `npm ci` (17 packages, 0 vulnerabilities), migrated from zero through `0004_action_immutability.sql`, and passed strict typecheck, build, and the complete **305-test / 59-suite** suite with PostgreSQL active.
- Secret scans found zero raw Okta credential material in the workspace, PowerShell history, or clean-room PostgreSQL dump. The temporary JWK was securely deleted, `.secrets/` remains ignored, and the token-bearing credential host was stopped after live verification.

### Gate 5 defects found and fixed

1. Explicit default port `:443` was normalized away before the no-port policy could reject it. Raw canonical-origin validation now rejects every explicit port, with regression coverage.
2. Observe-only/preexisting goals were incorrectly labeled definitely-not-sent, allowing a newer dispatch-boundary record to invalidate otherwise current exact-goal evidence. They now truthfully record a completed observation path without a lifecycle write.
3. Malformed or oversized POST responses could be classified definitely-not-sent after the provider consequence. POST response-contract failures now become `may_have_been_sent`; direct malformed/oversized transport tests enforce the boundary.
4. The live runner initially used a TypeScript parameter property unsupported by Node's strip-types execution mode. Packaging was corrected and the runner now loads to its required environment check.
5. The live Okta service app requires DPoP-bound access tokens, while the adapter supported Bearer authorization only. Okta returned `invalid_dpop_proof` before token issuance. The credential flow now uses a separate ephemeral proof key and the adapter generates per-request signed proofs. A regression test verifies the proof signature, public-only JWK header, method/URL binding, and `ath` token hash.
6. Okta requires DPoP nonces at both authorization-server and management-resource boundaries. The adapter now caches safe nonces per tenant, allows only one exact `401 use_dpop_nonce` retry for a read, carries the next nonce into the lifecycle request, and never automatically resends a lifecycle POST. Regression tests prove bounded read negotiation and a maximum of one POST when a write receives a nonce challenge. The complete suite is **305/305** across **59 suites**.

### Gate 5 live verification

- Org authorization-server discovery: passed for `https://integrator-5013236.okta.com`; exact token endpoint confirmed.
- Replacement RSA private JWK structure and registered-key authentication: passed without printing or persisting private parameters in the source tree.
- OAuth client-credentials exchange: passed with exactly `okta.users.manage okta.roles.read`, DPoP nonce negotiation, and a 3600-second token.
- The authorization blocker was fixture configuration, not product code: the custom role already had the intended permissions, but its resource set used a Groups resource instead of the required Users resource. The saved least-privilege topology is now `Users -> Nyst Gate 5 Fixture Users` plus `All Identity and Access Management resources`; the obsolete Groups resource was removed. OAuth scopes remained exactly `okta.users.manage okta.roles.read`, and no Super Admin grant was added.
- Fresh authenticated preflight confirmed tenant `integrator-5013236.okta.com`, exact user ID `00u165mdigjjALY0c698`, login `nyst-fixture@gmail.com`, Okta source, `ACTIVE` state, no transition, and no individual or group-derived administrator assignment.
- Normal live canary passed `ACTIVE -> SUSPENDED -> ACTIVE`. Each effect was independently observed, reconciled to the strongest truthful state, signed, and signature-verified.
- Response-loss canary passed `ACTIVE -> SUSPENDED(response_lost) -> restart/reconcile -> ACTIVE`. The ambiguous logical action performed exactly one suspend write, never redispatched, and produced the strongest truthful signed resolution after independent observation.
- Total controlled lifecycle writes across both canaries and their separate restorations: **4**. Maximum provider writes for the ambiguous logical action: **1**.
- Final provider state was independently confirmed `ACTIVE`; no unsupported fixture condition or unintended privilege remained.
- Credential hygiene: the JWK never entered source, logs, evidence, receipts, Git, command history, or the clean-room database; the temporary file was deleted and the token-bearing process was stopped.

## Gate order

1. Gate 1 — foundation (frozen and preserved)
2. Gate 2 — durable commit/dispatch/observe/reconcile runtime with deterministic fake providers (complete and frozen)
3. Gate 3 — GitHub repository permission change, first real provider (complete and frozen)
4. Gate 4 — real-provider adversarial fault gauntlet (complete and frozen)
5. Gate 5 — Okta user suspension control (complete and frozen)
6. Gate 6 — integrated Okta/GitHub offboarding demo (complete and frozen)
7. Gate 7 — Stripe refund and payment capture (complete and frozen)
8. Gate 8 — productization and real Nyst UI (complete and frozen)

## Gate 7 local implementation and verification

- Two and only two production Stripe EffectSpecs exist: `stripe.refund/1.0.0` and `stripe.payment_capture/1.0.0`.
- Stripe REST requests are restricted to `https://api.stripe.com`, pin `Stripe-Version: 2026-02-25.clover`, reject redirects, bound request duration and response size, and accept only test or restricted-test key prefixes. Live-mode objects and live-key prefixes fail closed.
- The supported refund is exactly one full refund of an already-succeeded sandbox PaymentIntent/latest Charge with no partial or duplicate refund topology. The supported capture is exactly one final full capture of a manual sandbox card PaymentIntent whose full amount remains capturable.
- Stable Account, PaymentIntent, and Charge identities plus exact amount/currency form the semantic identity. Those values, the operation, API version, credential reference, and action-derived idempotency key are immutable and durable before consequence.
- Provider mutation responses are corroborative only. Independent Account, PaymentIntent, Charge, and bounded Refund-list reads determine truth. Matching `nyst_action_id` metadata may establish `verified`; exact preexisting state remains `satisfied_unattributed`.
- Financial v1 never authorizes automatic retry, including when the original request is provably not sent. Ambiguity, rate limits, provider failures, pending state, stale decisions, partial/multiple topology, and inconsistent state remain hold/escalation paths with continuation blocked.
- Focused Gate-7 suite: **38 passed / 0 failed / 0 skipped** across **5 suites**, including both PostgreSQL financial-effect integration cases and direct database attacks.
- Final fresh database `outcome_gate7_cleanroom_20260808` applied migrations `0001_init.sql` through `0005_offboarding_runs.sql`; strict typecheck and build passed; the complete Gate 1–7 suite passed **369 / 369 tests** across **68 suites**, with **0 failures and 0 skips**.
- Dependency audit reports 17 packages and 0 vulnerabilities. Secret scans found zero raw Stripe credential material in PowerShell history or the clean-room database; source matches are explicit fake negative-test fixtures only. `.secrets/` is ignored and no Stripe secret file currently exists.
- Live runner packaging is green and includes normal plus response-loss canaries for both effects, one-write counters, signature verification, and protected sandbox cleanup.
- All Gate-7 local and live exit conditions passed. Gate 8 had not started at the instant this frozen checkpoint was created.
- Official semantic research: `docs/providers/stripe-gate7-research.md`. Exact local evidence and live exit requirements: `docs/providers/stripe-gate7-verification.md`. Honest competitive comparison: `docs/postcept-comparison.md`.

### Gate 7 live verification and final exit evidence

- Final live run ID: `fff0ef58-f9a7-4b36-a919-2c60731855e2`; test account ID `acct_1U2IefD3DgCKEZvH`; Stripe API version `2026-02-25.clover`.
- Normal refund, response-loss refund, normal capture, and response-loss capture each performed exactly one target provider write, independently read back the exact attributed goal, produced `verified`, forbade retry, and passed Ed25519 receipt verification.
- Both ambiguous logical actions recovered from the persisted PostgreSQL action and DispatchPlan without redispatch. Maximum target provider writes per logical action was **1**; unsafe retries, duplicate financial effects, and false certainty were all **0**.
- Cleanup independently confirmed all four final live PaymentIntents were `succeeded` and fully refunded. Earlier diagnostic attempts were also safely canceled or fully refunded; no uncaptured authorization or unrefunded succeeded fixture was left behind.
- Product defect found live: the capture request explicitly sent `final_capture=true`. Current Stripe accepts that explicit parameter only when multicapture is available, while full capture already defaults to final. The adapter now omits the multicapture-only field and a regression test asserts the exact request contract.
- Live-runner defect found live: immediate independent capture reads can lag a successful mutation. The runner now preserves truthful `pending` and performs a bounded read-only reconcile loop without redispatch.
- Final fresh database `outcome_gate7_final_20260808` applied migrations `0001`–`0005` from zero after all fixes. `npm ci` installed 17 packages with 0 vulnerabilities; strict typecheck and build passed; the complete Gate 1–7 suite passed **370 / 370 tests** across **68 suites**, with **0 failures and 0 skips**.
- Final secret scans found zero raw Stripe credential material in PowerShell history, the live clean-room database, or the final clean-room database. Workspace token-shaped matches are explicit fake test fixtures only. The ignored credential file was deleted and the runner process environment was cleared.
- Gate 7 verdict: **PASS / FROZEN**. Frozen snapshot: `C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase7-frozen`.

## Explicit boundaries and remaining risks

- The product API, dashboard, authentication, and scheduler now exist, but the reference host remains loopback-only and is not a managed deployment. Billing, webhook ingestion, and a managed production secret vault remain out of scope.
- Historical Gate-8 boundary: the frozen Gate-8 reference host enabled only the deterministic fake effect. The active release-hardened host now registers the four frozen real EffectSpecs and routes them only when the current environment enables the exact version and has its required opaque integration reference. Fake behavior is explicit non-production opt-in and never a fallback.
- Rate-limit responses fail closed and cannot cause redispatch. The durable scheduler now executes bounded read-only reconciliation from `next_check_at`, claims work with PostgreSQL leases, preserves failure backoff, and never owns a provider mutation path.
- `authorizeContinuation` remains available for internal guarded boundaries. The public product adds a 30-second, one-use lease bound to the current resolution and evidence sequences and atomically rechecks them at consumption. External state can still change after consumption; Nyst does not claim impossible distributed atomicity with an arbitrary later consequence.
- Local software signing proves tamper evidence, not hardware-backed attestation.
- Local system clock remains explicitly untrusted.
- Evidence records are ledger-hashed but not individually signed; signed resolutions cover cited evidence identities and derived claims.
- The workspace-local PostgreSQL instance and its password are test-only, loopback-only, and ignored by Git; they are not production configuration.
- Gate 5 deliberately cannot emit action-attributed `verified` without System Log correlation; exact goal presence is truthfully `satisfied_unattributed`. This is a supported epistemic limitation, not a failed canary.
- The custom role remains least privilege with `okta.users.read`, `okta.iam.read`, `okta.users.lifecycle.suspend`, and `okta.users.lifecycle.unsuspend`. Its corrected resource binding scopes the lifecycle permissions to the disposable fixture user and retains only the required IAM visibility; this topology must not be broadened casually.

## Gate 8 implementation and final verification

- Migration `0006_product_control_plane.sql` adds the minimal product model for organizations, users, projects, environments, opaque integration references, environment EffectSpec availability, immutable action/offboarding scopes, hash-only sessions/API keys, durable reconciliation jobs, and continuation leases.
- The versioned API supports action commit/list/detail/evidence/resolutions/receipt, explicit read-only reconciliation, EffectSpecs, integration status/configuration, offboarding-run inspection, scoped metrics, API-key lifecycle, and sequence-bound continuation leases. HTML pages require a browser session; API keys are separately scoped and cannot substitute for dashboard authentication.
- Passwords use `bcryptjs` cost 12. Sessions and API keys are high-entropy opaque values stored only as SHA-256 digests; API keys are shown once, project/environment scoped, expirable, replaceable for rotation, and revocable. Provider integrations accept only `env:`, `vault:`, or `secret-manager:` references in application validation and PostgreSQL constraints.
- The TypeScript SDK sends credentials only in `Authorization`, never in URLs or payloads, and performs no automatic retry. The dashboard renders real PostgreSQL/runtime data for overview metrics, filtered actions, the seven-stage action lifecycle, append-only evidence, signature-verified/downloadable receipts, EffectSpecs, integrations, the Gate-6 offboarding explanation and scoped runs, and project settings.
- `NystReconciliationScheduler` uses durable jobs, `FOR UPDATE SKIP LOCKED`, leases, restart-safe claims, terminal/stale no-ops, a minimum next-due clamp, preserved bounded failure backoff, and reconciliation only. Deterministic overlapping-worker coverage proves one live lease owner and zero mutation redispatch.
- Public continuation authorization is a 30-second one-use lease bound to action, resolution ID, resolution sequence, and evidence sequence. Cross-tenant, consumed, expired, and stale-evidence leases fail closed.

### Gate 8 defects found and fixed

1. Tenant namespacing initially leaked into product-facing business keys; immutable display keys now remain separate while runtime logical identity stays tenant-namespaced.
2. Overview retry/ambiguity metrics initially counted directives rather than evidence-backed ambiguous actions; the query now derives them from transport evidence plus current resolution state.
3. The offboarding product query referenced fields that do not exist in the frozen Gate-6 ledger; status and blocking reason are now derived from current linked resolutions without mutating Gate 6.
4. Scheduler synchronization could overwrite a later failure backoff with an earlier runtime hint; synchronization now preserves the later due time, with a regression test.
5. Integration persistence initially blocked only recognizable token prefixes at the database layer; PostgreSQL now independently requires an allowed opaque reference scheme.
6. Malformed action filters could become internal errors; bounds, dates, and limits now receive explicit 400 validation.
7. The receipt UI initially showed signature presence but not verification or export; it now independently displays `VALID`/`INVALID` and provides an authenticated JSON download.
8. API-key scope checks were initially incomplete on read endpoints and HTML pages; exact read scopes are now enforced and dashboard pages require a session.
9. The mobile grid allowed an 850px table to force page-level overflow; the grid item now shrinks correctly while the table remains inside its own scroll container.

### Gate 8 clean-room and security evidence

- Final database `outcome_gate8_final3_20260808` was created from zero and applied migrations `0001_init.sql` through `0006_product_control_plane.sql`.
- `npm ci` installed 69 packages and audited 70 packages with **0 vulnerabilities**. Strict typecheck and build passed.
- The complete Gate 1–8 suite passed **381 / 381 tests** across **70 suites**, with **0 failures, 0 skips, and 0 cancellations**. PostgreSQL integration, 2/10/100 contention, property/model seeds, stress, crash/restart, malicious-adapter, signer/DB failure, direct database attacks, scheduler, auth, tenant isolation, API, and SDK tests all executed.
- Direct tenant attacks covered cross-organization action/evidence/receipt/integration/API-key access, guessed IDs, immutable scope rewrites/deletion, API-key scope escalation, raw credential insertion, stale continuation, and concurrent scheduler ownership.
- Security coverage includes CSRF, HttpOnly/SameSite sessions, production Secure-cookie configuration, restrictive CSP, frame denial, bounded 64 KiB bodies, rate limits, opaque errors/request IDs, parameterized SQL injection probes, HTML escaping/XSS probes, path/UUID validation, recursive secret redaction, credential-reference validation, receipt tamper verification, and API-key leakage checks.
- Final scans found **0 raw provider credential matches** in product source, workspace logs/artifacts, PowerShell history, the final PostgreSQL dump, `.secrets/`, or `.env` files. `.secrets/` remains ignored. Bundled PostgreSQL/pgAdmin vendor source was excluded from workspace-artifact results and is excluded from frozen snapshots.
- Chrome tested the actual local product: login; real overview metrics; filtered action ledger; `pending`, `satisfied_unattributed`, `unprovable`, and `verified` rendering; action/evidence lifecycle; valid and invalid signature states; JSON receipt download; EffectSpecs; integration status; offboarding explanation and honest empty state; settings; keyboard tab order; and a 390×844 responsive viewport. The final measured page width was 375px with no page-level horizontal overflow; the 850px table scrolled only inside its 337px container.
- Gate 8 made no new live-provider mutation. GitHub/Okta credentials were intentionally cleared after Gate 6 and Stripe credentials after Gate 7, so Gate 8 relies on the preserved bounded live proofs from Gates 3–7 rather than requesting secrets or inflating provider writes.
- Gate 8 verdict: **PASS / FROZEN**. Frozen snapshot: `C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase8-frozen`.

## Gate 6 implementation and verification

- `OffboardingRun` is a narrow immutable coordinator identity linking independent Okta and GitHub Nyst actions; it does not add an EffectState or general workflow vocabulary.
- Overall completion is derived only when both current, signed provider resolutions establish the exact goals and independently allow continuation. Pending, unprovable, stale, unsigned, inherited-access, and provider-unavailable cases remain blocked.
- The downstream GitHub dispatch claim atomically locks and validates the exact Okta source action, resolution ID, resolution sequence, evidence sequence, and allowed continuation. Stale authorization leaves the GitHub action at `not_started` with zero writes.
- Migration `0005_offboarding_runs.sql` persists immutable run intent and one-time immutable action links with unique business and subject identities.
- The minimal HTML demo renders actual coordinator/runtime data for Intent, Execution, Observation, Reconciliation, EffectState, ControlDecision, evidence strength, and signed-receipt status. Dynamic fixture content is HTML-escaped and credentials are never included.
- Required scenarios cover clean execution; response loss and post-effect crashes for each provider; each observation outage; Okta remaining active; inherited GitHub access; stale continuation; duplicate/concurrent/conflicting requests; restart between and after providers; one/both preexisting goals; rate limits; signer failure; and database failure after consequence.
- Gate 6 focused deterministic suite: **20 passed / 0 failed**. Gate 6 PostgreSQL suite: **3 passed / 0 failed**, including ten-way contention, immutable-run direct attacks, and atomic stale-continuation rejection. Two additional GitHub live-shape regressions cover null/empty post-removal `role_name` observations.
- Final clean-room verification created a fresh PostgreSQL database, ran `npm ci` (17 packages, 0 vulnerabilities), migrated from zero through `0005_offboarding_runs.sql`, passed strict typecheck and build, and passed the complete Gate 1–6 suite: **331 passed / 0 failed / 0 skipped** across **62 suites**. PostgreSQL integration, property/model, stress, malicious-adapter, and direct database attack suites executed.
- Real defects found and fixed: (1) a concurrent recovery request could steal another still-live runtime instance's pre-consequence dispatch claim and manufacture a false not-sent boundary; live dispatch ownership is now tracked and ten-way contention is regression-covered in memory and PostgreSQL; (2) GitHub's valid/transitional post-removal permission response may use a null or empty `role_name`; exact absence is normalized to `none`, while a granted permission without an exact role is preserved as `unknown`, blocks continuation, cannot satisfy a goal, and remains rejected at preflight.
- Live-runner defects fixed before proof: production credential-source imports were corrected; the offboarding subject key was changed to schema-safe punctuation; consistency waiting was bound to the immutable action deadline; inherited-access diagnostics were added; and runner failure no longer destroyed the credential host before fixture repair.
- `scripts/verifyGate6Live.ts` performs one bounded integrated real-provider run, verifies both signed provider receipts and independent goal reads, and restores Okta to `ACTIVE` plus GitHub to direct `read` while requiring unchanged invitation inventory.
- Live fixture diagnosis found the organization-wide GitHub base permission was actually `Read`, despite the intended `No permission` topology. The signed-in organization setting was corrected to `No permission`; the principal remained an active member with zero active team access and direct `Read` was restored before the final canary.
- Final bounded integrated live run `634f8909-dc39-449c-8ad6-428c897b89d4` passed: one Okta suspension and one GitHub collaborator removal, independent provider observations, `satisfied_unattributed` for both effects, valid signed receipts, **0 unsafe continuations**, **0 duplicate unsafe writes**, and **0 false completions**.
- Cleanup independently confirmed Okta `ACTIVE`, GitHub direct `read`, and unchanged invitation inventory. The live credential host was stopped, its process environment cleared, and the temporary JWK file remains absent.
- Final secret scan found zero private-key or Okta-token patterns in source, PowerShell history, or the clean-room PostgreSQL dump. The sole GitHub-token-shaped source value is the explicit fake `TEST_GITHUB_TOKEN` regression fixture; no live token was persisted.
- Gate 6 verdict: **PASS / FROZEN**. Frozen snapshot: `C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase6-frozen`.

## Post-freeze documentation correction

On 2026-08-07, the current working copy received a documentation-only correction after the Gate-4 snapshot was frozen. The correction distinguishes the already-verified persistence of bounded provider-informed `next_check_at` hints from the still-absent production scheduler/worker that would execute reconciliation at those times. It also reconciles stale Gate-2/Gate-3 status wording in current product documentation. No production or test behavior changed, and `Nyst.ai-phase4-frozen` remains untouched as the historical Gate-4 evidence.

## Post-Gate-8 release hardening (2026-08-09)

- Verdict: **PASS** for the bounded local release-hardening work. This is not Gate 9 and does not alter the Gate 1-8 frozen snapshots.
- The product host now deterministically routes the four frozen real EffectSpecs (`github.repository_permission_change`, `okta.user_suspension_change`, `stripe.refund`, and `stripe.payment_capture`) through their existing provider services. It resolves credentials at dispatch time from the configured environment reference, persists only opaque references, rejects missing or unsupported references, and never falls back from a real provider to the deterministic fake.
- Environment EffectSpec configuration is now enforced at both listing and commit boundaries. The current environment must enable the exact registered version and have the exact required integration reference. Existing actions remain bound to the version and provider identity persisted with the action, so later environment configuration cannot reinterpret historical work.
- Migration `0007_release_hardening.sql` makes organization/project/environment ownership durable before dispatch eligibility and independently prevents a namespaced action from entering `prepared` without its matching ownership row. Recovery of an unscoped P1 orphan is limited to its business-key environment; another tenant cannot adopt it.
- Browser sessions now persist selected organization/project/environment context. The product shell provides a minimal project/environment selector; actions, metrics, integrations, EffectSpecs, offboarding data, and settings use the selected context. Cross-organization project and environment guesses return 404.
- The public package identity is `@nyst-ai/sdk`. Current user-facing examples and product documentation use Nyst; legacy `Outcome*` type and `outcome_*` table names remain internal implementation history.
- Release regression coverage adds eleven PostgreSQL cases for all four public-API provider routes, environment enablement/version/integration/ref failures, historical reconciliation, context switching and IDOR, P1 orphan adoption, and P2-P5 dispatch boundaries. A production-host regression also proves the development fake is refused.
- Legitimate defects found during adversarial review and fixed: (1) an unscoped orphan could initially be adopted by a different environment; adoption now requires the immutable environment-prefixed business key, with a regression test; (2) integration/EffectSpec upserts could target a conflicting row without an explicit same-scope guard; application prevalidation and guarded PostgreSQL conflict updates now fail closed; (3) the product display-business-key limit did not account for the runtime's environment UUID namespace, and is now bounded before reaching the core identity limit.
- No frozen provider adapter semantics changed, so this pass did not perform new real-provider mutations. Frozen Gates 3-7 live evidence remains the applicable provider proof; release tests exercised the product routing with deterministic provider-shaped clients.
- Clean-room database `nyst_release_final_20260809` was created from zero and applied migrations `0001_init.sql` through `0007_release_hardening.sql`. `npm ci` audited 70 packages with **0 vulnerabilities**; strict typecheck and build passed.
- The complete suite passed **393 / 393 tests** across **71 suites**, with **0 failures, 0 skips, 0 cancellations, and 0 todos**. PostgreSQL integration/direct attacks, 2/10/100 contention, property/model seeds, crash/restart, signer/database faults, scheduler workers, auth, API/SDK, tenant isolation, project/environment switching, EffectSpec enablement, provider routing, scope-before-consequence, receipt/evidence, and security tests all executed.
- Chrome rechecked the actual local product at desktop and 390x844 responsive layouts. Project/environment switching persisted and updated environment-scoped data; measured document width remained within the viewport with no page-level horizontal overflow.
- Future destructive GitHub permission tests now target the empty private repository `nyst-ai-outcomes/nyst-permission-fixture`, not the source repository. GitHub independently showed organization base role `None`, zero organization/team access, and direct `read` access for the active organization member `chikookutti-cyber`. Historical records retain the repository actually used at each frozen gate.
- Candidate-source scans found no raw provider credential, private key, credential artifact, local database, dump, log, `.env`, or `.secrets` file. The only token-shaped matches are explicit synthetic negative-test fixtures in security tests.
- Remaining deployment boundaries: the reference product host remains loopback-oriented; production secret-vault integration, managed deployment, billing, and webhook ingestion remain out of scope. Local software signing is not hardware-backed, and local wall-clock time is not trusted.
