# The customer-side Relay

Some customers cannot give Nyst a provider credential. That is a reasonable
position, not an obstacle to route around, so Nyst supports a Relay: a small
service the customer runs inside their own network, holding their credentials,
performing narrowly scoped reads that Nyst asks for by signed request.

## The protocol

1. **Nyst issues a RelayRequest.** One operation, one subject, one property,
   one nonce, an expiry no more than ten minutes out, signed with Nyst's
   Ed25519 key. It is persisted before it is sent.
2. **The Relay verifies** the signature against Nyst's published key, checks the
   expiry, and checks the operation is one it is configured to perform. It
   refuses anything else.
3. **The Relay performs the read** against the provider, using a credential
   Nyst never sees and never stores.
4. **The Relay pushes the result** back through the Evidence Ingest API,
   echoing the nonce.
5. **Nyst accepts the nonce exactly once.** A replayed response is refused, and
   the refusal says whether it was a replay, an expiry, or an unknown nonce —
   an operator should not have to guess which.

A response about a different subject or property than the one requested is
rejected and durably marked as such.

## Authentication model

- **Nyst to Relay**: Ed25519 signature over the canonical request payload. The
  Relay verifies against Nyst's published verification key.
- **Relay to Nyst**: the registered evidence source's HMAC-SHA256 shared secret,
  resolved through the SecretProvider by opaque reference. Nyst never stores the
  secret itself.
- **Replay protection**: a single-use nonce, consumed atomically, unique per
  environment.
- **Scope**: every request names one environment, one subject and one property,
  and the source must be registered as permitted to report that property.

## What is NOT implemented

**Consequential mutation through the Relay is not implemented in v0.3.0.**

This is a deliberate omission rather than an oversight. A mutation Relay needs:

- a durable dispatch boundary on the *customer* side, written before the
  provider call, so a crash mid-request is distinguishable from a request that
  never started;
- a two-phase protocol for the ambiguous window, so Nyst can establish what
  happened when the Relay disappears between the send and the acknowledgement;
- a read-back path Nyst can drive independently, because a Relay that is down is
  exactly when you most need to know what it did.

Shipping a partial version of that would put a duplicate external consequence
precisely where this product promises there is none. Every operation in
`RELAY_OPERATIONS` is therefore an observation, and a test asserts it.

## Reference implementation

`scripts/referenceRelay.ts` is a minimal, dependency-free Relay that verifies a
request, performs a read through an injected reader, and pushes the result back.
It is a reference for customers writing their own, not a supported product
component.
