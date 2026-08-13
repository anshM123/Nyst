/**
 * THE EVIDENCE ADAPTER, THE INGEST API, AND THE RELAY.
 *
 * Nyst cannot build a first-party integration for every system a company runs,
 * and pretending otherwise is how a safety product ends up with confident
 * blind spots. So there are three ways an observation can reach the outcome
 * layer, and all three land in the same normalized shape:
 *
 *   FIRST-PARTY     Nyst holds a credential and reads the provider itself.
 *   EVIDENCE INGEST the customer pushes observations from their own systems.
 *   RELAY           Nyst asks a customer-side agent to perform a scoped read
 *                   inside the customer's network, so credentials never leave.
 *
 * THE LINE THAT MATTERS, restated because it is the whole design:
 *
 *     A customer pushes EVIDENCE. Nyst evaluates TRUTH.
 *
 * There is no field in this module for "this outcome is verified". A customer
 * can tell Nyst that their VPN reports Alice's session is inactive; they cannot
 * tell Nyst that Alice is offboarded. The first is a fact Nyst will weigh; the
 * second is a conclusion Nyst has to reach itself, or the receipt is worthless.
 *
 * THE ADAPTER PRODUCES EVIDENCE. IT DOES NOT SET A VERDICT.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ProductDb } from "../productRepository.js";
import type { TenantScope } from "../types.js";
import type { SecretProvider } from "../secretProvider.js";
import type { Signer } from "../../core/signing.js";
import type { FactValue } from "./invariantEngine.js";
import type { OutcomeRepository } from "./outcomeRepository.js";

/* ========================================================= THE ADAPTER */

/** Where an observation came from. Never a synonym for how much to trust it. */
export type EvidenceSourceType =
  | "provider_api_read" | "audit_log" | "provider_webhook"
  | "evidence_ingest" | "customer_relay" | "cloud_native" | "effectspec_observation";

/**
 * One normalized observation, whatever produced it.
 *
 * Every field an invariant needs in order to decide whether it may rely on
 * this. Notably absent: any notion of a conclusion.
 */
export interface NormalizedEvidence {
  source_type: EvidenceSourceType;
  /** The registered source, for ingest and relay. Null for first-party reads. */
  evidence_source_id: string | null;
  subject_ref: string;
  provider: string;
  property: string;
  value: FactValue;
  observed_at: string;
  fresh_until: string;
  /** Authoritative for THIS property, or corroborative. Decided by config, not by the pusher. */
  authoritative: boolean;
  provenance: Record<string, unknown>;
  adapter_version: string;
}

/**
 * The contract every evidence producer implements.
 *
 * A scoped observation request in, normalized evidence out. An adapter never
 * decides an outcome, never writes a verdict, and never returns a boolean
 * "satisfied".
 */
export interface EvidenceAdapter {
  name: string;
  /** Properties this adapter can observe. Anything else is refused. */
  supported_properties: readonly string[];
  observe(request: { subject_ref: string; property: string }): Promise<NormalizedEvidence>;
}

export class EvidenceRejected extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.name = "EvidenceRejected"; this.statusCode = statusCode; }
}

/* =========================================================== INGEST API */

export interface EvidenceSourceInput {
  source_key: string;
  display_name: string;
  transport: "evidence_ingest" | "customer_relay";
  permitted_properties: readonly string[];
  authoritative?: boolean;
  adapter_version: string;
  signing_secret_ref?: string | null;
  default_freshness_seconds?: number;
}

export interface EvidencePush {
  source_key: string;
  /** The customer's identifier for this observation event. Idempotency key. */
  event_id: string;
  subject_ref: string;
  property: string;
  value: FactValue;
  observed_at: string;
  fresh_until?: string;
  provenance?: Record<string, unknown>;
  /** Hex HMAC-SHA256 over the canonical push body, when the source is signed. */
  signature?: string;
}

/** Fields a customer may never push. Each would be Nyst laundering their claim. */
const FORBIDDEN_PUSH_FIELDS = [
  "verdict", "outcome", "satisfied", "verified", "effect_state",
  "control_decision", "authoritative", "conclusion",
] as const;

export class EvidenceIngest {
  constructor(
    private readonly db: ProductDb,
    private readonly outcomes: OutcomeRepository,
    private readonly secrets: SecretProvider | null = null,
  ) {}

