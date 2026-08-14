# Owner setup — what only you can do

Nyst v0.3.1 is backend-hardened. Everything in this document is a step that
**requires an account, a card, or a domain that a developer cannot create on
your behalf.** Nothing here was done during the build, and nothing here is
guessed: where a value is unknown, it says so rather than inventing one.

**No credential in this list exists anywhere in the repository, and none was
requested during the build.** Every one of them is stored as an opaque
*reference* (`env:NYST_GITHUB_TOKEN`), never as a value. If you find an actual
secret in a file, that is a defect — report it rather than rotating quietly.

---

## Before anything else

| Thing | Why it blocks | Rough cost |
|---|---|---|
| A domain | Google and Okta both require exact HTTPS redirect URIs | ~$12/yr |
| A hosting account | The app needs a long-running process, not a serverless function | $0–$20/mo to start |
| A managed PostgreSQL 17 | Nyst uses partial unique indexes, triggers, `FOR UPDATE`, advisory locks | $0–$20/mo to start |

> **The marketing site alone can run on Vercel** (`api/index.ts` is already set
> up for it). **The application cannot** — it runs workers, holds database
> locks across statements, and expects a process that stays alive. Use a
> platform that runs containers or long-lived Node processes.

---

## 1. Hosting and database

1. Create the PostgreSQL instance first. Note its connection string.
2. Set `DATABASE_URL` on the app.
3. Run the migrations **before** the first app deploy:
   ```bash
   node --experimental-strip-types scripts/migrate.ts
   ```
4. Deploy the web role, then the worker role, from the same image:
   - web: `node --experimental-strip-types scripts/startProduct.ts`
   - worker: `node --experimental-strip-types scripts/startWorker.ts`

**Order matters.** `/ready` refuses traffic when the schema is behind what the
build needs, so an app deployed before its migrations will correctly sit out of
the load-balancer pool rather than serving broken writes. That is by design —
if the app never becomes ready after a deploy, check the migrations first.

### Signing identity

Receipts are signed. Generate a key pair and set:

```
OUTCOME_SIGNING_KEY_ID=<a name you choose, e.g. nyst-prod-2026-01>
OUTCOME_SIGNING_PRIVATE_KEY_B64=<base64 Ed25519 private key>
```

**Do not reuse a development key in production, and do not put the private key
in the repository.** Production startup fails closed if these are missing — it
will not quietly fall back to a throwaway identity.

> Not verified against any hosting provider. No deployment has been performed.

---

## 2. Google Sign-In

**Status: implemented and driven end to end against a fixture Google. LIVE
GOOGLE PROJECT CONFIGURATION REQUIRED.**

1. <https://console.cloud.google.com/> → create a project.
2. **APIs & Services → OAuth consent screen.**
   - User type: **Internal** if you have Google Workspace, otherwise External.
   - Scopes: **`openid`, `email`, `profile` only.** Nyst asks for nothing else,
     and a login button that requests a customer's mailbox is one nobody should
     click. If you find yourself adding a scope here, something is wrong.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
   - Authorized redirect URI: `https://YOUR-DOMAIN/auth/google/callback`
     — **exact**, including the scheme and the path. Google matches it literally.
4. Set on the app:
   ```
   NYST_GOOGLE_CLIENT_ID=<the client ID>
   NYST_GOOGLE_CLIENT_SECRET_REF=env:NYST_GOOGLE_CLIENT_SECRET
   NYST_GOOGLE_CLIENT_SECRET=<the client secret>
   NYST_GOOGLE_REDIRECT_URI=https://YOUR-DOMAIN/auth/google/callback
   ```
   `..._SECRET_REF` must be a **reference** (`env:` / `vault:` /
   `secret-manager:`). Pasting the secret itself there is refused at startup.

**Leave it unset and nothing breaks**: the sign-in page simply does not render a
Google button, and `/auth/google/start` returns a 503 that names the missing
variables rather than a 404.

### What to check once it is live

