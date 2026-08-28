import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const privateKeys = new Map<string, KeyObject>();

/**
 * Create an Ed25519 signing key for one simulated author.
 *
 * Only the public half leaves this module. The private KeyObject stays in
 * process memory for the Phase 1 to Phase 2 handoff and is never serialized
 * into the ground-truth manifest.
 */
export function createLocalSigner(authorId: string): string {
  if (!authorId) throw new Error("local-signer-invalid: authorId is required");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  privateKeys.set(authorId, privateKey);
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

/** Sign the exact UTF-8 bytes of a canonical v1 payload. */
export function signLocalPayload(authorId: string, payload: string): string {
  const privateKey = privateKeys.get(authorId);
  if (!privateKey) {
    throw new Error(`local-signer-missing: no in-memory key for ${authorId}`);
  }
  return sign(null, Buffer.from(payload, "utf-8"), privateKey)
    .toString("base64")
    .replace(/=+$/, "");
}

export function clearLocalSigners(): void {
  privateKeys.clear();
}