  async registerSource(scope: TenantScope, userId: string, input: EvidenceSourceInput): Promise<Record<string, unknown>> {
    if (!/^[a-z][a-z0-9_-]{2,60}$/.test(input.source_key)) {
      throw new EvidenceRejected("A source key is lowercase letters, digits, hyphens and underscores");
    }
    if (!input.permitted_properties.length) {
      throw new EvidenceRejected(
        "A source must declare which properties it may report. A source permitted to report anything is a source that can contradict every integration you have.");
    }
    for (const property of input.permitted_properties) {
      if (!/^[a-z][a-z0-9_.]{2,80}$/.test(property)) throw new EvidenceRejected(`Invalid property name: ${property}`);
    }
    const row = (await this.db.query(
      `INSERT INTO nyst_evidence_sources(evidence_source_id,organization_id,project_id,environment_id,
         source_key,display_name,transport,permitted_properties,authoritative,adapter_version,
         signing_secret_ref,default_freshness_seconds,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING evidence_source_id,source_key,display_name,transport,permitted_properties,authoritative,
                 adapter_version,default_freshness_seconds,created_at`,
      [randomUUID(), scope.organization_id, scope.project_id, scope.environment_id,
        input.source_key, input.display_name, input.transport, [...input.permitted_properties],
        input.authoritative === true, input.adapter_version, input.signing_secret_ref ?? null,
        input.default_freshness_seconds ?? 900, userId])).rows[0]!;
    return row;
  }

  async sources(scope: TenantScope): Promise<Record<string, unknown>[]> {
    return (await this.db.query(
      `SELECT evidence_source_id,source_key,display_name,transport,permitted_properties,authoritative,
              adapter_version,default_freshness_seconds,created_at,revoked_at
       FROM nyst_evidence_sources WHERE environment_id=$1 AND organization_id=$2 ORDER BY source_key`,
      [scope.environment_id, scope.organization_id])).rows;
  }

