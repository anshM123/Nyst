/**
 * A complete Nyst integration, small enough to read in one sitting.
 *
 *   NYST_URL=https://nyst.example.com \
 *   NYST_API_KEY=... \
 *   node --experimental-strip-types examples/basic.ts
 *
 * It executes one consequential action, waits for the external world to
 * settle, and then acts ONLY on what Nyst decided.
 */
import { NystClient, mayContinue, mayRetry, needsHuman, NystApiError } from "@nyst-ai/sdk";

const baseUrl = process.env.NYST_URL;
const apiKey = process.env.NYST_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("Set NYST_URL and NYST_API_KEY.");
  process.exit(1);
}

const nyst = new NystClient({ baseUrl, apiKey });

const result = await nyst.execute({
  effect: "github.repository_permission_change",
  businessKey: `offboard:alice@example.com:acme/api`,
  input: { repository_id: "acme/api", principal_id: "alice", desired_permission: "none" },
}).catch((error: unknown) => {
  if (error instanceof NystApiError) {
    console.error(`Nyst refused the action: HTTP ${error.status}`, error.response);
    process.exit(1);
  }
  throw error;
});

let resolution = result.resolution;

// `pending` is not a failure. It means the external world has not settled.
// Nyst re-observes on its own schedule; reconcile() just asks it to look now.
for (let attempt = 0; resolution.effect.state === "pending" && attempt < 12; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  ({ resolution } = await nyst.reconcile(result.action_id));
}

const { effect, control } = resolution;
console.log(`effect state : ${effect.state}`);
console.log(`directive    : ${control.primary}  (${control.reason_code})`);
console.log(`why          : ${control.explanation}`);
console.log(`evidence     : ${effect.verification_methods.join(", ") || "none"}`);

// Act on the dispositions. Do not re-derive them from the effect state:
// `satisfied_unattributed` forbids a retry while still allowing continuation,
// and no local rule of thumb reproduces that correctly.
if (needsHuman(control)) {
  console.log("\nA person has to look at this before anything else happens.");
} else if (mayContinue(control)) {
  console.log("\nSafe to proceed to the next step.");
} else if (mayRetry(control)) {
  console.log("\nSafe to re-send this exact effect.");
} else {
  console.log("\nStop here. Neither continuing nor retrying is permitted.");
}

// The receipt is signed. Keep it: it is the durable proof of what was decided.
const { receipt, signature_valid } = await nyst.receipt(result.action_id);
console.log(`\nreceipt ${receipt.resolution_id} signature_valid=${signature_valid}`);
