const SECRET_KEY = /(?:password|secret|token|authorization|private[_-]?key|client[_-]?assertion|api[_-]?key)/i;
const SECRET_VALUE = /(?:github_pat_|ghp_|(?:sk|rk)_(?:test|live)_|Bearer\s+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export function sanitizeForProduct(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[REDACTED]" : value;
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => sanitizeForProduct(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 1000)) {
    out[key] = SECRET_KEY.test(key) && key !== "credential_ref" ? "[REDACTED]" : sanitizeForProduct(item, depth + 1);
  }
  return out;
}
