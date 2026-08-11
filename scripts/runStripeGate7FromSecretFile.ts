/** One-shot ignored-file credential bridge for the Gate-7 sandbox canary. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const secretPath = join(import.meta.dirname, "..", ".secrets", "stripe-gate7-test-key.txt");
if (!existsSync(secretPath)) throw new Error("Stripe Gate-7 ignored credential file is missing");

let key = readFileSync(secretPath, "utf8");
if (!/^(?:sk|rk)_test_[A-Za-z0-9_]{8,255}$/.test(key)) {
  throw new Error("Stripe Gate-7 credential file must contain exactly one test-mode key");
}

process.env.NYST_STRIPE_API_KEY = key;
try {
  await import("./verifyStripeGate7Live.ts");
} finally {
  delete process.env.NYST_STRIPE_API_KEY;
  key = "";
  rmSync(secretPath, { force: true });
  console.log(`secret_file_deleted=${!existsSync(secretPath)}`);
}
