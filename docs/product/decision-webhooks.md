# Decision webhooks

Nyst pushes an event whenever a resolution or lifecycle transition is
**persisted**. Not before: an event is emitted from the durable transition, so
Nyst can never tell you about a decision it has not actually recorded.

Use this instead of polling.

---

## Events

| Event type | Meaning |
| --- | --- |
| `action.pending` | The action is unresolved; the world has not settled |
| `effect.resolved` | An EffectState was reached |
| `continuation.authorized` | A continuation was permitted |
| `human_review.required` | A person must look at this |
| `recovery.completed` | A recovery finished |
| `compensation.completed` | A compensation finished |
| `webhook.test` | Operator-requested test delivery |

A pending resolution is never mislabelled as resolved.

---

## Configuring an endpoint

**Settings → Decision webhooks**, or `PUT /v1/webhooks/decision`:

```json
{
  "target_url": "https://hooks.acme.com/nyst",
  "signing_secret_ref": "env:NYST_WEBHOOK_SECRET"
}
```

The signing secret is stored as an **opaque reference**, never as a value. Use
at least 32 characters; production refuses to start with a shorter one, because
a short HMAC secret is guessable.

`POST /v1/webhooks/decision/test` queues a `webhook.test` delivery so you can
verify your receiver before anything real depends on it.

---

## Destination rules

Destinations must be **HTTPS**. Rejected outright:

- URLs containing credentials
- Loopback, link-local, private, multicast, reserved, documentation, and
  internal addresses

Delivery validates **every** A and AAAA answer and fails closed if any answer
is unsafe, then pins the TLS connection to a validated address while preserving
the original hostname for SNI, certificate verification, and the `Host` header.

This closes DNS rebinding: a name that resolves safely during the check and to
`169.254.169.254` a moment later cannot be used, because the connection goes to
the address that was checked.

Redirects are never followed. Responses are size- and time-bounded.

---

## Headers

```text
Content-Type:      application/json
User-Agent:        Nyst-Decision-Webhook/0.2.2
X-Nyst-Event-Id:   <uuid>
X-Nyst-Timestamp:  2026-08-11T12:34:56.789Z      ← ISO-8601, not unix seconds
X-Nyst-Signature:  v1=<hex hmac-sha256>
```

The signed message is:

```text
<timestamp>.<event-id>.<raw-body>
```

Note that the event id is part of the signed message. A verifier that omits it
will reject every genuine delivery.

---

## Verifying

Use the SDK. It implements exactly the server's construction, and a test in the
Nyst repository asserts the two produce byte-identical signatures.

```ts
import { verifyWebhook } from "@nyst-ai/sdk";

app.post("/nyst", async (request, reply) => {
  const ok = verifyWebhook(
    process.env.NYST_WEBHOOK_SECRET!,
    request.headers["x-nyst-timestamp"] as string,
    request.rawBody,                                   // RAW bytes
    request.headers["x-nyst-signature"] as string,
    Date.now(),
    request.headers["x-nyst-event-id"] as string,      // part of the signed message
  );
  if (!ok) return reply.code(401).send();

  // Deduplicate BEFORE processing, atomically.
  const fresh = await recordEventIdIfNew(request.headers["x-nyst-event-id"]);
  if (!fresh) return reply.code(200).send();           // already handled

  await handle(JSON.parse(request.rawBody));
  return reply.code(200).send();
});
```

Three things go wrong most often:

1. **Using a re-serialised body.** `JSON.stringify(request.body)` produces
   different bytes from what was signed — different key order, different
   whitespace — and the signature will not match. You need the raw body. In
   Fastify, add a content-type parser that keeps it; in Express, use
   `express.raw()` or `verify` on the JSON parser.
2. **Omitting the event id** from the signed message.
3. **Comparing signatures with `===`.** Use a constant-time comparison. The
   SDK's `verifyWebhook` does, including a length check first, since
   `timingSafeEqual` throws on a length mismatch.

Deliveries outside a **five-minute** window are rejected. This bounds replay,
and it means your receiver's clock has to be roughly right.

---

## Delivery semantics

**At-least-once.** A response can be lost after your endpoint has already
committed, so Nyst will retry something you have already handled. Deduplicate
on `X-Nyst-Event-Id`, atomically, before processing.

- Stable event and attempt IDs.
- Durable leases, so two workers never deliver the same event concurrently.
- Bounded exponential backoff, capped at 300 seconds.
- Terminal after 6 attempts. The event stays in the database as a failed
  delivery; it is not silently discarded.
- Success is any 2xx.

Return 2xx as soon as you have **durably** recorded the event. Do the work
afterwards. An endpoint that does slow work before responding will time out and
be retried, which is the exact situation deduplication exists for — but it is
better not to create it.

---

## Payload

```json
{
  "event_id": "…",
  "event_type": "effect.resolved",
  "occurred_at": "2026-08-11T12:34:56.789Z",
  "action_id": "…",
  "resolution_id": "…",
  "resolution_sequence": 2,
  "effect_state": "satisfied_unattributed",
  "primary_directive": "do_not_retry"
}
```

Fetch the full resolution, its evidence, or the signed receipt with the action
id when you need more than the summary.

Order is not guaranteed across events. `resolution_sequence` is monotonic per
action: ignore an event whose sequence is lower than one you have already
processed for that action.

---

## Webhooks and Slack

Slack notifications are **links only** and change no state. An approval that
can be granted by anyone able to post in a channel is not an approval. Human
review happens in the dashboard, where the operations offered are exactly those
the effective authority permits.
