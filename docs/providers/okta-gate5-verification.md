# Gate 5 Okta verification

Gate 5 passed and was frozen on 2026-08-08.

## Live fixture

- Tenant: `integrator-5013236.okta.com`
- Client: `0oa165m8x82tAfVEo698`
- Synthetic fixture user: `00u165mdigjjALY0c698`
- Observed login: `nyst-fixture@gmail.com`
- Required and final state: `ACTIVE`
- OAuth scopes: exactly `okta.users.manage okta.roles.read`
- Custom-role permissions were not broadened.
- Corrected resource topology: `Users -> Nyst Gate 5 Fixture Users` and `All Identity and Access Management resources`; the incorrect Groups resource was removed.
- Admin-console inspection found no individually assigned or group-derived administrator privilege on the fixture user.

## Live canaries

The normal canary independently observed `ACTIVE`, performed one suspend action, independently observed `SUSPENDED`, reconciled and signed the result, then used a separate action to restore and independently confirm `ACTIVE`.

The response-loss canary performed one real suspend request, deliberately discarded the successful provider response, recovered from the same PostgreSQL action, independently observed `SUSPENDED`, reconciled without redispatch, and used a separate action to restore `ACTIVE`.

- Controlled lifecycle writes: 4 total across two suspends and two separate restorations.
- Maximum writes for one ambiguous logical action: 1.
- Unsafe redispatches: 0.
- Unsafe continuations: 0.
- False-certainty findings after fixes: 0.
- Signed resolutions: produced and signature-verified.
- Final fixture state: independently confirmed `ACTIVE`.

Because Gate 5 intentionally does not request Okta System Log correlation scope, exact goal presence is reported as `satisfied_unattributed`, never falsely upgraded to `verified`.

## Clean-room verification

- Fresh database: `outcome_gate5_cleanroom_20260808_1605`
- Dependencies: `npm ci`, 17 packages, 0 vulnerabilities
- Migrations: `0001_init.sql` through `0004_action_immutability.sql` from zero
- Strict typecheck: pass
- Build: pass
- Complete Gate 1–5 suite: 305 passed, 0 failed, 0 skipped, 59 suites
- PostgreSQL integration, property/model tests, stress tests, direct database attacks, signer/DB failure recovery, malicious-adapter tests, and DPoP nonce safety: pass

## Defects and fixture correction

Product defects fixed during Gate 5 include explicit-port origin validation, observe-only boundary truth, malformed/oversized POST ambiguity classification, Node strip-types compatibility, DPoP proof support, and bounded DPoP nonce handling that never automatically resends a lifecycle POST. Each product defect has regression coverage.

The final live authorization failure was not a product defect. The Okta custom role had the intended permissions, but the resource set selected a Groups resource where lifecycle authorization required a Users resource. Correcting that least-privilege binding made the exact preflight and live canaries pass without broader OAuth scopes or Super Admin.

## Credential and secret handling

The private RSA JWK was ingested through a Git-ignored temporary file, validated without printing private parameters, and used to mint a one-hour DPoP-bound token. After authentication succeeded, the file was securely deleted. The access token and DPoP private key remained only in the credential-host process, which was stopped after verification.

Final scans found zero raw Okta credential material in the workspace, PowerShell history, or clean-room PostgreSQL dump. `.secrets/` remains ignored and the temporary JWK no longer exists.
