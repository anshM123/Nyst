# Signed decision webhooks

Nyst emits durable decision events only after the corresponding resolution or lifecycle transition is persisted. Supported event types are `action.pending`, `effect.resolved`, `continuation.authorized`, `human_review.required`, `recovery.completed`, `compensation.completed`, and the operator-requested `webhook.test`. A pending resolution is never mislabeled as resolved.

Destinations must use HTTPS. URLs containing credentials, redirects, loopback, link-local, private, multicast, reserved, documentation, or internal addresses are rejected. Delivery validates every A and AAAA answer, fails closed if any answer is unsafe, and pins the actual TLS connection to a validated address while preserving the original hostname for SNI, certificate verification, and `Host`. Redirects are never followed and responses are size- and time-bounded.

Each event has a stable `X-Nyst-Event-Id`. Consumers must deduplicate on that ID because network response loss can cause delivery retries. Nyst signs the exact request bytes with HMAC-SHA256:

```text
X-Nyst-Timestamp: <unix-seconds>
X-Nyst-Event-Id: <uuid>
X-Nyst-Signature: v1=<hex-hmac>
```

The signed message is `<timestamp>.<event-id>.<raw-body>`. Verify it with constant-time comparison, reject timestamps outside five minutes, then atomically record the event ID before processing. Signing secrets are stored only as `env:...` references.

Delivery uses stable event and attempt IDs, durable leases, bounded exponential backoff, and a terminal attempt limit. A successful response is any 2xx response. Transport delivery can still be duplicated after response loss, so receivers must atomically deduplicate on `X-Nyst-Event-Id`.
