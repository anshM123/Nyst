/**
 * Day-1 metadata carried by actions and resolutions.
 *
 * AI metadata is nullable because Outcome also protects ordinary software.
 * `credential_ref` is an opaque reference (vault path, key id, etc.) —
 * raw credentials are NEVER stored in action/evidence rows.
 */
import { bool, nullable, num, obj, opt, str, type Schema } from "../core/validate.js";

export interface ApprovalMetadata {
  required: boolean;
  fired: boolean;
  reference: string | null;
}

export const ApprovalMetadataSchema: Schema<ApprovalMetadata> = obj({
  required: bool(),
  fired: bool(),
  reference: nullable(str({ min: 1 })),
});

export interface ActionContext {
  /** Monetary value in minor units (e.g. cents); null when not monetary. */
  value_minor_units: number | null;
  value_currency: string | null;
  /** Coarse risk magnitude when value is non-monetary: low|medium|high|critical (free-form for Phase 1). */
  risk_magnitude: string | null;
  workload_id: string | null;
  workload_version: string | null;
  /** Model identity where applicable (nullable — ordinary software has none). */
  model_identity: string | null;
  /** Hash of model/config used, where applicable. */
  model_config_hash: string | null;
  /** Opaque credential identity/reference — never a raw credential. */
  credential_ref: string | null;
  approval: ApprovalMetadata;
}

export const ActionContextSchema: Schema<ActionContext> = obj({
  value_minor_units: nullable(num({ int: true, min: 0 })),
  value_currency: nullable(str({ min: 3, max: 3 })),
  risk_magnitude: nullable(str({ min: 1, max: 32 })),
  workload_id: nullable(str({ min: 1 })),
  workload_version: nullable(str({ min: 1 })),
  model_identity: nullable(str({ min: 1 })),
  model_config_hash: nullable(str({ min: 1 })),
  credential_ref: nullable(str({ min: 1 })),
  approval: ApprovalMetadataSchema,
});

export const EMPTY_CONTEXT: ActionContext = {
  value_minor_units: null,
  value_currency: null,
  risk_magnitude: null,
  workload_id: null,
  workload_version: null,
  model_identity: null,
  model_config_hash: null,
  credential_ref: null,
  approval: { required: false, fired: false, reference: null },
};

const CREDENTIAL_LIKE = /(api[_-]?key|secret|password|bearer\s|sk_live|sk_test|-----BEGIN)/i;

/** Defensive check: refuse obviously-raw credentials in metadata fields. */
export function assertNoRawCredential(ctx: ActionContext): void {
  const suspicious = [ctx.credential_ref, ctx.workload_id, ctx.model_identity].filter(
    (v): v is string => typeof v === "string"
  );
  for (const v of suspicious) {
    if (CREDENTIAL_LIKE.test(v)) {
      throw new Error("Refusing to store what looks like a raw credential in metadata");
    }
  }
}
