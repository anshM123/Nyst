# Secrets and credential references

Nyst never stores a provider credential. It stores an **opaque reference**, and
resolves that reference to a value only at the moment of use, in memory, in the
process that needs it.

```
env:NYST_GITHUB_TOKEN          ← what Nyst stores
ghp_xxxxxxxxxxxxxxxxxxxx       ← what Nyst never stores, logs, signs or returns
```

---

## Where a resolved secret must never go

This list is a hard rule, not a guideline. A resolved secret must never enter:

- the database
- evidence
- a receipt
- a log line
- action input
- a webhook payload
- the browser
- a metric
- the Protection Report
- a Proof Pack

Three mechanisms enforce it rather than merely encourage it:

1. **Provider clients resolve their own credential internally and never return
   it.** There is no code path that hands a secret back to a caller who might
   persist it.
2. **Structured logging redacts by key name** (`secret`, `token`, `password`,
   `credential`, `authorization`, `private_key`, `api_key`) at the point of
   serialisation. This is belt-and-braces: Nyst does not log credentials in the
   first place.
3. **`NYST_DEBUG_LOG_CREDENTIALS` is a startup failure**, in every environment.
   It is not a supported debugging mode.

---

## The reference format

```
scheme:path
```

where `scheme` is `env`, `vault`, or `secret-manager`, and `path` matches
`[A-Za-z0-9_./:-]{3,280}` — no whitespace, no control characters.

References are validated on input, stored verbatim, and displayed verbatim.
They are safe to show in the dashboard, put in an error message, and include in
an audit record, because they are not secret. That is the point of having them.

---

## The interface

```ts
export interface SecretProvider {
  /**
   * Resolve an opaque reference to a secret value.
   * Treat the return value as write-only: pass it to the provider client and
   * never persist, serialize, or log it.
   *
   * @throws SecretResolutionError when the reference cannot be resolved.
   */
  resolve(reference: SecretReference): Promise<string>;
}
```

One method. That is the whole extension surface.

`SecretResolutionError` carries a category — `malformed_reference`,
`unknown_scheme`, `not_found`, `provider_unavailable` — and the **reference**.
It never carries the value. The category is what surfaces in the Integrations
view as an honest failure reason.

---

## Bundled implementations

| Implementation | Resolves | Use |
| --- | --- | --- |
| `EnvSecretProvider` | `env:NAME` from the process environment | The production default |
| `TestSecretProvider` | An in-memory map | Tests |
| `DeniedSecretProvider` | Nothing — throws for every reference | Failure Lab and Demo |

`DeniedSecretProvider` is worth dwelling on. The Failure Lab is a simulation,
so it must not be able to touch a real provider. Rather than trusting the
simulation code not to, Nyst gives it a secret provider that **cannot resolve
anything at all**. Reaching a real credential from a simulation is structurally
impossible, not merely against the rules.

### Why no AWS / GCP / Vault adapters ship

Because we cannot test them here, and an untested integration with a secret
store is worse than no integration: it looks like a supported path and fails at
the worst possible moment. Writing them for appearance would be exactly the
kind of unearned claim this product argues against.

The extension mechanism is documented instead, and it is one method.

---

## Writing your own provider

```ts
import type { SecretProvider, SecretReference } from "nyst/product/secretProvider";
import { assertSecretReference, SecretResolutionError } from "nyst/product/secretProvider";

export class VaultSecretProvider implements SecretProvider {
  constructor(private readonly client: VaultClient) {}

  async resolve(reference: SecretReference): Promise<string> {
    assertSecretReference(reference);                       // format, before anything else
    if (!reference.startsWith("vault:")) {
      throw new SecretResolutionError("unknown_scheme", reference);
    }
    const path = reference.slice("vault:".length);
    try {
      const value = await this.client.read(path);           // your client, your auth
      if (typeof value !== "string" || value.length === 0) {
        throw new SecretResolutionError("not_found", reference);
      }
      return value;
    } catch (error) {
      if (error instanceof SecretResolutionError) throw error;
      // Never let the underlying error escape: it may quote the value.
      throw new SecretResolutionError("provider_unavailable", reference);
    }
  }
}
```

Then pass it where `EnvSecretProvider` is constructed in
`scripts/startProduct.ts`:

```ts
const secrets = new VaultSecretProvider(vaultClient);
```

Nothing else changes. Every consumer depends on the interface.

Four rules for any implementation:

1. **Validate the reference format first.** `assertSecretReference` exists for
   this and throws the right typed error.
2. **Never include the resolved value in an error, a log, or a stack trace.**
   Wrap the underlying error rather than rethrowing it — client libraries
   sometimes quote the response body.
3. **Fail closed.** A provider that returns `""` on failure will produce a
   confusing authentication error at the provider instead of a clear
   `not_found` at the boundary.
4. **Cache carefully or not at all.** A cached secret survives rotation. If you
   cache, bound it by time and make the bound shorter than your rotation
   interval.

---

## Rotation

1. Write the new value at the same reference in your secret store.
2. Restart the web and worker processes, or wait out your provider's cache.
3. Run a **preflight** from **Integrations**. It is a bounded, read-only probe
   that reports the account identity it reached, and it is rejected outright if
   it ever reports having mutated provider state.
4. Confirm the readiness dimension turns green with a fresh timestamp.

Preflight results have a 12-hour validity window. A green tick from last week
is not evidence that a credential works today, so Nyst expires it rather than
letting it decay into a comforting lie.

Nyst never needs to be reconfigured for a rotation, because the reference did
not change. That is the reason for the indirection.

---

## Credentials Nyst does not require

Nyst does **not** require credentials for providers you have not enabled.
Configuration validation checks the integrations that are actually configured.
An organization using only the GitHub EffectSpec never needs an Okta token, and
production startup will not demand one.