  async revokeSource(scope: TenantScope, sourceKey: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE nyst_evidence_sources SET revoked_at=now()
       WHERE environment_id=$1 AND organization_id=$2 AND source_key=$3 AND revoked_at IS NULL
       RETURNING evidence_source_id`,
      [scope.environment_id, scope.organization_id, sourceKey]);
    return result.rows.length === 1;
  }

  /**
   * Accept one pushed observation.
   *
   * Idempotent on (source, event_id): a customer retrying after a timeout gets
   * the original record back rather than creating a second observation of the
   * same event, which would otherwise double-count in every metric.
   */
  async push(scope: TenantScope, push: EvidencePush, options: { raw_body?: string } = {}): Promise<{
    ingested_evidence_id: string; world_fact_id: string | null; replayed: boolean; signature_verified: boolean;
  }> {
    // A customer may not push a conclusion, under any key.
    assertNoConclusion(push);

    const source = (await this.db.query(
      `SELECT * FROM nyst_evidence_sources
       WHERE environment_id=$1 AND organization_id=$2 AND source_key=$3 AND revoked_at IS NULL`,
      [scope.environment_id, scope.organization_id, push.source_key])).rows[0];
    if (!source) {
      throw new EvidenceRejected(
        `No evidence source named ${push.source_key} is registered in this environment. An unregistered source is refused rather than trusted.`, 404);
    }

    const permitted = (source.permitted_properties ?? []) as string[];
    if (!permitted.includes(push.property)) {
      throw new EvidenceRejected(
        `The source ${push.source_key} is not permitted to report ${push.property}. It may report: ${permitted.join(", ")}.`, 403);
    }

    if (!push.event_id || push.event_id.length < 8) {
      throw new EvidenceRejected("Every push needs an event_id of at least 8 characters, so a retry is not a second observation");
    }

    const bodyBytes = Buffer.byteLength(JSON.stringify(push), "utf8");
    if (bodyBytes > 16_384) throw new EvidenceRejected("The pushed observation exceeds the 16KB bound", 413);

    const observedAt = new Date(push.observed_at);
    if (!Number.isFinite(observedAt.getTime())) throw new EvidenceRejected("observed_at must be a valid timestamp");
    // An observation from the future is either a clock problem or an attempt
    // to keep evidence fresh forever. Either way Nyst will not accept it.
    if (observedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new EvidenceRejected("observed_at is in the future. Nyst will not accept an observation that has not happened yet.");
    }
    const freshUntil = push.fresh_until
      ? new Date(push.fresh_until)
      : new Date(observedAt.getTime() + Number(source.default_freshness_seconds) * 1000);
    if (!Number.isFinite(freshUntil.getTime()) || freshUntil <= observedAt) {
      throw new EvidenceRejected("fresh_until must be a valid timestamp after observed_at");
    }

    // Optional request signature. An unsigned push from a source that declares
    // a secret is refused; a source with no secret is usable and RECORDED as
    // unverified, so the weaker path is visible rather than silently equal.
    const signatureVerified = await this.verifySignature(source, push, options.raw_body);

    const inserted = await this.db.query(
      `INSERT INTO nyst_ingested_evidence(ingested_evidence_id,organization_id,project_id,environment_id,
         evidence_source_id,event_id,subject_ref,property,value,value_type,observed_at,fresh_until,
         payload_bytes,signature_verified,provenance)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (evidence_source_id,event_id) DO NOTHING
       RETURNING ingested_evidence_id`,
      [randomUUID(), scope.organization_id, scope.project_id, scope.environment_id,
        source.evidence_source_id, push.event_id, push.subject_ref, push.property,
        JSON.stringify(push.value), push.value.type, observedAt.toISOString(), freshUntil.toISOString(),
        bodyBytes, signatureVerified, JSON.stringify({
          ...(push.provenance ?? {}),
          source_key: push.source_key,
          transport: String(source.transport),
        })]);

    if (!inserted.rows.length) {
      const existing = (await this.db.query(
        `SELECT ingested_evidence_id,world_fact_id,signature_verified FROM nyst_ingested_evidence
         WHERE evidence_source_id=$1 AND event_id=$2`,
        [source.evidence_source_id, push.event_id])).rows[0]!;
      return {
        ingested_evidence_id: String(existing.ingested_evidence_id),
        world_fact_id: existing.world_fact_id ? String(existing.world_fact_id) : null,
        replayed: true, signature_verified: existing.signature_verified === true,
      };
    }

    // Now it becomes a WorldFact, through exactly the same path a first-party
    // read takes. Authority comes from the SOURCE's registration, never from
    // the push — a customer cannot promote their own evidence.
    const fact = await this.outcomes.recordFact(scope, {
      subject_ref: push.subject_ref, provider: String(source.source_key), property: push.property,
      value: push.value, observed_at: observedAt.toISOString(), fresh_until: freshUntil.toISOString(),
      source_type: String(source.transport) as NormalizedEvidence["source_type"],
      authoritative: source.authoritative === true,
      provenance: { ...(push.provenance ?? {}), signature_verified: signatureVerified, event_id: push.event_id },
      adapter_version: String(source.adapter_version),
    });

    const id = String(inserted.rows[0]!.ingested_evidence_id);
    await this.db.query(`UPDATE nyst_ingested_evidence SET world_fact_id=$2 WHERE ingested_evidence_id=$1`, [id, fact.fact_id]);
    return { ingested_evidence_id: id, world_fact_id: fact.fact_id, replayed: false, signature_verified: signatureVerified };
  }

  async evidence(scope: TenantScope, limit = 100): Promise<Record<string, unknown>[]> {
    return (await this.db.query(
      `SELECT e.ingested_evidence_id,s.source_key,e.event_id,e.subject_ref,e.property,e.value,
              e.observed_at,e.fresh_until,e.signature_verified,e.world_fact_id,e.received_at
       FROM nyst_ingested_evidence e JOIN nyst_evidence_sources s USING(evidence_source_id)
       WHERE e.environment_id=$1 AND e.organization_id=$2 ORDER BY e.received_at DESC LIMIT $3`,
      [scope.environment_id, scope.organization_id, Math.min(Math.max(1, limit), 500)])).rows;
  }

  private async verifySignature(source: Record<string, unknown>, push: EvidencePush, rawBody?: string): Promise<boolean> {
    const reference = source.signing_secret_ref ? String(source.signing_secret_ref) : null;
    if (!reference) {
      if (push.signature) {
        throw new EvidenceRejected("This source has no signing secret configured, so a signature cannot be verified. Configure one or push unsigned.");
      }
      return false;
    }
    if (!this.secrets) throw new EvidenceRejected("This source requires a signature and no SecretProvider is configured", 503);
    if (!push.signature) {
      throw new EvidenceRejected("This source is configured to sign its pushes, and this push carried no signature", 401);
    }
    let secret: string;
    try {
      secret = await this.secrets.resolve(reference);
    } catch {
      throw new EvidenceRejected("The source's signing secret could not be resolved", 503);
    }
    // Signed over the raw body where available, so the signature covers the
    // exact bytes rather than a re-serialization of them.
    const body = rawBody ?? canonicalPushBody(push);
    const expected = createHmac("sha256", secret).update(body).digest();
    const supplied = Buffer.from(push.signature, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new EvidenceRejected("The push signature did not verify", 401);
    }
    return true;
  }
}

/**
 * The exact bytes a signature covers when no raw body is available.
 *
 * Deliberately excludes the signature itself and any field not part of the
 * observation, so a client and Nyst compute the same string.
 */
export function canonicalPushBody(push: EvidencePush): string {
  return JSON.stringify({
    source_key: push.source_key, event_id: push.event_id, subject_ref: push.subject_ref,
    property: push.property, value: push.value, observed_at: push.observed_at,
    fresh_until: push.fresh_until ?? null,
  });
}

/**
 * A customer may push facts. They may not push conclusions.
 *
 * Checked by key name, recursively, because the attack is not subtle: a
 * `{"property": "outcome", "value": "satisfied"}` push would otherwise arrive
 * as a WorldFact and be weighed like an observation.
 */
function assertNoConclusion(push: EvidencePush): void {
  const record = push as unknown as Record<string, unknown>;
  for (const field of FORBIDDEN_PUSH_FIELDS) {
    if (field in record) {
      throw new EvidenceRejected(
        `A pushed observation may not carry "${field}". Customers push evidence; Nyst evaluates truth. ` +
        `Push the fact your system observed, and let the invariant engine decide what it means.`, 403);
    }
  }
  if (/^(outcome|verdict|satisfied|verified)$/.test(push.property)) {
    throw new EvidenceRejected(
      `"${push.property}" is a conclusion, not an observation. Push what your system SAW — for example ` +
      `{ property: "vpn.active", value: false } — and Nyst will decide what it establishes.`, 403);
  }
}

/* ================================================================ RELAY */

/**
 * THE CUSTOMER-SIDE RELAY.
 *
 * Some customers cannot give Nyst a provider credential, and that is a
 * reasonable position rather than an obstacle to route around. The Relay runs
 * inside their network, holds their credentials, and performs narrowly scoped
 * READS that Nyst asks for by signed request.
 *
 * THE PROTOCOL.
 *
 *   1. Nyst issues a RelayRequest: one operation, one subject, one property,
 *      one nonce, an expiry no more than ten minutes out, signed by Nyst's
 *      key. It is stored before it is sent.
 *   2. The Relay verifies the signature against Nyst's published key, checks
 *      the expiry, checks the operation is one it is configured to perform,
 *      and refuses anything else.
 *   3. The Relay performs the read against the provider inside the customer's
 *      network, using a credential Nyst never sees.
 *   4. The Relay pushes the result back through the Evidence Ingest API,
 *      echoing the nonce.
 *   5. Nyst accepts the nonce exactly once. A replayed response is refused.
 *
 * READ ONLY, IN THIS RELEASE.
 *
 * `operation` is a closed set and every member is an observation. A mutation
 * Relay would need a durable dispatch boundary on the customer side, a
 * two-phase protocol for the ambiguous window, and a way for Nyst to establish
 * what happened when the Relay itself disappears mid-request. That is real
 * work, and shipping a half-built version of it would put a duplicate external
 * consequence exactly where this product promises there is none.
 *
 * NOT IMPLEMENTED: consequential mutation Relay. See docs/product/relay.md.
 */
export const RELAY_OPERATIONS = [
  "observe_github_effective_permission",
  "observe_okta_account_status",
  "observe_aws_access_keys",
  "observe_generic_property",
] as const;
export type RelayOperation = (typeof RELAY_OPERATIONS)[number];

export interface RelayRequestPayload {
  relay_request_id: string;
  operation: RelayOperation;
  operation_key: string;
  environment_id: string;
  subject_ref: string;
  property: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
}

export class RelayCoordinator {
  constructor(private readonly db: ProductDb, private readonly ingest: EvidenceIngest) {}

  /** Issue one scoped, signed, single-use read request. */
  async issueRequest(scope: TenantScope, input: {
    source_key: string; operation: RelayOperation; subject_ref: string; property: string;
    operation_key: string; expires_in_seconds?: number;
  }, signer: Signer): Promise<{ request: RelayRequestPayload; signature: string; key_id: string }> {
    if (!(RELAY_OPERATIONS as readonly string[]).includes(input.operation)) {
      throw new EvidenceRejected(`Unsupported Relay operation: ${input.operation}. Every Relay operation in this release is a read.`);
    }
    const expiresIn = Math.min(Math.max(input.expires_in_seconds ?? 300, 30), 600);
    const source = (await this.db.query(
      `SELECT evidence_source_id,permitted_properties FROM nyst_evidence_sources
       WHERE environment_id=$1 AND organization_id=$2 AND source_key=$3 AND transport='customer_relay' AND revoked_at IS NULL`,
      [scope.environment_id, scope.organization_id, input.source_key])).rows[0];
    if (!source) throw new EvidenceRejected(`No Relay source named ${input.source_key} is registered`, 404);
    if (!((source.permitted_properties ?? []) as string[]).includes(input.property)) {
      throw new EvidenceRejected(`The Relay source ${input.source_key} is not permitted to report ${input.property}`, 403);
    }

    const id = randomUUID();
    const nonce = randomBytes(24).toString("hex");
    const issuedAt = new Date();
    const payload: RelayRequestPayload = {
      relay_request_id: id, operation: input.operation, operation_key: input.operation_key,
      environment_id: scope.environment_id, subject_ref: input.subject_ref, property: input.property,
      nonce, issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + expiresIn * 1000).toISOString(),
    };
    const signature = signer.sign(payload);

    await this.db.query(
      `INSERT INTO nyst_relay_requests(relay_request_id,organization_id,project_id,environment_id,
         evidence_source_id,operation_key,operation,subject_ref,property,nonce,issued_at,expires_at,signature,key_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, scope.organization_id, scope.project_id, scope.environment_id, source.evidence_source_id,
        input.operation_key, input.operation, input.subject_ref, input.property, nonce,
        payload.issued_at, payload.expires_at, signature.signature_b64, signature.key_id]);

