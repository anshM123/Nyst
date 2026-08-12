# Deployment

Nyst is an ordinary Node service plus PostgreSQL. It needs a database, a port,
and environment variables. It does not depend on any particular host, an open
browser, or hidden state.

---

## Shape

Three processes from one image:

| Role | Command | What it does |
| --- | --- | --- |
| **web** | `scripts/startProduct.ts` | HTTP API and dashboard |
| **worker** | `scripts/startWorker.ts` | Reconciliation, recovery, re-observation, webhook delivery |
| **migrate** | `scripts/migrate.ts` | Applies SQL migrations, then exits |

The workers run **separately** from the API so that the API can restart, or be
scaled, without stranding ambiguous actions — and so that worker failure is
visible as a stale heartbeat rather than hidden behind an API that still
answers.

`NYST_RUN_EMBEDDED_WORKER=true` collapses them into one process. It defaults on
in development for convenience and defaults **off** in production, where it
should stay off.

---

## Requirements

- Node 22+ (the image uses Node 24)
- PostgreSQL 14+ (tested against 17)
- HTTPS termination in front of Nyst

---

## Docker Compose

```bash
cp .env.example .env
```

Fill in `DATABASE_URL`, `POSTGRES_PASSWORD`, `NYST_PUBLIC_ORIGIN`, and the
signing identity. Then:

```bash
docker compose run --rm migrate
```

```bash
docker compose up -d
```

The image is multi-stage and runs as the non-root `node` user. TypeScript and
the other build tools are dropped from the runtime layer.

`docker compose` publishes the web port on `127.0.0.1` by default. Put your TLS
terminator in front of it; do not publish 4080 to the internet.

---

## Configuration

Production **fails closed**. Nyst refuses to boot on unsafe configuration
rather than warning and continuing, because a misconfigured Nyst accepts
consequential actions and then cannot resolve them.

### Required in production

| Variable | Notes |
| --- | --- |
| `NODE_ENV=production` | Switches on every rule below |
| `DATABASE_URL` | Nyst has no durable state without it, and durable state is the product |
| `NYST_PUBLIC_ORIGIN` | Must be `https://…`. Used in webhook and Slack links |
| `OUTCOME_SIGNING_KEY_ID` | Must not be a known development id (`dev-local-1`, `test`, `local`, `changeme`, …) |
| `OUTCOME_SIGNING_PRIVATE_KEY_B64` | Base64 PKCS8 Ed25519. See [receipt signing](receipt-signing.md) |
| `NYST_HOST` | Must not be loopback in production, or nothing can reach it |

### Rejected in production

| Variable | Why |
| --- | --- |
| `NYST_LOCAL_EPHEMERAL_SIGNING=true` | A per-boot key cannot verify yesterday's receipts |
| `NYST_ENABLE_DEVELOPMENT_FAKE=true` | A fake provider must never stand in for a real one |
| `NYST_ENABLE_DEMO=true` | Demo activity must never contaminate real metrics |
| `NYST_SECURE_COOKIES=false` | Session cookies must be `Secure` |
| `NYST_DEBUG_LOG_CREDENTIALS` | Rejected in every environment |
| `NYST_WEBHOOK_SECRET` under 32 chars | A short secret makes signatures forgeable |
| `NYST_DATABASE_SSL_REJECT_UNAUTHORIZED=false` with TLS on | Unverified TLS is encryption without authentication |

### Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `NYST_PORT` | `4080` | |
| `NYST_TRUST_PROXY` | `false` | See below. Get this right |
| `NYST_DATABASE_SSL` | off | Also inferred from `sslmode=require` in the URL |
| `NYST_RUN_EMBEDDED_WORKER` | off in production | Leave it off |
| `NYST_WORKER_INTERVAL_MS` | `1000` | |
| `NYST_WORKER_INSTANCE_ID` | hostname-pid | Shows up in heartbeats |

