/**
 * INBOUND SUBMISSIONS — contact messages and quote requests.
 *
 * Where a message goes when a visitor presses Send. Before v0.3.1 the answer
 * was nowhere: both sinks were optional and neither was ever supplied, so the
 * site thanked people for messages it had already discarded.
 *
 * This is deliberately the dullest file in the codebase. A lead is not an
 * Effect. It has no receipt, no invariants, no verdict, and no place in the
 * three-layer model — and giving it any of those would imply Nyst treats a
 * sales enquiry with the same machinery as a consequential action.
 */
import { randomInt } from "node:crypto";
import type { ProductDb } from "../product/productRepository.js";

/** No O/0 and no I/1: a reference gets read aloud and typed back. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export interface ContactSubmission {
  name: string;
  email: string;
  company: string;
  topic: string;
  message: string;
  received_at: string;
  source_ip?: string | null;
  user_agent?: string | null;
}

export interface QuoteSubmission {
  input: object;
  recommended_plan: string;
  received_at: string;
  source_ip?: string | null;
  /**
   * EXACTLY what the visitor was shown (v0.3.2 Phase 9).
   *
   * A price is a SENTENCE on the page -- "$2,400/month, from" -- so the display
   * string is stored verbatim rather than a number. Storing 240000 minor units
   * loses the qualifier that made it honest, and a quote from March must stay
   * reconstructable after the catalog changes in April.
   */
  price_display?: string | null;
  pricing_catalog_version?: string | null;
  requires_conversation?: boolean | null;
  /** What Nyst said it would NOT cover. The half most likely to be disputed. */
  uncovered?: readonly string[];
}

export interface StoredContact {
  reference: string;
  name: string;
  email: string;
  company: string;
  topic: string;
  message: string;
  received_at: string;
  status: "new" | "handled" | "spam";
}

export class InboundRepository {
  constructor(private readonly db: ProductDb) {}

  /**
   * Store a contact submission and return the reference shown to the visitor.
   *
   * Any failure propagates. The caller must not report success it did not get —
   * that was the entire defect.
   */
  async recordContact(submission: ContactSubmission): Promise<string> {
    const row = (await this.db.query(
      `INSERT INTO nyst_contact_submissions
         (contact_submission_id,reference,name,email,company,topic,message,received_at,source_ip,user_agent)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING reference`,
      [reference("NYST-LEAD"), submission.name, submission.email.trim().toLowerCase(),
        submission.company, submission.topic, submission.message, submission.received_at,
        normalizeIp(submission.source_ip), bounded(submission.user_agent, 400)])).rows[0]!;
    return String(row.reference);
  }

  async recordQuote(quote: QuoteSubmission): Promise<string> {
    const row = (await this.db.query(
      `INSERT INTO nyst_quote_requests
         (quote_request_id,reference,input,recommended_plan,received_at,source_ip,
          price_display,pricing_catalog_version,requires_conversation,uncovered)
       VALUES(gen_random_uuid(),$1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING reference`,
      [reference("NYST-QUOTE"), JSON.stringify(quote.input), quote.recommended_plan,
        quote.received_at, normalizeIp(quote.source_ip),
        quote.price_display ?? null, quote.pricing_catalog_version ?? null,
        quote.requires_conversation ?? null, JSON.stringify(quote.uncovered ?? [])])).rows[0]!;
    return String(row.reference);
  }

  /** Newest first. What an operator opens to see who has been in touch. */
  async recentContacts(limit = 100): Promise<StoredContact[]> {
    return (await this.db.query(
      `SELECT reference,name,email,company,topic,message,received_at,status
       FROM nyst_contact_submissions ORDER BY received_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)])).rows.map((row) => ({
        reference: String(row.reference), name: String(row.name), email: String(row.email),
        company: String(row.company), topic: String(row.topic), message: String(row.message),
        received_at: new Date(String(row.received_at)).toISOString(),
        status: String(row.status) as StoredContact["status"],
      }));
  }

  /** Triage. The message itself is immutable; only its status moves. */
  async markContactHandled(reference: string, note: string, status: "handled" | "spam" = "handled"): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE nyst_contact_submissions SET status=$2, handled_at=now(), handled_note=$3
       WHERE reference=$1 AND status='new' RETURNING reference`,
      [reference, status, note.slice(0, 2000)]);
    return result.rows.length > 0;
  }

  async pendingCount(): Promise<number> {
    return Number((await this.db.query(
      `SELECT count(*)::int count FROM nyst_contact_submissions WHERE status='new'`)).rows[0]!.count);
  }
}

/** A reference a person can read over the phone without ambiguity. */
function reference(prefix: string): string {
  let suffix = "";
  for (let position = 0; position < 8; position += 1) suffix += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${suffix}`;
}

/**
 * An `inet` column refuses a malformed address, and a malformed address is not
 * worth failing a visitor's message over. Null instead.
 */
function normalizeIp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const first = value.split(",")[0]?.trim() ?? "";
  return /^[0-9a-fA-F.:]+$/.test(first) && first.length >= 3 && first.length <= 45 ? first : null;
}

function bounded(value: string | null | undefined, max: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}
