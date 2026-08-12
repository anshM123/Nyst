# Security

Nyst sits between autonomous software and the systems it changes. A compromise
of Nyst is a compromise of everything downstream of it, so this document
describes the model plainly, including where it is weak.

---

## Reporting a vulnerability

Report privately, not in a public issue. Include a description, reproduction
steps, and the affected version.

Please do **not** include real credentials, real customer data, or a live
provider token in a report. A redacted reproduction is more useful and safer
for both of us.

---

## Trust boundaries

| Boundary | Control |
| --- | --- |
| Browser → Nyst | Session cookie (`httpOnly`, `SameSite=strict`, `Secure` in production) plus a CSRF token on every mutating call |
| Program → Nyst | API key, `Authorization: Nyst <key>`, scoped |
| Nyst → provider | A credential resolved from an opaque reference at the moment of use |
| Nyst → your webhook endpoint | HMAC signature, timestamp window, DNS-pinned delivery |
| Nyst → PostgreSQL | Optional TLS with certificate verification on by default |

---

## Tenancy

Every row is scoped to organization / project / environment.

Agent identity is bound by **composite foreign key**
`(agent_id, environment_id, project_id, organization_id)`, so an agent that
belongs to another tenant is structurally impossible to reference — not
filtered out by a `WHERE` clause someone might forget.

Browser sessions may switch only among projects and environments the session
can actually reach. The server validates the switch; the browser never decides
what a session can see.

---

## Authentication

- Passwords hashed with bcrypt.
- Sessions are opaque tokens, `httpOnly`, `SameSite=strict`, 12-hour lifetime,
  revocable server-side. Signing out revokes the session record; it does not
  merely delete a cookie.
- API keys are stored hashed, carry explicit scopes, and may be bound to a
  single Agent.
- API keys cannot reach dashboard pages, and sessions are required for
  administrative operations. The two credential kinds are not interchangeable.

## Authorization

Scopes are checked per endpoint. Beyond that, **effective authority is the
intersection** of runtime authority and the action's immutable policy authority
— never a union. See [policy](docs/product/policy.md). A permission cannot be
granted by adding a second source, only removed.

---

## Browser security

- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
  data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'`.
- No inline scripts and no inline styles. `style-src 'self'` blocks style
  attributes outright, so all styling lives in the served stylesheet — a test
  asserts that no page emits a `style=` attribute, because a blocked inline
  style fails silently.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, and HSTS in production.
- All rendered values are HTML-escaped.
- **No authoritative safety logic in client JavaScript.** The browser never
  decides an effect state or a disposition. A tampered client can send a
  request; it cannot manufacture a decision.

---

## Injection

- Every query is parameterized. No string-interpolated SQL.
- Route IDs are validated as UUIDs before reaching a query.
- Request bodies are capped at 64 KB.
- CSV export neutralises spreadsheet formula injection.
- Credential references are validated against a strict pattern.

---

## Outbound requests (SSRF)

Webhook delivery resolves the endpoint's DNS **once** and connects to the
pinned address, so a name that resolves differently between check and connect
cannot be used for rebinding.

Deliveries are HMAC-signed with a timestamp and a five-minute window.
Verification uses a length check followed by a constant-time comparison. The
signature covers the **raw** body: re-serialising a parsed object changes the
bytes and will not verify.

---

## Secrets

Nyst stores an opaque reference, never a value. A resolved secret must never
enter the database, evidence, a receipt, a log, action input, a webhook, the
browser, a metric, the Protection Report, or a Proof Pack.

`NYST_DEBUG_LOG_CREDENTIALS` is a startup failure in every environment. It is
not a supported debugging mode.

Full detail, including how to add your own provider:
[secrets](docs/product/secrets.md).

---

## Receipts

Ed25519 software signatures. **Tamper evidence, not hardware attestation.** No
HSM, no trusted timestamping; timestamps are marked `trusted: false`. See
[receipt signing](docs/product/receipt-signing.md).

---

## Fail-closed configuration

Production refuses to start on: a missing database, a missing or known-weak
signing identity, an ephemeral signing identity, a non-HTTPS public origin,
`NYST_SECURE_COOKIES=false`, demo mode enabled, the fake provider enabled,
debug credential logging, a webhook secret under 32 characters, or database TLS
with certificate verification disabled.

It refuses rather than warning, because a misconfigured Nyst is more dangerous
than an absent one: it accepts consequential actions and then cannot resolve
them.

---

## Isolation of simulations

The Failure Lab and Demo surfaces run with a secret provider that resolves
**nothing**. Reaching a real credential from a simulation is structurally
impossible, not merely disallowed by convention. Their output is labelled
`SIMULATED` and never contributes to protection metrics.

---

## Known weaknesses

Stated plainly, because a security document that lists only strengths is not
a security document.

- **Software signing.** Host compromise means key compromise.
- **Rate limiting is per-process and in-memory.** It resets on restart and is
  not shared across instances.
- **`NYST_TRUST_PROXY` is a real risk if misused.** Enabled on a directly
  exposed instance, any client can claim any IP via `X-Forwarded-For` and defeat
  per-IP rate limiting. Enable it only behind a proxy you control. Left off
  behind a real proxy, every request shares one bucket.
- **No SSO, SAML, SCIM, or RBAC** beyond API key scopes.
- **No audit log export or tamper-evident log chain.** The audit trail is
  ordinary database rows; a database administrator can alter it. Receipts are
  individually signed, so tampering with a receipt is detectable — reordering
  or deleting audit rows is not.
- **Session revocation is not push-based.** Revoking a session takes effect on
  the next request, which is immediate in practice but is not a broadcast.

See [known boundaries](docs/product/known-boundaries.md) for the full list,
including non-security limitations.

---

## Deployment hardening checklist

- [ ] `NODE_ENV=production`
- [ ] HTTPS terminated in front of Nyst; `NYST_PUBLIC_ORIGIN` is the https URL
- [ ] Persistent signing identity from a secret store, not a file on the host
- [ ] `NYST_TRUST_PROXY` set to match reality
- [ ] Database TLS with verification enabled; a CA supplied rather than
      verification disabled
- [ ] Postgres not published to the host or the internet
- [ ] Provider credentials scoped to the minimum needed for the enabled
      EffectSpecs
- [ ] Webhook secret at least 32 characters
- [ ] Backups encrypted at rest; a restore verified, including the receipt
      signature
- [ ] `/v1/operational-health` monitored, with an alert on stale worker
      heartbeats
