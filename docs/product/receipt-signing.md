# Receipt signing

Every resolution Nyst reaches is recorded as a **receipt**: the effect state,
the control decision, the evidence it cited, the policy and EffectSpec versions
that governed it, and an Ed25519 signature over the whole document.

---

## What a signature does and does not prove

**It proves tamper evidence.** If a byte of the resolution changes after
signing, verification fails. Anyone holding the public key can check this,
offline, at any time, without asking Nyst.

**It does not prove:**

- **Hardware protection.** There is no HSM. The private key is a software key
  held in the process environment. If the machine is compromised, the key is
  compromised, and an attacker can sign whatever they like.
- **Hardware attestation.** Nothing attests that the code that produced the
  receipt was the code you think it was.
- **Trusted timestamping.** The `resolved_at` timestamp comes from the local
  system clock, which is marked `trusted: false` in the receipt itself. It is
  not countersigned by a time authority, and nothing prevents a compromised
  host from backdating it.

Nyst states these limits in the receipt structure, in the dashboard, and here,
because a signature that is quietly weaker than it appears is worse than no
signature at all — it converts uncertainty into misplaced confidence.

What a receipt is genuinely good for: showing an auditor what Nyst decided and
why, and proving that record has not been edited since.

---

## The identity must persist

> A receipt signed by a key that no longer exists is not proof of anything.

This is the whole of Phase 28 in one sentence. If the process generates a fresh
key at boot, then yesterday's receipts cannot be verified today — not by you,
not by an auditor, not by Nyst itself. The signature becomes decorative.

Production therefore **refuses to start** if:

| Condition | Why it is rejected |
| --- | --- |
| `NYST_LOCAL_EPHEMERAL_SIGNING=true` | A per-boot identity cannot verify yesterday's receipts |
| `OUTCOME_SIGNING_KEY_ID` missing | Nothing identifies which key signed what |
| `OUTCOME_SIGNING_PRIVATE_KEY_B64` missing | Nothing to sign with |
| `OUTCOME_SIGNING_KEY_ID` is a known development id | `dev-local-1`, `test`, `local`, `changeme`, … must never sign production receipts |

Development is a different matter: `NYST_LOCAL_EPHEMERAL_SIGNING=true` is
supported and convenient, and is rejected only under `NODE_ENV=production`.

---

## Generating an identity

```bash
node --experimental-strip-types scripts/genkeys.ts
```

```
OUTCOME_SIGNING_KEY_ID=...
OUTCOME_SIGNING_PRIVATE_KEY_B64=...    # base64 PKCS8 — this is the secret
OUTCOME_SIGNING_PUBLIC_KEY_B64=...     # base64 SPKI  — distribute freely
```

Choose a `KEY_ID` that means something to you (`nyst-prod-2026-01`), because it
is how you will later tell which key signed which receipt.

Put the private key in your secret store. It is the most sensitive value in a
Nyst deployment: it does not grant access to any provider, but it is the thing
that makes your audit trail worth anything.

Both the web host and the worker host need it — both write resolutions.

---

## Verifying a receipt

Through the API:

```
GET /v1/actions/{id}/receipt   →  { receipt, signature_valid }
GET /exports/{id}              →  the same, as a downloadable attachment
```

In the dashboard: **Receipts**, which shows the signature status and offers
**Export JSON**.

Offline, with the public key, using any Ed25519 implementation — this is the
point of publishing the public key. Verification does not require Nyst to be
running, or to be honest.

---

## Rotation

Signing keys rotate forward, and **old receipts keep verifying under the key
that signed them**. Nyst does not re-sign history: re-signing would destroy
the very property a signature provides.

1. Generate a new identity with a new `KEY_ID`.
2. Publish the new public key alongside the old one. Verifiers need both.
3. Set the new `KEY_ID` and private key on the web and worker processes and
   restart them.
4. Keep every retired **public** key indefinitely. Receipts signed by a key
   whose public half you discarded become unverifiable.

The private half of a retired key can and should be destroyed once no process
uses it.

---

## Backup and restore

Receipt verification after a restore is the sharpest possible test of whether
your signing identity really persisted, which is why
[the backup and restore drill](backup-and-restore.md) verifies exactly that:
restore into a different database, start Nyst against it, and re-verify a
receipt signature.

If it fails there, it was always going to fail for an auditor.
