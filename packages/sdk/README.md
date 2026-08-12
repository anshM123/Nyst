# @nyst-ai/sdk

Client for **Nyst** — effect-control infrastructure for autonomous software.

Nyst sits between your software and the systems it changes. After a
consequential action it determines **what external effect actually happened**,
and decides **what is safe to do next**.

```
INTENT → EXECUTION → OBSERVATION → RECONCILIATION → EFFECT STATE → CONTROL DECISION → SIGNED RECEIPT
```

Requires Node 22 or newer. No runtime dependencies.

```bash
npm install @nyst-ai/sdk
```

## The problem this solves

Your agent calls an API to revoke someone's access. The connection drops. You
do not know whether the revocation landed.

Retrying might double-charge, double-provision, or re-trigger a workflow.
Not retrying might leave a former employee with production access. Guessing is
the failure mode, and "the call threw an exception" tells you nothing about the
external world.

Nyst answers the question you actually have: *did the effect happen?* — and
then separately: *what may I do now?*

## Two axes, never collapsed

`EffectState` is **what Nyst knows**. There are exactly six, and there will not
be a seventh:

| State | Meaning |
| --- | --- |
| `verified` | The intended effect occurred exactly as intended. |
| `not_applied` | Sufficient evidence that the effect did **not** occur. |
| `pending` | Resolution is still underway. |
| `compensated` | The effect occurred undesirably and has been reversed. |
| `satisfied_unattributed` | The desired end state exists, but this action's causation is unproven. |
| `unprovable` | Nyst cannot determine what happened with sufficient evidence. |

`ControlDecision` is **what your software may do next** — a `primary` directive
plus independent `retry`, `continuation` and `recovery` dispositions.

There is no global mapping from one to the other. The instructive case:
`satisfied_unattributed` yields `do_not_retry` with `retry: forbidden` and
`continuation: allowed`. The access is gone, so carry on — but you must not
re-send, because you cannot prove you were the one who removed it.

## Quickstart

```ts
import { NystClient } from "@nyst-ai/sdk";

const nyst = new NystClient({
  baseUrl: process.env.NYST_URL!,
  apiKey: process.env.NYST_API_KEY!,
});

const result = await nyst.execute({
  effect: "github.repository_permission_change",
  businessKey: "offboard:alice@example.com:acme/api",
  input: { repository_id: "acme/api", principal_id: "alice", desired_permission: "none" },
});

const { effect, control } = result.resolution;
console.log(effect.state, "→", control.primary, control.explanation);
```

## Acting on the answer

Read the dispositions. Do not re-derive them.

```ts
import { mayContinue, mayRetry, needsHuman } from "@nyst-ai/sdk";

const { control } = result.resolution;

if (needsHuman(control)) {
  await pageOncall(result.action_id, control.explanation);
} else if (mayContinue(control)) {
  await nextStep();
} else if (mayRetry(control)) {
  await retryOnce();
}
```

`mayRetry` returns true **only** for `retry: "allowed"`. `retry: "unknown"` is
not permission — it is the explicit statement that permission could not be
established, and it must be treated as a refusal.

## Ambiguity is an answer, not an error

`pending` with `hold` is Nyst working correctly. It means the external world
has not settled yet. Poll, or subscribe to a decision webhook:

```ts
let resolution = result.resolution;
while (resolution.effect.state === "pending") {
  await new Promise((r) => setTimeout(r, 5_000));
  ({ resolution } = await nyst.reconcile(result.action_id));
}
```

## Verifying a decision webhook

Nyst signs every delivery. Verify with the **raw** request body — re-serialising
a parsed object changes the bytes and the signature will not match.

```ts
import { verifyWebhook } from "@nyst-ai/sdk";

app.post("/nyst/decisions", (request, reply) => {
  const ok = verifyWebhook(
    process.env.NYST_WEBHOOK_SECRET!,
    request.headers["x-nyst-timestamp"] as string,
    request.rawBody,                        // raw bytes, not JSON.stringify(request.body)
    request.headers["x-nyst-signature"] as string,
  );
  if (!ok) return reply.code(401).send();
  // ...
});
```

Deliveries are at-least-once. Deduplicate on `action_id` plus
`resolution_version`.

## Shadow mode

Before Nyst controls anything, you can send it what your software observed and
what it was about to do. Nyst applies the real EffectSpec semantics and reports
what Enforced Mode **would** have decided. It controls nothing.

```ts
await nyst.evaluateShadow({
  effect: "github.repository_permission_change",
  businessKey: "offboard:alice@example.com:acme/api",
  observation: {
    transport: "ambiguous",
    authoritative_goal_observed: null,
    attempted_retry: true,
    attempted_continuation: false,
  },
});
```

## Errors

Non-2xx responses throw `NystApiError` carrying `status`, the parsed
`response`, and the server's `requestId` when present.

```ts
import { NystApiError } from "@nyst-ai/sdk";

try {
  await nyst.execute(input);
} catch (error) {
  if (error instanceof NystApiError && error.status === 429) { /* back off */ }
  throw error;
}
```

## Examples

`examples/basic.ts` is a complete, runnable program.

## What this package is not

It holds no safety logic. It does not cache, infer, or soften a decision, and
it has no way to override one — there is no force-continue, here or anywhere
else in Nyst. Every judgement comes from the control plane, which is the only
place that can see the evidence.
