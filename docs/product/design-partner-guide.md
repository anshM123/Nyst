# Nyst v0.2 design-partner guide

Nyst is the safety control plane between autonomous software and the systems it changes. The product path is `CONNECT → ROUTE → CONTROL → RECOVER → PROVE`; the runtime remains `intent → execution → observation → reconciliation → effect state → control decision → signed receipt`.

## Start safely

1. Bootstrap an organization, project, and environment.
2. Configure an opaque provider credential reference; Nyst never stores the credential itself.
3. Enable the exact EffectSpec version for the environment.
4. Begin in **Shadow**. Shadow records what Nyst detected and what it would have blocked. It never claims to have prevented an effect.
5. Review action evidence, policies, and Failure Lab scenarios.
6. Move to **Enforced** only after explicit confirmation. Enforced actions receive an immutable environment-mode and policy-version snapshot before provider preparation.

Policies may require approval and may disable continuation or compensation. They cannot permit retry, continuation, compensation, or certainty beyond the frozen runtime safety floors.

## Gateway SDK

```ts
import { NystClient } from "@nyst-ai/sdk";

const nyst = new NystClient({ baseUrl: process.env.NYST_URL!, apiKey: process.env.NYST_API_KEY! });
const result = await nyst.actions.execute({
  effect: "github.repository_permission_change",
  businessKey: "access-change:123",
  input: { /* exact EffectSpec input */ },
});
```

Treat the returned `EffectState` and `ControlDecision` as separate axes. Never reinterpret a transport failure as `not_applied`, and never retry unless the current signed decision explicitly permits it.

## Failure Lab, Demo, and review

Failure Lab uses deterministic seeded simulations. It is available only in Shadow or demo environments, has no provider credential path, and labels all output `SIMULATED`. Demo state is isolated from production action and impact metrics.

Reviewers may acknowledge an incident or request another observation. The re-observation worker performs reconciliation only and has no dispatch path. Human review cannot forge evidence, change an EffectState, bypass a safety floor, approve a consequence, or force continuation.

Automatic recovery is deliberately narrow. A worker may execute only an explicitly registered recovery operation whose current signed resolution, durable sequence binding, historical policy snapshot, tenant scope, and EffectSpec still authorize it. An ambiguous downstream execution is never redispatched. The integrated offboarding continuation suspends the Okta identity first, then removes GitHub access, because the second consequence is guarded by current signed proof that identity capability is already disabled.
