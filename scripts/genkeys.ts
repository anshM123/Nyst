// Generate a local dev Ed25519 keypair (base64 DER) for .env. Never commit keys.
import { generateKeyPairSync } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log("OUTCOME_SIGNING_KEY_ID=dev-local-" + Date.now());
console.log("OUTCOME_SIGNING_PRIVATE_KEY_B64=" + privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
console.log("OUTCOME_SIGNING_PUBLIC_KEY_B64=" + publicKey.export({ format: "der", type: "spki" }).toString("base64"));
