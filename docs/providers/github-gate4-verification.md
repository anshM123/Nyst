# GitHub Gate 4 adversarial verification

Status: PASS, 2026-08-07.

Gate 4 attacked only `github.repository_permission_change` and the affected Nyst core boundaries. It added no provider effect, provisioning, Stripe, UI, workflow, or Gate-5 work.

## Clean-room result

- Fresh database: `outcome_gate4_final_20260807`.
- Clean `npm ci`: 17 packages, zero vulnerabilities.
- Migrations `0001`–`0004` applied from zero.
- Strict typecheck and build passed.
- Complete suite: **221 passed, 0 failed, 0 skipped**, 50 suites.
- Deterministic GitHub-shaped property seeds: `4`, `44`, `404`, `65537`, `20260807`.
- Core property/stress seeds from Gate 2 remained green.
- The real fixture finished at exact role `read`; direct collaborator and invitation inventories matched their initial values.
- Live/local databases, gate logs, and production sources contained zero raw fine-grained-token or Bearer-token matches. Credential references remained non-secret.

## Real-provider response-loss canary

Fixture repository `nyst-ai-outcomes/nyst.ai` has stable repository ID `1327104635`; principal `chikookutti-cyber` has stable user ID `314422525`.

Final canary action: `b19aa205-c05b-438c-8a54-d2fd74004935`.

1. Pre-state independently observed as direct/effective `read` on the private repository.
2. GitHub processed one real `read -> write` mutation.
3. The transport deliberately discarded the response only after GitHub returned it.
4. Nyst crashed before reconciliation and restarted from the same PostgreSQL action and DispatchPlan.
5. Independent read-back observed exact effective `write`.
6. Resolution was signed `satisfied_unattributed`; control was `do_not_retry`, retry `forbidden`, continuation `allowed` for the exact goal.
7. Provider writes for that logical action: exactly one.
8. A separate controlled cleanup action restored `read` with one write.
9. Final external read confirmed `read`; collaborator inventory restored; invitation inventory unchanged.
10. Duration: 10.806 seconds. Evidence method: `provider_read_back`.

## Defects found and fixed

1. The live runner imported nonexistent source `.js` modules. It now consumes compiled production modules and has packaging regression coverage.
2. The Gate-4 runner instantiated a class before initialization. Declaration order and a load-order regression check were added; no provider call occurred in the failed attempts.
3. PostgreSQL allowed direct mutation of persisted action input/DispatchPlan/spec identity. Migration `0004_action_immutability.sql` makes intent, plan, spec, context, creation data, terminal deletion, and illegal lifecycle transitions database-rejected.
4. Rate-limited observations failed safely but discarded bounded scheduling semantics. Recognized 403/429 responses now produce `pending/hold`, retry/continuation blocked, and a 1–5 minute `next_check_at` using Retry-After, reset, then default precedence.
5. Invitation cleanup proof initially checked only the target relationship. Live canaries now compare complete bounded direct-collaborator and invitation inventories before and after.

## Absolute invariants

| Invariant | Executable proof |
| --- | --- |
| I1 Logical uniqueness | 2/10/100 commit tests, mixed concurrent collision, PostgreSQL unique identity |
| I2 Persist before consequence | memory and PostgreSQL transport-boundary inspection |
| I3 Stable provider operation | 16-boundary restart matrix plus migration-0004 direct attacks |
| I4 At-most-one unsafe dispatch | response-loss stress, concurrent commit, restart, live canary |
| I5 Response loss safe | deterministic and real post-consequence response discard |
| I6 HTTP response is not truth | 204-without-effect and malicious-204 specs |
| I7 404 is not blindly absence | visibility/auth/provider-status matrices |
| I8 Effective access matters | inherited removal and inherited downgrade tests |
| I9 Eventual consistency safe | old/old/new progression and seeded model sequences |
| I10 Evidence-bounded certainty | safety-floor, contradiction, malformed-read, property tests |
| I11 Evidence-bounded attribution | GitHub never emits verified; exact goal remains satisfied-unattributed |
| I12 Unsafe retry blocked | ambiguous transport/status/rate-limit matrices |
| I13 Unsafe continuation blocked | pending, unprovable, inherited, stale-auth matrices |
| I14 Stale retry rejected | retry/evidence sequence race and explicit stale-resolution test |
| I15 Stale continuation rejected | sequence-bound authorizeContinuation tests |
| I16 Restart safety | 16 GitHub-shaped plus 15 core crash boundaries |
| I17 Reconciliation idempotence | duplicate reads, ten concurrent reconcilers, no-write assertions |
| I18 EffectSpec cannot bypass core | malicious GitHub and core adapter suites |
| I19 Superseded evidence excluded | GitHub eventual snapshots and core supersession attacks |
| I20 Signed receipt integrity | live signature verification and material tamper suite |
| I21 Secrets protected | source/log/database scans and credential-reference assertions |
| I22 Provider fixture restored | final external read plus exact collaborator/invitation inventory comparison |

All primary standards finished at zero: unsafe retries, unsafe continuations, duplicate unsafe provider effects, false certainty, and raw credential leakage.
