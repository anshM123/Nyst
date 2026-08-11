# Internal comparison: Nyst and Postcept

Research date: 2026-08-08. Sources consulted: https://postcept.com/ and https://postcept.com/docs. This is an internal positioning note, not a claim of superiority.

| Dimension | Nyst (current verified roadmap) | Postcept (publicly documented) |
|---|---|---|
| Primary wedge | Effect-control runtime for consequential software actions, beginning with GitHub/Okta access and adding narrow Stripe effects | Outcome verification for action-taking agents, beginning with refunds, credits, cancellations, and support-ticket completion |
| Executes provider writes | Yes, through consequence-bound provider adapters with persisted DispatchPlans | Public site says no: it verifies system-of-record outcomes and routes failures; provider access can be read-only |
| Financial overlap | Exact sandbox full refund and final full PaymentIntent capture in Gate 7 v1 | Refund integrity is a primary public use case; verifies amount, customer, currency, duplicates, idempotency context, and finality |
| Access/infra coverage | GitHub repository permission change, Okta suspension, and their integrated offboarding boundary | No equivalent GitHub/Okta mutation-control scope is claimed on the public pages reviewed |
| Outcome/state model | Six closed EffectStates plus a separate ControlDecision axis | Public examples expose result/lifecycle plus `safe_to_claim_complete` and a machine-readable reason |
| Retry control | Runtime owns dispatch certainty, blocks blind retry, and sequence-binds guarded retry authorization | Public materials emphasize duplicate detection/idempotency context and route incomplete/duplicate work to recovery; they do not claim to execute retries |
| Continuation control | Current decisions include allowed/blocked continuation; Gate 6 atomically revalidates the prior action while claiming the immediate downstream dispatch | Applications branch on `safe_to_claim_complete`; the public SDK `guard()` returns the strongest supported customer message |
| Evidence/attribution | Append-only evidence ledger, supersession, explicit attribution disposition, provider reads, response evidence, and absence probes | Signed observations and postcondition evidence; Relay mode separates observation from evaluation |
| Receipts | Ed25519-signed OutcomeResolution binding action, evidence references, state, control, policy/spec version, and logical sequence | Signed Postcept Receipt describing claim, checked systems/postconditions, evidence, verdict, and signature; public site also describes relay and evaluation signatures |
| Credential boundary | Provider credential references are persisted; raw credentials stay in process environment. Current adapters may require write privileges because Nyst executes effects | Relay mode keeps provider credentials/raw records in the customer's environment and can use scoped read-only access |
| Deployment posture | Local/runtime infrastructure today; product API, auth, scheduler, and UI are Gate 8 work | Public Audit, Monitor, and Gate postures plus hosted API/SDK and optional relay |

## Honest conclusion

It is inaccurate to say “Postcept verifies; Nyst decides.” Postcept publicly documents an enforceable completion decision, lifecycle/finality handling, recovery routing, signed receipts, and a guard used by downstream workflows. Nyst's defensible distinction is narrower: it currently owns the pre-write consequence boundary and no-duplicate dispatch state for several access/infra effects, then carries that same runtime into two controlled Stripe effects. Postcept appears more specialized and productized around post-action refund/support verification. Nyst should not claim superior refund verification without direct benchmark evidence.
