# Backend handoff — Nyst v0.3.1

For the frontend developer. What the backend gives you, what it will refuse,
and where it will still surprise you.

Nothing below is aspirational. If a route is listed, it exists and has a test.
Where something is not done, it is in **[What is not there](#what-is-not-there)**
rather than omitted.

---

## Run it

```bash
npm ci && npm run build
DATABASE_URL="postgres://user:pass@host:5432/nyst" node --experimental-strip-types scripts/migrate.ts
DATABASE_URL="postgres://user:pass@host:5432/nyst" NYST_LOCAL_EPHEMERAL_SIGNING=true node --experimental-strip-types scripts/startProduct.ts
```

Serves on `:4080`. `RUN.md` has the full version. Production startup **fails
closed** on unsafe configuration — if it exits at boot, read the message; it
lists exactly what is missing.

---

## Authentication

Two principals, and they are not interchangeable.

**Session** (cookie `nyst_session`, `HttpOnly`, `SameSite=Lax`) — a person in a
browser. Everything below is a session unless marked otherwise.

**API key** (`Authorization: Nyst <key>`) — an Agent. Scoped, and **cannot reach
anything a person owns**: not the dashboard pages, not Connected Accounts, not
integration configuration. Do not try to route around this from the frontend.

**CSRF.** Every state-changing session request needs `X-Nyst-Csrf`. The token
comes back in the `POST /v1/auth/login` response body. Missing *and* wrong both
return 403. There is no exemption.

```
POST /v1/auth/login    {organization, email, password} -> sets cookie, returns {csrf}
POST /v1/auth/logout
GET  /login            HTML. Renders "Sign in with Google" ONLY if configured.
GET  /signup, POST /signup
```

### Google Sign-In

```
GET  /auth/google/start[?next=/local/path]
GET  /auth/google/callback
GET  /v1/auth/identities                        session-only
POST /v1/auth/identities/:id/disconnect         session-only + CSRF
```

Behaviour you have to design for, because it is deliberate and it will not change:

| Situation | Response | What to show |
|---|---|---|
| Known Google identity | 302 + session | Straight in |
| Google identity nobody has linked | **404** | "Nyst does not create accounts from a Google sign-in. Start in Shadow first." |
| Google email matches an existing local account | **409** | "Sign in with your password first, then connect Google in Settings." **Never merge.** |
| That Google account is linked to someone else | **409** | "Already connected to a different Nyst user." |
| Anything wrong with the token | **401**, and all refusals are **byte-identical** | One generic message. You cannot tell these apart, and that is the point. |

`?next=` only survives if it is a local path. `https://evil.example` and
`//evil.example` both silently become `/`.

Unconfigured deployments: `/auth/google/start` returns **503** naming the
missing environment variables, and `/login` renders no Google button. Handle the
503; do not assume the button implies a working project.

> **LIVE GOOGLE PROJECT CONFIGURATION REQUIRED.** Driven end to end against a
> fixture Google. No real Google project has ever been used.

---

## The three layers

Do not collapse these in the UI. They answer different questions and they
disagree constantly — that disagreement is the product.

| Layer | Question | Values |
|---|---|---|
| **Authority** | What may this Agent do? | autonomous · human · disabled |
| **Effect** | What happened to this operation? | six EffectStates |
| **Outcome** | What became true in the world? | satisfied · unsatisfied · indeterminate |

**Six EffectStates**, never five, never seven: `verified`, `not_applied`,
`pending`, `compensated`, `satisfied_unattributed`, `unprovable`.

The headline case: **ACTION VERIFIED. OUTCOME UNSATISFIED.** The API call
succeeded and the world is still wrong. If your UI cannot render that sentence
without looking like a bug, the UI is wrong.

---

## Outcomes

```
GET  /v1/outcomes
GET  /v1/outcomes/:id
POST /v1/outcomes/:id/evaluate
GET  /v1/outcomes/:id/receipt[?evaluation_sequence=N]   latest by default
GET  /v1/outcomes/:id/receipts                          the whole series
POST /v1/outcomes/:id/receipt                           issue one
```

### Receipts are a SERIES (changed in v0.3.1)

There is one receipt per **evaluation**, not per outcome. An outcome that was
UNSATISFIED at 10:05 and SATISFIED at 11:20 has **two** signed receipts and both
are permanent.

- `GET .../receipt` returns the **latest**. Before v0.3.1 it returned the first
  one ever issued, so "prove this is now satisfied" answered with a signed
  statement that it was *not*.
- `POST .../receipt` twice with no evaluation in between returns the **same**
  receipt. That is idempotence, not a duplicate.
- Show the series. "Here is what changed and when, each signed" is the strongest
  thing this product produces.

### Two keys on an instance, and they mean different things

- `subject_key` — **who** it is about (`offboard:alice@example.test`). **Repeats.**
  Use it for "everything Nyst has established about Alice".
- `request_key` — **which request**. Unique among live requests.

A person can be offboarded more than once over time. Opening a second live
outcome for the same subject while one is still open returns **409** — two
offboardings racing on one person is refused deliberately.

---

## WorldFacts are READ-ONLY over HTTP

`POST /v1/world-facts` returns **405**, permanently. It is not missing.

A caller may not classify the authority of its own evidence — that would let the
system Nyst is verifying manufacture the truth Nyst evaluates. Observations go
to `POST /v1/evidence` through a registered Evidence Source, and the source's
registered authority is what classifies the fact.

If you are building something that seems to need this route, the design is wrong
somewhere upstream.

---

## Integrations

```
GET  /v1/integrations
PUT  /v1/integrations/:provider          session-only + CSRF
POST /v1/integrations/:provider/preflight
GET  /v1/integrations/:provider/capabilities
```

`credential_ref` is a **name**, not a value — `env:NYST_GITHUB_TOKEN`. Posting
something token-shaped returns **400** with an explanation. Show that message; it
tells the user exactly what to do instead.

**Ready is a conjunction of seven dimensions**, and any one false makes it false.
The API gives you the specific `failure_category` and `reason` — render those,
never a bare "not ready". Nothing else in the codebase is allowed to compute
readiness, so treat this as the only source.

Rotating a credential drops the integration back to **unverified** until a new
preflight runs. That is correct: the old preflight proved a credential that is no
longer in use.

**There is no disconnect route.** Deliberately — see [What is not there](#what-is-not-there).

---

## Health and readiness

```
GET /health   liveness  — answers even when the database is down
GET /ready    readiness — 200 servable, 503 {status, reason, service}
```

`reason` is one of `database_unreachable` · `schema_behind` · `signing_unavailable`,
and deliberately carries nothing else — `/ready` is unauthenticated.

**`schema_behind` means someone deployed the app before its migrations.** It is
the single most likely thing to go wrong on a first deploy.

---

## Error shape

```json
{ "error": "not_found", "detail": "…", "request_id": "…" }
```

`request_id` is on **every** error including 404s. Put it in the UI somewhere
copyable — it is the only way to correlate a user's report with a log line.

Status codes mean what they say: **400** your input, **401** not signed in,
**403** signed in but not allowed (or CSRF), **404** does not exist in this
scope, **409** a real conflict worth showing, **429** rate limited, **503**
this deployment is not configured for that.

---

## Public site

```
GET/POST /contact      GET/POST /configure      GET/POST /signup
```

**The contact form can refuse to accept a message**, and you must handle it.
It returns **503** when there is no durable inbox or storage failed, because
before v0.3.1 it thanked people for messages it discarded. On success the
response contains a reference `NYST-LEAD-XXXXXXXX` — show it.

There is a honeypot field `company_website` in the form. **Leave it in, keep it
hidden, never fill it.** A submission with it filled looks successful and is
silently dropped.

Rate limit is per source address; expect **429** on repeated submissions.

---

## What is not there

Stated plainly so you do not build against something that does not exist.

| | |
|---|---|
| **Docker image built** | **No.** Docker was unavailable in the build environment. All three roles were run locally with the exact commands the image uses; `docker build` has never executed. |
| **Live Google sign-in** | **No.** Fixture-driven end to end. **LIVE GOOGLE PROJECT CONFIGURATION REQUIRED.** |
| **Any real provider call** | **No.** No GitHub, Okta or Stripe credential exists in this build. Deterministic provider-shaped clients only. |
| **Integration disconnect** | **No route.** Removing the row would not stop in-flight work — the integration is checked at admission only, and the workers read the environment directly. A control that looks like a kill switch but is not one is worse than none. Use **disable the EffectSpec** or **Emergency Freeze**. |
| **Email / Slack on a lead** | **No.** Submissions are stored durably; nothing notifies anyone. Query `nyst_contact_submissions`. |
| **Password reset** | **No.** |
| **Deployed anywhere** | **No.** |

---

## Things that will bite you

1. **`/ready` 503 with `schema_behind`** — run the migrations. This is the
   number one first-deploy failure and it is working as designed.
2. **A 409 from Google callback is not an error to retry** — it is a decision the
   user has to make. Give them the path, not a spinner.
3. **`created: false` from opening an outcome** means you got the *existing live*
   one. Do not treat it as failure.
4. **The contact form's 503 is real.** Do not swallow it into a generic "thanks".
5. **`sanitizeForProduct` deliberately exposes `credential_ref`** because it is a
   name. Do not add a masking layer that hides which variable is configured —
   that is information the operator needs.

---

## Where to look

| | |
|---|---|
| What was verified, and what was not | `VERIFICATION.md` |
| Steps only the owner can do | `docs/OWNER-SETUP.md` |
| Running it locally | `RUN.md` |
| Where Nyst stops | `docs/product/known-boundaries.md` |
| Why a defect exists | its test file — every v0.3.1 fix has one, and each failed before it passed |

**991 tests, 0 failing, 0 skipped, 124 suites. 30 migrations, applied cleanly
from an empty database.**
