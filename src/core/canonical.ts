/**
 * Deterministic canonicalization ("ojc-1": Outcome JSON Canonicalization v1).
 *
 * Rules:
 *  - Object keys sorted lexicographically (code-unit order), recursively.
 *  - Arrays preserve order.
 *  - `undefined` values inside objects are OMITTED (treated as absent).
 *  - `undefined` inside arrays, functions, symbols, bigint, NaN, Infinity are REJECTED.
 *  - Output is compact JSON (no whitespace).
 *
 * Canonicalization is used for input hashing, evidence payload hashing, and
 * signing. Stability across key ordering is contractually tested.
 */
import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function canon(value: unknown, path: string): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(`Non-finite number at ${path}`);
    }
    return JSON.stringify(n);
  }
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return (
      "[" +
      value
        .map((v, i) => {
          if (v === undefined) {
            throw new CanonicalizationError(`undefined in array at ${path}[${i}]`);
          }
          return canon(v, `${path}[${i}]`);
        })
        .join(",") +
      "]"
    );
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalizationError(`Non-plain object at ${path}`);
    }
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k], `${path}.${k}`)}`).join(",") +
      "}"
    );
  }
  throw new CanonicalizationError(`Unsupported value of type ${t} at ${path}`);
}

export const CANONICALIZATION_ID = "ojc-1" as const;

export function canonicalJson(value: unknown): string {
  return canon(value, "$");
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Canonical hash of an arbitrary JSON-compatible value. */
export function canonicalHash(value: unknown): string {
  return "sha256:" + sha256Hex(canonicalJson(value));
}

export type { Json };
