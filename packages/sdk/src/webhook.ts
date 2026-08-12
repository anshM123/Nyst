/**
 * Decision webhook signature verification.
 *
 * Self-contained on purpose: this is the one piece of Nyst that runs inside
 * YOUR process, deciding whether a payload claiming to come from Nyst really
 * did. It must not pull in server code, and it must not be reimplemented
 * casually by each consumer — a naive `===` comparison of signatures leaks
 * timing, and forgetting the timestamp window makes every past delivery
 * replayable forever.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Deliveries older or newer than this are rejected outright. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export function signWebhook(secret: string, timestamp: string, body: string, eventId?: string): string {
  const payload = eventId ? `${timestamp}.${eventId}.${body}` : `${timestamp}.${body}`;
  return `v1=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/**
 * Verify one delivery.
 *
 * `body` MUST be the raw request body exactly as received. Re-serialising a
 * parsed object changes the bytes and the signature will not match — which
 * looks like an attack and is actually a bug in the receiver.
 */
export function verifyWebhook(
  secret: string, timestamp: string, body: string, signature: string,
  now: number = Date.now(), eventId?: string,
): boolean {
  const sent = Date.parse(timestamp);
  if (!Number.isFinite(sent) || Math.abs(now - sent) > WEBHOOK_TOLERANCE_MS) return false;
  const expected = signWebhook(secret, timestamp, body, eventId);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  // Length must be compared first: timingSafeEqual throws on a length mismatch.
  return left.length === right.length && timingSafeEqual(left, right);
}
