/**
 * Signing foundation.
 *
 * - Ed25519 via node:crypto (no external deps).
 * - Keys come from environment/configuration; nothing is ever committed.
 * - Signed content is canonicalized deterministically (ojc-1) before signing.
 * - Local development keys are SOFTWARE keys. They prove integrity of a
 *   resolution against tampering; they do NOT provide hardware-backed
 *   attestation and must never be described as such.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { CANONICALIZATION_ID, canonicalBytes } from "./canonical.js";
import { en, lit, obj, str, type Schema } from "./validate.js";

export interface SignatureEnvelope {
  algorithm: "ed25519";
  canonicalization: typeof CANONICALIZATION_ID;
  key_id: string;
  /** base64 signature over canonical bytes of the signed content. */
  signature_b64: string;
}

export const SignatureEnvelopeSchema: Schema<SignatureEnvelope> = obj({
  algorithm: lit("ed25519"),
  canonicalization: en([CANONICALIZATION_ID]),
  key_id: str({ min: 1 }),
  signature_b64: str({ min: 16 }),
});

export interface Signer {
  keyId: string;
  publicKeyB64(): string;
  sign(content: unknown): SignatureEnvelope;
  verify(content: unknown, sig: SignatureEnvelope): boolean;
}

export class Ed25519Signer implements Signer {
  private constructor(
    public keyId: string,
    private priv: KeyObject | null,
    private pub: KeyObject
  ) {}

  /** Load from env-style config (base64 DER: PKCS8 private, SPKI public). */
  static fromConfig(cfg: {
    keyId: string;
    privateKeyB64?: string | undefined;
    publicKeyB64: string;
  }): Ed25519Signer {
    const pub = createPublicKey({
      key: Buffer.from(cfg.publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    const priv = cfg.privateKeyB64
      ? createPrivateKey({
          key: Buffer.from(cfg.privateKeyB64, "base64"),
          format: "der",
          type: "pkcs8",
        })
      : null;
    return new Ed25519Signer(cfg.keyId, priv, pub);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Ed25519Signer {
    const keyId = env.OUTCOME_SIGNING_KEY_ID;
    const pub = env.OUTCOME_SIGNING_PUBLIC_KEY_B64;
    if (!keyId || !pub) {
      throw new Error(
        "Signing keys not configured (OUTCOME_SIGNING_KEY_ID / OUTCOME_SIGNING_PUBLIC_KEY_B64). " +
          "Generate dev keys with scripts/genkeys.ts. Keys are never committed."
      );
    }
    return Ed25519Signer.fromConfig({
      keyId,
      privateKeyB64: env.OUTCOME_SIGNING_PRIVATE_KEY_B64,
      publicKeyB64: pub,
    });
  }

  /** Ephemeral in-memory keypair (tests / local dev only). */
  static ephemeral(keyId = "ephemeral-dev"): Ed25519Signer {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return new Ed25519Signer(keyId, privateKey, publicKey);
  }

  publicKeyB64(): string {
    return this.pub.export({ format: "der", type: "spki" }).toString("base64");
  }

  exportPrivateKeyB64(): string {
    if (!this.priv) throw new Error("No private key loaded");
    return this.priv.export({ format: "der", type: "pkcs8" }).toString("base64");
  }

  sign(content: unknown): SignatureEnvelope {
    if (!this.priv) throw new Error(`Signer ${this.keyId} has no private key (verify-only)`);
    const sig = edSign(null, canonicalBytes(content), this.priv);
    return {
      algorithm: "ed25519",
      canonicalization: CANONICALIZATION_ID,
      key_id: this.keyId,
      signature_b64: sig.toString("base64"),
    };
  }

  verify(content: unknown, sig: SignatureEnvelope): boolean {
    if (sig.algorithm !== "ed25519" || sig.canonicalization !== CANONICALIZATION_ID) return false;
    // The claimed key id is bound to the verifying key: an envelope whose
    // key_id was swapped does not verify, even though the raw signature bytes
    // are still cryptographically valid under this public key.
    if (sig.key_id !== this.keyId) return false;
    try {
      return edVerify(
        null,
        canonicalBytes(content),
        this.pub,
        Buffer.from(sig.signature_b64, "base64")
      );
    } catch {
      return false;
    }
  }
}
