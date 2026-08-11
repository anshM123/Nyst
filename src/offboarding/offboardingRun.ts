import { canonicalHash } from "../core/canonical.js";
import { newUuid, UUID_RE } from "../core/ids.js";

export interface OffboardingSubject {
  subject_key: string;
  display_name: string;
}

export interface OffboardingRunIntent {
  business_key: string;
  subject: OffboardingSubject;
  okta: {
    org: string;
    user_id: string;
    credential_ref: "env:NYST_OKTA_ACCESS_TOKEN";
  };
  github: {
    owner: string;
    repository: string;
    principal: string;
    baseline_permission: "read" | "triage" | "write" | "maintain" | "admin";
    credential_ref: "env:NYST_GITHUB_TOKEN";
  };
  created_at: string;
}

export interface OffboardingRunRecord extends OffboardingRunIntent {
  run_id: string;
  input_hash: string;
  okta_action_id: string | null;
  github_action_id: string | null;
}

export class OffboardingCollisionError extends Error {
  override name = "OffboardingCollisionError";
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export function validateOffboardingIntent(value: OffboardingRunIntent): OffboardingRunIntent {
  if (!SAFE_KEY.test(value.business_key)) throw new Error("Invalid offboarding business key");
  if (!SAFE_KEY.test(value.subject.subject_key)) throw new Error("Invalid offboarding subject key");
  if (value.subject.display_name.length < 1 || value.subject.display_name.length > 200) {
    throw new Error("Invalid offboarding display name");
  }
  if (value.okta.credential_ref !== "env:NYST_OKTA_ACCESS_TOKEN") {
    throw new Error("Offboarding stores only the fixed Okta credential reference");
  }
  if (value.github.credential_ref !== "env:NYST_GITHUB_TOKEN") {
    throw new Error("Offboarding stores only the fixed GitHub credential reference");
  }
  if (!/^https:\/\/integrator-[0-9]+\.okta\.com$/.test(value.okta.org)) {
    throw new Error("Unsupported Okta tenant for offboarding demo");
  }
  if (!/^[A-Za-z0-9]{10,64}$/.test(value.okta.user_id)) throw new Error("Invalid Okta user ID");
  if (!/^[A-Za-z0-9-]{1,39}$/.test(value.github.owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(value.github.repository) ||
      !/^[A-Za-z0-9-]{1,39}$/.test(value.github.principal)) {
    throw new Error("Invalid GitHub fixture identity");
  }
  if (!Number.isFinite(Date.parse(value.created_at))) throw new Error("Invalid offboarding timestamp");
  return structuredClone(value);
}

export function newOffboardingRun(intentValue: OffboardingRunIntent): OffboardingRunRecord {
  const intent = validateOffboardingIntent(intentValue);
  return {
    ...intent,
    run_id: newUuid(),
    input_hash: offboardingInputHash(intent),
    okta_action_id: null,
    github_action_id: null,
  };
}

export function offboardingInputHash(intent: OffboardingRunIntent): string {
  const { created_at: _createdAt, ...semantic } = intent;
  return canonicalHash(semantic);
}

export function validateOffboardingRecord(value: OffboardingRunRecord): OffboardingRunRecord {
  validateOffboardingIntent(value);
  if (!UUID_RE.test(value.run_id)) throw new Error("Invalid offboarding run ID");
  if (!/^sha256:[0-9a-f]{64}$/.test(value.input_hash)) throw new Error("Invalid offboarding input hash");
  for (const id of [value.okta_action_id, value.github_action_id]) {
    if (id !== null && !UUID_RE.test(id)) throw new Error("Invalid offboarding action reference");
  }
  return structuredClone(value);
}

export interface OffboardingRunLedger {
  recordIntent(intent: OffboardingRunIntent): Promise<{ run: OffboardingRunRecord; created: boolean }>;
  get(run_id: string): Promise<OffboardingRunRecord | null>;
  findByBusinessKey(business_key: string): Promise<OffboardingRunRecord | null>;
  attachAction(run_id: string, provider: "okta" | "github", action_id: string): Promise<OffboardingRunRecord>;
}

export class MemoryOffboardingRunLedger implements OffboardingRunLedger {
  private readonly byId = new Map<string, OffboardingRunRecord>();
  private readonly byBusiness = new Map<string, string>();
  private readonly bySubject = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  recordIntent(intentValue: OffboardingRunIntent): Promise<{ run: OffboardingRunRecord; created: boolean }> {
    return this.serialized(() => {
      const intent = validateOffboardingIntent(intentValue);
      const hash = offboardingInputHash(intent);
      const existingId = this.byBusiness.get(intent.business_key);
      if (existingId) {
        const existing = this.byId.get(existingId)!;
        if (existing.input_hash !== hash) throw new OffboardingCollisionError("Conflicting offboarding intent");
        return { run: structuredClone(existing), created: false };
      }
      if (this.bySubject.has(intent.subject.subject_key)) {
        throw new OffboardingCollisionError("Subject already has a different offboarding run");
      }
      const run = newOffboardingRun(intent);
      this.byId.set(run.run_id, structuredClone(run));
      this.byBusiness.set(run.business_key, run.run_id);
      this.bySubject.set(run.subject.subject_key, run.run_id);
      return { run: structuredClone(run), created: true };
    });
  }

  async get(run_id: string): Promise<OffboardingRunRecord | null> {
    const run = this.byId.get(run_id);
    return run ? structuredClone(run) : null;
  }

  async findByBusinessKey(business_key: string): Promise<OffboardingRunRecord | null> {
    const id = this.byBusiness.get(business_key);
    return id ? this.get(id) : null;
  }

  attachAction(run_id: string, provider: "okta" | "github", action_id: string): Promise<OffboardingRunRecord> {
    return this.serialized(() => {
      if (!UUID_RE.test(action_id)) throw new Error("Invalid action reference");
      const run = this.byId.get(run_id);
      if (!run) throw new Error(`Unknown offboarding run ${run_id}`);
      const key = provider === "okta" ? "okta_action_id" : "github_action_id";
      if (run[key] !== null && run[key] !== action_id) throw new OffboardingCollisionError(`${provider} action is immutable`);
      const next = validateOffboardingRecord({ ...run, [key]: action_id });
      this.byId.set(run_id, next);
      return structuredClone(next);
    });
  }
}

export interface OffboardingQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PostgresOffboardingRunLedger implements OffboardingRunLedger {
  constructor(private readonly db: OffboardingQueryable) {}

  async recordIntent(intentValue: OffboardingRunIntent): Promise<{ run: OffboardingRunRecord; created: boolean }> {
    const intent = validateOffboardingIntent(intentValue);
    const candidate = newOffboardingRun(intent);
    let inserted;
    try {
      inserted = await this.db.query(
        `INSERT INTO outcome_offboarding_runs
         (run_id,business_key,subject_key,input_hash,intent,created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
         ON CONFLICT (business_key) DO NOTHING RETURNING *`,
        [candidate.run_id,candidate.business_key,candidate.subject.subject_key,candidate.input_hash,JSON.stringify(intent),candidate.created_at]
      );
    } catch (error) {
      if (/subject_key|offboarding_subject/i.test(error instanceof Error ? error.message : String(error))) {
        throw new OffboardingCollisionError("Subject already has a different offboarding run");
      }
      throw error;
    }
    if (inserted.rows[0]) return { run: rowToOffboarding(inserted.rows[0]), created: true };
    const existing = await this.findByBusinessKey(intent.business_key);
    if (!existing) throw new Error("Offboarding insert conflict winner missing");
    if (existing.input_hash !== candidate.input_hash) throw new OffboardingCollisionError("Conflicting offboarding intent");
    return { run: existing, created: false };
  }

  async get(run_id: string): Promise<OffboardingRunRecord | null> {
    const result = await this.db.query("SELECT * FROM outcome_offboarding_runs WHERE run_id=$1", [run_id]);
    return result.rows[0] ? rowToOffboarding(result.rows[0]) : null;
  }

  async findByBusinessKey(business_key: string): Promise<OffboardingRunRecord | null> {
    const result = await this.db.query("SELECT * FROM outcome_offboarding_runs WHERE business_key=$1", [business_key]);
    return result.rows[0] ? rowToOffboarding(result.rows[0]) : null;
  }

  async attachAction(run_id: string, provider: "okta" | "github", action_id: string): Promise<OffboardingRunRecord> {
    if (!UUID_RE.test(action_id)) throw new Error("Invalid action reference");
    const column = provider === "okta" ? "okta_action_id" : "github_action_id";
    const result = await this.db.query(
      `UPDATE outcome_offboarding_runs SET ${column}=COALESCE(${column},$2::uuid)
       WHERE run_id=$1 AND (${column} IS NULL OR ${column}=$2::uuid) RETURNING *`,
      [run_id,action_id]
    );
    if (result.rows[0]) return rowToOffboarding(result.rows[0]);
    const existing = await this.get(run_id);
    if (!existing) throw new Error(`Unknown offboarding run ${run_id}`);
    throw new OffboardingCollisionError(`${provider} action is immutable`);
  }
}

function rowToOffboarding(row: Record<string, unknown>): OffboardingRunRecord {
  const intent = typeof row.intent === "string" ? JSON.parse(row.intent) : row.intent;
  return validateOffboardingRecord({
    ...(intent as OffboardingRunIntent),
    run_id: String(row.run_id),
    input_hash: String(row.input_hash),
    okta_action_id: row.okta_action_id === null ? null : String(row.okta_action_id),
    github_action_id: row.github_action_id === null ? null : String(row.github_action_id),
  });
}
