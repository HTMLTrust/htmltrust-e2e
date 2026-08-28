import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSignedClaims,
  buildV1SigningPayload,
  claimRecords,
  computeClaimsHash,
  computeContentHashFromHtml,
  hashCanonical,
  serializedOriginForDomain,
  v1Timestamp,
} from "../../src/phases/publish.js";

function sha256B64(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("base64").replace(/=+$/, "");
}

describe("publish canonical bindings", () => {
  it("hashes canonical bytes as unpadded standard Base64", () => {
    const hash = hashCanonical("hello");
    expect(hash).toBe(`sha256:${sha256B64("hello")}`);
    expect(hash).not.toContain("=");
    expect(hash).not.toMatch(/^[0-9a-f:]+$/);
  });

  it("binds signatures to serialized Web origins", () => {
    expect(serializedOriginForDomain("Author1.HTMLTrust.Test")).toBe("https://author1.htmltrust.test");
    expect(serializedOriginForDomain("https://Author1.HTMLTrust.Test:8443/path")).toBe(
      "https://author1.htmltrust.test:8443",
    );
  });

  it("uses the exact v1 timestamp format and strict claim records", () => {
    expect(v1Timestamp(new Date("2026-08-28T19:20:21.987Z"))).toBe("2026-08-28T19:20:21Z");
    expect(claimRecords({ author: "Alice", "signed-at": "2026-08-28T19:20:21Z" })).toEqual([
      { name: "author", content: "Alice" },
      { name: "signed-at", content: "2026-08-28T19:20:21Z" },
    ]);
  });

  it("hashes direct-child claims with the shared v1 serialization", () => {
    const signedAt = "2026-05-18T12:00:00Z";
    const claims = buildSignedClaims("Alice Example", signedAt, {
      ContentType: "Article",
      License: "MIT",
      AIAssistance: "AI-only",
    });

    expect(claims).toEqual({
      author: "Alice Example",
      "signed-at": signedAt,
      "claim:ContentType": "Article",
      "claim:License": "MIT",
      "claim:AIAssistance": "AI-only",
    });

    const canonical = [
      "author:Alice Example\n",
      "claim\\:AIAssistance:AI-only\n",
      "claim\\:ContentType:Article\n",
      "claim\\:License:MIT\n",
      `signed-at:2026-05-18T12\\:00\\:00Z\n`,
    ].join("");
    expect(computeClaimsHash(claims)).toBe(`sha256:${sha256B64(canonical)}`);
  });

  it("builds the frozen v1 RFC8785 payload from the final document URL", () => {
    const payload = buildV1SigningPayload({
      contentHash: "sha256:IVAwpRTDujszmYf76W497alVTtxGCgtJtQlasiFSCM8",
      claimsHash: "sha256:Fk5udwCnu1au8v5oaBsU+aSB5S2zSLqoF0xXO6HrIn4",
      documentURL: "https://example.com/essays/engines#analysis",
      scope: "url",
      keyid: "https://keys.example/alice-2026.json",
      algorithm: "ed25519",
      signedAt: "2026-01-15T12:00:00Z",
    });

    expect(payload).toBe(
      '{"algorithm":"ed25519","attributeProfile":"htmltrust-attrs-v1",' +
        '"canonicalizationProfile":"htmltrust-c14n-v1",' +
        '"claimsHash":"sha256:Fk5udwCnu1au8v5oaBsU+aSB5S2zSLqoF0xXO6HrIn4",' +
        '"contentHash":"sha256:IVAwpRTDujszmYf76W497alVTtxGCgtJtQlasiFSCM8",' +
        '"context":"https://htmltrust.org/protocol/signed-section",' +
        '"keyid":"https://keys.example/alice-2026.json",' +
        '"location":"https://example.com/essays/engines",' +
        '"profile":"htmltrust-signature-v1","scope":"url",' +
        '"signedAt":"2026-01-15T12:00:00Z","urlProfile":"htmltrust-safe-url-v1"}',
    );
  });

  it("covers signed semantic attributes in content hashes", () => {
    const origin = "https://author.example";
    const original = computeContentHashFromHtml(
      '<article><p><a href="/story" aria-label="Read the story">Read</a><img src="/hero.png" alt="Hero image"></p></article>',
      origin,
    );
    const changedHref = computeContentHashFromHtml(
      '<article><p><a href="/other" aria-label="Read the story">Read</a><img src="/hero.png" alt="Hero image"></p></article>',
      origin,
    );
    const changedAlt = computeContentHashFromHtml(
      '<article><p><a href="/story" aria-label="Read the story">Read</a><img src="/hero.png" alt="Different image"></p></article>',
      origin,
    );

    expect(original).toMatch(/^sha256:[A-Za-z0-9+/]+$/);
    expect(original).not.toContain("=");
    expect(changedHref).not.toBe(original);
    expect(changedAlt).not.toBe(original);
  });
});
