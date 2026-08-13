/**
 * REFERENCE CUSTOMER-SIDE RELAY.
 *
 * A minimal, dependency-free implementation of the Relay protocol, written to
 * be read rather than deployed. A customer running this in their own network
 * keeps their provider credentials there: Nyst sends a signed, scoped,
 * single-use READ request, and gets back an observation.
 *
 * It refuses, loudly, anything that is not an observation. See
 * docs/product/relay.md for why mutation is not part of this release.
 *
 * Run:  npx tsx scripts/referenceRelay.ts --once
 */
import { createHmac } from "node:crypto";
import { canonicalJson } from "../src/core/canonical.js";
import { RELAY_OPERATIONS, canonicalPushBody, type RelayOperation, type RelayRequestPayload }
  from "../src/product/outcome/evidenceIngest.js";
import type { FactValue } from "../src/product/outcome/invariantEngine.js";

/** Verifies a Nyst signature. Supplied by the host so this file stays pure. */
export interface RequestVerifier {
  verify(payload: unknown, signature: { key_id: string; signature_b64: string }): boolean;
}

/** Performs one read inside the customer's network. READ ONLY. */
export type ProviderReader = (request: {
  operation: RelayOperation; subject_ref: string; property: string;
}) => Promise<FactValue>;

export interface RelayConfig {
  source_key: string;
  /** The HMAC secret shared with Nyst. Never leaves this process. */
  push_secret: string;
  /** Which operations this Relay is configured to perform. */
  permitted_operations: readonly RelayOperation[];
}

export class RelayRejected extends Error {
  constructor(message: string) { super(message); this.name = "RelayRejected"; }
}

/**
 * Handle one request.
 *
 * Every refusal below is one the CUSTOMER's side makes. Nyst asking for
 * something out of scope is not a reason to comply.
 */
export async function handleRelayRequest(input: {
  request: RelayRequestPayload;
  signature: { key_id: string; signature_b64: string };
  config: RelayConfig;
  verifier: RequestVerifier;
  reader: ProviderReader;
  now?: Date;
}): Promise<{ push: Record<string, unknown>; signature: string }> {
  const now = input.now ?? new Date();

  if (!input.verifier.verify(input.request, input.signature)) {
    throw new RelayRejected("The request signature did not verify against Nyst's published key");
  }
  if (new Date(input.request.expires_at).getTime() <= now.getTime()) {
    throw new RelayRejected("The request has expired. A stale scoped request is a capability nobody should still hold.");
  }
  if (!(RELAY_OPERATIONS as readonly string[]).includes(input.request.operation)) {
    throw new RelayRejected(`Unknown operation: ${input.request.operation}`);
  }
  if (!input.config.permitted_operations.includes(input.request.operation)) {
    throw new RelayRejected(
      `This Relay is not configured to perform ${input.request.operation}. It performs: ${input.config.permitted_operations.join(", ")}.`);
  }
  // Belt and braces: this Relay performs reads. If a future protocol version
  // introduced anything else, this refuses it rather than attempting it.
  if (!input.request.operation.startsWith("observe_")) {
    throw new RelayRejected("This Relay performs observations only, and that operation is not one");
  }

  const value = await input.reader({
    operation: input.request.operation,
    subject_ref: input.request.subject_ref,
    property: input.request.property,
  });

  const push = {
    source_key: input.config.source_key,
    event_id: `relay-${input.request.relay_request_id}`,
    subject_ref: input.request.subject_ref,
    property: input.request.property,
    value,
    observed_at: now.toISOString(),
    fresh_until: new Date(now.getTime() + 900_000).toISOString(),
    provenance: { relay: true, nonce_echo: input.request.nonce, operation: input.request.operation },
  };
  const signature = createHmac("sha256", input.config.push_secret)
    .update(canonicalPushBody(push as never)).digest("hex");
  return { push: { ...push, signature, nonce: input.request.nonce }, signature };
}

if (process.argv.includes("--once")) {
  // Demonstration only: no credential, no network, no provider.
  console.log("Nyst reference Relay — protocol demonstration");
  console.log("Permitted operations:", RELAY_OPERATIONS.join(", "));
  console.log("Every one of them is an observation. Mutation is not implemented; see docs/product/relay.md.");
  console.log("Canonical request shape:", canonicalJson({
    relay_request_id: "<uuid>", operation: "observe_github_effective_permission",
    operation_key: "<stable key>", environment_id: "<uuid>",
    subject_ref: "github:acme/production:alice", property: "effective_permission",
    nonce: "<48 hex chars>", issued_at: "<iso>", expires_at: "<iso, at most 10 minutes>",
  }));
}
