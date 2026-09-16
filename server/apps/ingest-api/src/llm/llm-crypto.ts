import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * AES-256-GCM at-rest encryption for BYOK API keys (doc 10 §3.2). The KMS key
 * comes from env `LLM_KMS_KEY` (64 hex chars = 32 bytes). Keys are decrypted
 * only at call time, in-process, and never logged.
 *
 * Shared util module (not a free function in a service file) per the standing
 * file-org rule.
 */

export interface EncryptedSecret {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function kmsKey(): Buffer {
  const hex = process.env.LLM_KMS_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "LLM_KMS_KEY missing or not 64 hex chars (32 bytes) — required to store a BYOK key",
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kmsKey(), iv);
  const cipher = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { cipher, iv, tag: c.getAuthTag() };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const d = createDecipheriv("aes-256-gcm", kmsKey(), secret.iv);
  d.setAuthTag(secret.tag);
  return Buffer.concat([d.update(secret.cipher), d.final()]).toString("utf8");
}

/** Last 4 chars of a key, for display (UI shows ••••last4). */
export function last4(key: string): string {
  return key.slice(-4);
}
