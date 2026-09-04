import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearLocalSigners,
  createLocalSigner,
  signLocalPayload,
} from "../../src/lib/local-signing.js";

afterEach(() => clearLocalSigners());

describe("in-memory author signing", () => {
  it("signs the exact UTF-8 payload with its registered public key", () => {
    const publicKeyPem = createLocalSigner("author-1");
    const payload = '{"profile":"htmltrust-signature-v1","title":"café"}';
    const signature = signLocalPayload("author-1", payload);

    expect(signature).not.toContain("=");
    expect(verify(
      null,
      Buffer.from(payload, "utf-8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64"),
    )).toBe(true);
    expect(verify(
      null,
      Buffer.from(`${payload} `, "utf-8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64"),
    )).toBe(false);
  });

  it("never exposes a private key and fails after memory is cleared", () => {
    const publicKeyPem = createLocalSigner("author-2");
    expect(publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(publicKeyPem).not.toContain("PRIVATE KEY");

    clearLocalSigners();
    expect(() => signLocalPayload("author-2", "payload")).toThrow("local-signer-missing");
  });
});
