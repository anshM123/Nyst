# Gate 6 integrated offboarding verification

Gate 6 implements one deliberate demonstration: suspend a disposable Okta user, establish the strongest truthful Nyst resolution, then remove a disposable principal's GitHub repository access only through a current continuation authorization.

It is not a workflow engine. `OffboardingRun` stores immutable subject/fixture intent and links to two ordinary Nyst actions. Each provider retains its own EffectState, ControlDecision, evidence, and signed receipt. Overall `complete` is a derived demo status, not an external EffectState.

## Continuation boundary

The GitHub action and DispatchPlan are persisted before consequence. Its dispatch claim can be acquired only while the exact Okta source action still has the expected resolution ID, resolution sequence, evidence sequence, and `continuation: allowed`. PostgreSQL locks the source runtime row in the same statement that claims downstream dispatch ownership; evidence insertion updates that same row, serializing stale evidence against the claim.

This closes the previously documented check-then-dispatch gap for this narrow integrated path without claiming impossible atomicity across Okta, Nyst's database, and GitHub.

## Deterministic and PostgreSQL evidence

- Gate 6 focused scenarios: 20 passed, 0 failed.
- Gate 6 PostgreSQL scenarios: 3 passed, 0 failed.
- Final clean-room Gate 1–6 PostgreSQL suite: 331 passed, 0 failed, 0 skipped, 62 suites.
- Fresh migration path: `0001_init.sql` through `0005_offboarding_runs.sql`.
- Ten concurrent identical runs: one run identity, one Okta write, one GitHub write.
- Stale continuation: zero downstream writes; target remains `not_started`.
- Direct database rewrites/deletion of run identity or action links: rejected.

The matrix covers clean offboarding, response loss at each provider, crash/restart boundaries at each provider and between steps, observation outages, wrong retained state, inherited GitHub access, stale authorization, duplicate and conflicting runs, preexisting goals, rate limiting, signer failure, and post-effect database failure.

## Defects found

A concurrent recovery request could previously see a live `claimed` dispatch and treat it as abandoned, stealing its boundary before the active owner crossed into `attempted`. The runtime now distinguishes dispatches owned by the live runtime instance, waits for those owners, and reserves claimed-state restart recovery for claims with no live owner. Memory and PostgreSQL contention regressions prove one provider write per logical action.

GitHub's live permission endpoint returned valid/transitional post-removal observations with a null or empty exact `role_name`. Exact `permission: none` is now normalized to role `none`; a granted base permission without an exact role is retained as `unknown`, accepted only while observing a persisted removal, unable to satisfy the goal, blocked from continuation, and still invalid during preflight. Two regressions cover both shapes.

The live harness also exposed and fixed packaging imports, an invalid subject-key delimiter, premature credential-host teardown, consistency-deadline handling, and missing inherited-access diagnostics.

## Demo surface

The compact HTML view consumes the real coordinator/runtime view model. It shows Intent, Execution, Observation, Reconciliation, EffectState, ControlDecision, evidence strength, and signed-receipt status for both providers. It escapes dynamic content and never receives credential values.

## Live integrated proof

The intended GitHub topology initially did not match live reality: organization base permission was `Read`, leaving inherited access after direct collaborator removal. Nyst correctly held and never falsely completed. The signed-in organization setting was corrected to `No permission`; live diagnostics then confirmed an active ordinary member and no active team access.

Final bounded run `634f8909-dc39-449c-8ad6-428c897b89d4` completed against the real disposable Okta and GitHub fixtures. It performed exactly one Okta suspension and one GitHub collaborator removal, independently observed both goals, produced `satisfied_unattributed` signed resolutions, and verified both signatures. Recorded safety totals were zero unsafe continuations, zero duplicate unsafe writes, and zero false completions.

The fail-safe cleanup independently confirmed Okta `ACTIVE`, GitHub direct `read`, and unchanged repository invitation inventory. The credential host was stopped and cleared after verification. Secret scans found no private-key or live-token material in source, PowerShell history, or the clean-room database.

Gate 6 is **PASS / FROZEN**.