Provider credentials (`NYST_GITHUB_TOKEN`, `NYST_OKTA_ACCESS_TOKEN`,
`NYST_STRIPE_API_KEY`) are needed only for the providers you actually enable.
Nyst never demands a credential for a provider you are not using.

---

## Trusted proxy — read this one carefully

`NYST_TRUST_PROXY` controls whether Nyst believes `X-Forwarded-*`.

- **Enabled on a directly reachable instance**: any client can claim any IP and
  the per-IP rate limiter becomes decoration.
- **Disabled behind a real proxy**: every request appears to come from the
  proxy and shares a single rate-limit bucket.

Set it to match your actual topology. If Nyst is behind a load balancer or
ingress you control, set it to `true`. If anything can reach the container
directly, leave it `false`.

---

## TLS to PostgreSQL

```bash
NYST_DATABASE_SSL=true
```

Verification is on by default. If your certificate fails to verify, supply the
CA — do not set `NYST_DATABASE_SSL_REJECT_UNAUTHORIZED=false`. Unverified TLS
protects you from a passive observer and from nobody else, and production
refuses to start with that combination.

---

## First boot

Create the initial organization by setting the bootstrap variables on the web
host's **first** start (they are ignored once an organization exists):

```
NYST_BOOTSTRAP_ORGANIZATION, NYST_BOOTSTRAP_ORG_SLUG,
NYST_BOOTSTRAP_PROJECT,      NYST_BOOTSTRAP_PROJECT_SLUG,
NYST_BOOTSTRAP_ENVIRONMENT,  NYST_BOOTSTRAP_ENV_SLUG,
NYST_BOOTSTRAP_EMAIL, NYST_BOOTSTRAP_DISPLAY_NAME, NYST_BOOTSTRAP_PASSWORD
```

Then remove `NYST_BOOTSTRAP_PASSWORD` from the environment.

---

## Health and readiness

| Endpoint | Auth | Meaning |
| --- | --- | --- |
| `GET /health` | none | The process is up. Use for container liveness |
| `GET /ready` | none | The database is reachable. Use for load-balancer readiness. Returns 503 when not |
| `GET /v1/operational-health` | API key | Worker heartbeats, queue depth, stale leases. `?format=prometheus` for metrics |

Point container liveness at `/health` and the load balancer at `/ready`. A
database blip should take an instance out of rotation, not restart it.

### Alert on worker liveness

Alert when any of the four worker kinds has no heartbeat within
**120 seconds**. An API that answers while its workers are dead is the most
dangerous state a Nyst deployment can be in: it accepts consequential actions
and never resolves them, and from the outside it looks perfectly healthy.

---

## Logs

Structured JSON on stdout, one object per line, with a `request_id` on every
HTTP line and echoed in the `X-Nyst-Request-Id` response header. Credentials
are redacted by key name at serialisation as a second line of defence; Nyst
does not log them in the first place.

---

## Graceful shutdown

Both hosts handle `SIGINT` and `SIGTERM`: stop accepting, finish in-flight
work, release the pool, exit 0. The Dockerfile uses exec-form `CMD` so the
signal reaches PID 1.

A worker killed mid-claim is safe by design — the lease expires and the
dispatch boundary decides what a reclaiming worker may do — but shutting down
cleanly avoids a needless reclaim cycle. Prefer `docker compose stop` over
`kill -9`.

---

## Scaling

- **Web**: stateless behind a load balancer. Scale freely.
- **Workers**: safe to run several. Every claim is leased and the dispatch
  boundary governs reclaim. Optional environment sharding exists if you want a
  worker per environment.
- **PostgreSQL**: single instance. Nyst's correctness rests on transactions in
  one database, and there is no multi-region story.

---

## Next

- [Design-partner deployment guide](design-partner-guide.md) — the full path to
  first protected action
- [Backup and restore](backup-and-restore.md)
- [Upgrades](upgrades.md)
- [Security](../../SECURITY.md)
