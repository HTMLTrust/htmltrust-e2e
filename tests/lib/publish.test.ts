import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSignedClaims,
  computeClaimsHash,
  computeContentHashFromHtml,
  hashCanonical,
  serializedOriginForDomain,
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
    expect(serializedOriginForDomain("Author1.HTMLTrust.Test")).toBe("http://author1.htmltrust.test");
    expect(serializedOriginForDomain("https://Author1.HTMLTrust.Test:8443/path")).toBe(
      "https://author1.htmltrust.test:8443",
    );
  });

  it("signs every direct child meta claim with draft newline serialization", () => {
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
      "claim:AIAssistance:AI-only\n",
      "claim:ContentType:Article\n",
      "claim:License:MIT\n",
      `signed-at:${signedAt}\n`,
    ].join("");
    expect(computeClaimsHash(claims)).toBe(`sha256:${sha256B64(canonical)}`);
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
