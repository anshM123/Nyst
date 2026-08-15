# Frontend handoff — Nyst v0.3.2

For the visual redesign pass. Every page that exists, what backs it, what states
it can be in, and the semantics that must survive being made to look good.

**This pass deliberately did not touch aesthetics.** Typography, layout,
animation and branding are all untouched from v0.3.0. What changed underneath is
listed in [What moved in v0.3.2](#what-moved-in-v032) — several pages now have
states they did not have before, and two have new routes entirely.

---

## The rule that outranks the design

Three layers, and the UI must never collapse them:

| Layer | Question | Values |
|---|---|---|
| **Authority** | What may this Agent do? | autonomous · human · disabled |
| **Effect** | What happened to this operation? | six EffectStates |
| **Outcome** | What became true in the world? | satisfied · unsatisfied · indeterminate |

**Six EffectStates**, never five, never seven: `verified`, `not_applied`,
`pending`, `compensated`, `satisfied_unattributed`, `unprovable`.

The headline sentence this product exists to say:

> **ACTION VERIFIED. OUTCOME UNSATISFIED.**

The API call succeeded and the world is still wrong. **If a design cannot render
that pair without it reading as a bug, the design is wrong** — not the data. It
is the single most important state in the product and it is not an error state.

Likewise `indeterminate` is not a spinner. It is a conclusion: Nyst looked and
cannot establish what is true. It deserves as much visual weight as a verdict,
because it *is* one.

---

## Public pages

| Page | Route | Backing | States |
|---|---|---|---|
| Landing | `GET /` | static | signed-out only; signed-in users get the dashboard at the same URL |
| Product | `GET /product` | static | — |
| Outcomes explained | `GET /outcomes-explained` | static | — |
| Integrations | `GET /integrations-public` | static | — |
| Security | `GET /security` | static | — |
| Pricing | `GET /pricing` | `PLANS` | — |
| Configure / quote | `GET,POST /configure` | `recommendPlan` | empty · result · result-with-gaps |
| Contact | `GET,POST /contact` | `record_contact` | form · thanks-with-reference · **failed (503)** · **closed** |
| Privacy, Terms | `GET /privacy`, `/terms` | static | — |

**Contact has a failure state you must design.** It returns **503** when there
is no durable inbox or storage failed, because before v0.3.1 it thanked people
for messages it discarded. On success the response carries a reference
`NYST-LEAD-XXXXXXXX` — show it.

There is a hidden honeypot field `company_website`. **Leave it in the markup,
keep it visually hidden, never fill it.** A submission with it filled looks
successful and is silently dropped.

**Configure** persists the exact price string it displayed. Whatever the design
does to that string, the value shown must remain the value stored.

---

## Authentication

| Page | Route | States |
|---|---|---|
| Sign in | `GET /login` | form · error · **Google button (only when configured)** |
| Sign up | `GET,POST /signup` | form · error · **unavailable** |
| **Finish Google signup** | `GET,POST /signup/google` | **NEW in v0.3.2** — form · error · expired (410) |
| **Forgot password** | `GET,POST /forgot-password` | **NEW** — form · sent · no-transport |
| **Reset password** | `GET,POST /reset-password` | **NEW** — form · invalid-link · weak-password · done |
| Connected accounts | `GET /v1/auth/identities` | list · cannot-disconnect (409) |

### Google, and the four outcomes you have to render

| Situation | Response | What to show |
|---|---|---|
| Known identity | 302 + session | Straight in |
| **Unknown identity** | **302 → `/signup/google`** | The finish-setup form. **Changed in v0.3.2** — this used to be a 404 dead end |
| Email matches a local account | **409** | "Sign in with your password first, then connect Google in Settings." **Never merge** |
| Already linked to someone else | **409** | "Already connected to a different Nyst user." |
| Anything wrong with the token | **401**, all refusals **byte-identical** | One generic message. You cannot tell these apart, deliberately |

### Password reset, and the one thing not to break

`/forgot-password` returns a **byte-identical** page for a real address and an
invented one. That is not politeness, it is the security property: a page that
distinguishes them enumerates the customer list. **Do not add a "we couldn't
find that email" state.** There is a test asserting the bodies are equal.

The reset page must keep the token in its hidden field and **nowhere else** — a
test counts occurrences and requires exactly one. Do not put it in a link, an
image URL, or an analytics call.

---

## Application pages

| Page | Route | Backing | States that matter |
|---|---|---|---|
| Overview | `GET /` | `canonicalMetrics` | shadow (evaluating) vs enforced (protecting) — **different headline** |
| Needs Attention | `GET /needs-attention` | interventions | empty is a real state and a good one |
| Outcomes | `GET /outcomes` | `outcomes.list` | satisfied · unsatisfied · indeterminate |
| Outcome detail | `GET /outcomes/:id` | instance + evaluations + **receipt series** | per-invariant results, facts used, contradictions, missing facts |
| Agents | `GET /agents` | agents | — |
| **Autonomy Line** | `GET /autonomy` | rules + **decisions** | **now populated** — see below |
| Actions | `GET /actions` | actions | six EffectStates |
| Action detail | `GET /actions/:id` | action + evidence + resolutions + receipt | |
| Protection | `GET /protection` | protection report | |
| Policies | `GET /policies` | policy versions | |
| Effect Registry | `GET /effect-registry` | descriptors + readiness | **seven readiness dimensions** |
| Integrations | `GET /integrations` | integrations + readiness | connected · not ready (with reason) · **disconnected** |
| Failure Lab | `GET /failure-lab` | scenarios | |
| Settings | `GET /settings` | context | |

### The Autonomy Line page is no longer empty

Before v0.3.2 `nyst_authority_decisions` was written only by a test, so this
page showed an empty history in every real deployment. **Every consequential
action now writes a decision, allowed or refused.** Design for a busy list, and
for a refusal being the *interesting* row rather than the exceptional one.

Every new workspace starts with **one default rule** — autonomous, restricted to
reversible effects. Show it as a real rule the customer can tighten, not as an
absence.

### Readiness is a conjunction — render the reason

`ready` is seven independent dimensions and any one false makes it false. The
API returns `failure_category` and `reason`. **Render those.** A bare "not
ready" is the exact defect v0.2.2 existed to remove, and nothing else in the
codebase is allowed to compute readiness.

---

## What moved in v0.3.2

Things with new states, new routes, or changed responses:

1. **`POST /v1/actions` can now be refused by Authority** — 409 with
   `nyst_blocked_by: "authority"` and a `primary_reason` naming which constraint
   held it. Show the reason; "blocked" alone is useless to an operator.
2. **Mode transitions can be refused commercially** — 402 with a plan reason.
   Distinct from a safety refusal, and it must *look* distinct: one is "upgrade",
   the other is "this is not safe yet".
3. **`DELETE /v1/integrations/:provider`** — the response says what it stops and
   what it does **not** (in-flight work; Emergency Freeze is that control).
   Put that in the confirmation, not the changelog.
4. **Google signup** — a whole new page.
5. **Password reset** — two new pages.
6. **Receipt series** — an outcome has *many* signed receipts, newest first.
   "UNSATISFIED at 10:05, SATISFIED at 11:20, both signed" is the strongest
   thing this product produces. It deserves a timeline, not a single badge.

---

## Error shape

```json
{ "error": "not_found", "detail": "…", "request_id": "…" }
```

`request_id` is on **every** error including 404s. Put it somewhere copyable.

**400** your input · **401** not signed in · **402** commercial plan ·
**403** not allowed / CSRF · **404** not in this scope · **409** real conflict ·
**410** expired link · **429** rate limited · **503** not configured

---

## Things that will bite a redesign

1. **`indeterminate` is not a loading state.** It is a verdict.
2. **Do not merge accounts on matching email.** The 409 is deliberate.
3. **Do not add a "no such email" state to forgot-password.**
4. **Do not remove the honeypot field.**
5. **Do not mask `credential_ref`.** It is a *name* like `env:NYST_GITHUB_TOKEN`,
   and the operator needs to see which variable is configured.
6. **Every state-changing request needs `X-Nyst-Csrf`.** Missing and wrong both
   return 403. No exemptions.
7. **A refusal is a first-class result, not an error toast.** Most of what makes
   this product worth anything is visible in the things it declined to do.

---

**1125 tests, 136 suites, 0 failing. 35 migrations.**
See `VERIFICATION.md` for what is verified and what is not.
