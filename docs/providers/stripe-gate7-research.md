# Gate 7 Stripe provider research

Research date: 2026-08-08. Only current official Stripe documentation was used. The latest generally available API version visible in the official versioning/changelog pages was `2026-02-25.clover`; Gate 7 pins that exact value instead of inheriting an account default.

## Official sources consulted

- Authentication and key handling: https://docs.stripe.com/api/authentication and https://docs.stripe.com/keys
- Versioning and changelog: https://docs.stripe.com/api/versioning and https://docs.stripe.com/changelog/clover
- Idempotency and error semantics: https://docs.stripe.com/api/errors
- Request identifiers: https://docs.stripe.com/api/request_ids
- Rate limits: https://docs.stripe.com/rate-limits
- Sandboxes and test data: https://docs.stripe.com/sandboxes and https://docs.stripe.com/testing
- Refund creation and object shape: https://docs.stripe.com/api/refunds/create and https://docs.stripe.com/api/refunds/object
- Refund lifecycle/events: https://docs.stripe.com/refunds
- PaymentIntent capture: https://docs.stripe.com/api/payment_intents/capture
- Separate authorization/capture: https://docs.stripe.com/payments/place-a-hold-on-a-payment-method
- PaymentIntent lifecycle: https://docs.stripe.com/payments/paymentintents/lifecycle
- Webhook delivery behavior: https://docs.stripe.com/webhooks

## Findings that bind the v1 design

- Stripe secret keys are server-side credentials; test/sandbox secret keys use `sk_test_` and restricted test keys use `rk_test_`. Nyst accepts only those test prefixes, persists the opaque reference `env:NYST_STRIPE_CREDENTIAL`, and resolves the key from the `NYST_STRIPE_API_KEY` process environment variable at request time. Live keys are rejected before network access.
- Requests use HTTPS and pin `Stripe-Version: 2026-02-25.clover`. Response `Request-Id` is useful audit correlation but is not independent proof that the intended external effect exists.
- Stripe stores the first result for an idempotency key, including failures such as `500`, and rejects reuse with different parameters. Nyst persists one action-derived idempotency key in the DispatchPlan before consequence and reuses it for the same logical operation. Provider idempotency reduces duplicate risk but does not replace read-back and reconciliation.
- A refund can target a PaymentIntent or Charge and may be partial. Multiple partial refunds can exist until the charge is fully refunded. Refund status can be `pending`, `requires_action`, `succeeded`, `failed`, or `canceled`; live refunds can change after an initially successful-looking response. Gate 7 v1 therefore supports only an exact full refund of one known, already-succeeded, test-mode PaymentIntent/latest Charge with no preexisting partial-refund topology.
- The full-refund goal is established from an independent PaymentIntent/Charge read plus the bounded refund inventory. A succeeded full refund with Nyst action metadata can be attributed; exact goal state without Nyst metadata is `satisfied_unattributed`; pending or requires-action refunds remain `pending`; failed/canceled or inconsistent inventories fail closed.
- Manual capture applies only when the PaymentIntent is `requires_capture`. The default capture takes the full capturable amount; partial capture usually releases the remainder and multicapture is capability-dependent. Gate 7 v1 supports exactly one final full capture of a test-mode card PaymentIntent whose amount received is zero and whose full amount is capturable. Partial capture, multicapture, overcapture, Connect, automatic-delayed capture, and asynchronous payment methods are unsupported.
- A successful full capture is independently established from the PaymentIntent: `status=succeeded`, exact currency/amount received, zero capturable amount, and stable latest Charge identity. Matching action metadata can support attribution. `processing` remains pending; canceled, expired, already/partially captured, or wrong-status topologies fail closed.
- Stripe sandboxes do not move real money. Every live Gate 7 canary must require `livemode=false` provider objects and a test/restricted-test key. No code path accepts `sk_live_` or `rk_live_`.
- Stripe rate limiting uses `429`; the `Stripe-Rate-Limited-Reason` header distinguishes limiters, while a `429` without that header can be a lock timeout. Gate 7 treats every `429` as non-truth and persists only a bounded observation recheck hint; it never blindly redispatches a financial mutation.
- Webhooks can be duplicated, retried, and delivered out of order. Gate 7 v1 does not rely on webhook arrival for truth. It uses direct provider reads; future webhook evidence must be signature-verified, deduplicated by event ID, and reconciled against current objects.

## Explicitly unsupported in v1

Live mode; Connect; destination charges; application-fee refunds; transfer reversal; customer-balance refunds; partial refunds; multiple-refund aggregation; partial/multiple/overcapture; non-card or asynchronous capture; PaymentIntents without a stable latest Charge; refund `requires_action`; expired authorizations; and any object or response whose identity, currency, amount, mode, status, metadata, or topology cannot be established exactly.