    return { request: payload, signature: signature.signature_b64, key_id: signature.key_id };
  }

  /**
   * Accept a Relay's response.
   *
   * The nonce is consumed atomically, so a replayed response is refused rather
   * than producing a second observation. An expired request is refused too:
   * an answer to a question Nyst asked ten minutes ago is not an observation
   * of now.
   */
  async fulfil(scope: TenantScope, input: { nonce: string; push: EvidencePush }): Promise<{
    ingested_evidence_id: string; world_fact_id: string | null;
  }> {
    const claimed = await this.db.query(
      `UPDATE nyst_relay_requests SET status='fulfilled', fulfilled_at=now()
       WHERE environment_id=$1 AND nonce=$2 AND status='issued' AND expires_at > now()
       RETURNING relay_request_id,operation,subject_ref,property,evidence_source_id`,
      [scope.environment_id, input.nonce]);
    if (!claimed.rows.length) {
      // Say which it was. "Invalid nonce" leaves an operator guessing between
      // a replay, an expiry and a typo.
      const existing = (await this.db.query(
        `SELECT status,expires_at FROM nyst_relay_requests WHERE environment_id=$1 AND nonce=$2`,
        [scope.environment_id, input.nonce])).rows[0];
      if (!existing) throw new EvidenceRejected("No Relay request matches that nonce", 404);
      if (existing.status === "fulfilled") {
        throw new EvidenceRejected("That Relay request was already fulfilled. A nonce is accepted exactly once.", 409);
      }
      throw new EvidenceRejected("That Relay request has expired. An answer to a question asked ten minutes ago is not an observation of now.", 409);
    }

    const request = claimed.rows[0]!;
    // The Relay must answer the question it was asked. A response about a
    // different subject or property is refused rather than recorded.
    if (String(request.subject_ref) !== input.push.subject_ref || String(request.property) !== input.push.property) {
      await this.db.query(
        `UPDATE nyst_relay_requests SET status='rejected', rejection_reason=$2 WHERE relay_request_id=$1`,
        [request.relay_request_id, "The response did not match the subject and property that were requested"]);
      throw new EvidenceRejected(
        `This Relay request asked about ${String(request.property)} for ${String(request.subject_ref)}, and the response was about ${input.push.property} for ${input.push.subject_ref}.`, 400);
    }

    const result = await this.ingest.push(scope, input.push);
    await this.db.query(
      `UPDATE nyst_relay_requests SET ingested_evidence_id=$2 WHERE relay_request_id=$1`,
      [request.relay_request_id, result.ingested_evidence_id]);
    return { ingested_evidence_id: result.ingested_evidence_id, world_fact_id: result.world_fact_id };
  }

  async requests(scope: TenantScope, limit = 50): Promise<Record<string, unknown>[]> {
    return (await this.db.query(
      `SELECT relay_request_id,operation_key,operation,subject_ref,property,status,issued_at,expires_at,fulfilled_at,rejection_reason
       FROM nyst_relay_requests WHERE environment_id=$1 AND organization_id=$2 ORDER BY issued_at DESC LIMIT $3`,
      [scope.environment_id, scope.organization_id, Math.min(Math.max(1, limit), 200)])).rows;
  }

  /** Expire anything nobody answered. Housekeeping, not a safety property. */
  async expireStale(scope: TenantScope): Promise<number> {
    const result = await this.db.query(
      `UPDATE nyst_relay_requests SET status='expired'
       WHERE environment_id=$1 AND status='issued' AND expires_at <= now() RETURNING relay_request_id`,
      [scope.environment_id]);
    return result.rows.length;
  }
}