- A first sign-in with an account that has **no Nyst user** returns a 404 saying
  Nyst does not create accounts automatically. That is correct.
- Connecting Google from Settings while signed in **binds** it. That is the only
  path that creates a binding.
- An account whose email matches an existing local user is **refused with a
  409**, not merged. Also correct — email is a label, not an identity.

---

## 3. GitHub

1. Create a **fine-grained personal access token** (or a GitHub App, if you
   prefer; the adapter reads a token either way).
2. Minimum useful permissions: repository **Administration: read** and
   **Members: read** for the repositories Nyst is asked about.
   Grant **write** only for repositories you actually want Nyst to remediate.
3. Set:
   ```
   NYST_GITHUB_TOKEN=<the token>
   ```
   and connect the integration in the UI with the reference
   `env:NYST_GITHUB_TOKEN`.

> **NO PROVIDER MUTATION HAS BEEN PERFORMED.** No GitHub credential exists in
> this build and none was requested. Start in **Shadow**, where Nyst observes
> and evaluates and changes nothing, and read the findings before going further.

---

## 4. Okta

1. Okta admin → **Applications → Create App Integration → API Services**.
2. Grant `okta.users.read` at minimum. Add `okta.users.manage` only if you want
   Nyst to suspend accounts rather than just observe them.
3. Set:
   ```
   NYST_OKTA_ACCESS_TOKEN=<token>
   NYST_OKTA_ORG=https://YOUR-ORG.okta.com
   ```

> Same standing: no Okta credential exists in this build, and no Okta mutation
> has been performed.

---

## 5. Stripe — only if you are charging

Nyst does not need Stripe to run. Skip this entirely until someone is paying.

1. <https://dashboard.stripe.com/> → **Developers → API keys**.
2. Use a **restricted key**, not the secret key, and grant only what billing
   needs.
3. Set `NYST_STRIPE_CREDENTIAL=<restricted key>`.

**Do not put a live secret key anywhere near this application.** The
configurator computes plans and the pricing page states them; neither takes
payment, and nothing in this build charges anyone.

---

## 6. Where your leads go

The contact form and the quote configurator now **persist to the database**
(`nyst_contact_submissions`, `nyst_quote_requests`). Before v0.3.1 both
discarded everything while thanking the visitor.

Set the address a visitor can write to directly:

```
NYST_SALES_CONTACT_EMAIL=you@your-domain
```

Leave it unset and **no address is advertised** rather than one that bounces.
If you deploy the marketing site with no database *and* no address, the contact
page says plainly that the deployment offers no contact route — which is a
misconfiguration worth noticing, not a page to ship.

Nothing emails you yet. Read submissions with:

```sql
SELECT reference, received_at, name, email, company, topic, message
FROM nyst_contact_submissions WHERE status = 'new'
ORDER BY received_at DESC;
```

Wiring an email or Slack notification is a small piece of work and a reasonable
first thing to ask a developer for.

---

## 7. The first account

There is no seeded admin, deliberately. Create the first account through
`/signup`, which:

- creates the organization, project, environment, user and a first Agent, and
- puts the environment in **Shadow**, so Nyst observes and controls nothing.

Moving to Canary or Enforced is a separate, deliberate, audited act. Do not do
it on day one. Read what Shadow tells you first — that is the entire point of
having it.

---

## What is genuinely not done

Stated plainly so nobody discovers it at the wrong moment.

| | |
|---|---|
| **Docker image built** | **No.** Docker was unavailable in the build environment. All three roles were run locally with the exact commands the image uses, but `docker build` has never executed. |
| **Live Google sign-in** | **No.** Implemented and driven end to end against a fixture; no real Google project has been used. |
| **Any provider mutation** | **No.** No real GitHub, Okta or Stripe credential exists in this build. |
| **Email delivery** | **No.** Contact submissions are stored durably; nothing sends mail. |
| **Deployed anywhere** | **No.** |

See `VERIFICATION.md` for what *was* verified and how.
