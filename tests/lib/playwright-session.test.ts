import { describe, expect, it } from "vitest";
import {
  captureSourceSnapshot,
  createDirectoryEvidenceFetch,
  evaluateFederatedTrust,
  mapSourceSnapshot,
} from "../../src/lib/playwright-session.js";
import type { TrustDirectoryConfig } from "../../src/types.js";

const directories = [
  {
    id: "alpha",
    url: "http://localhost:3000",
    container_url: "http://trust-directory-alpha:3000",
    public_url: "https://trust-a.htmltrust.test",
    weight: 1,
    publisher: true,
    reports: false,
    initial_opinion: "support",
    general_api_key: "general",
    admin_api_key: "admin",
  },
  {
    id: "beta",
    url: "http://localhost:3001",
    container_url: "http://trust-directory-beta:3000",
    public_url: "https://trust-b.htmltrust.test",
    weight: 0.5,
    publisher: false,
    reports: true,
    initial_opinion: "challenge",
    general_api_key: "general",
    admin_api_key: "admin",
  },
] satisfies TrustDirectoryConfig[];

const verify = {
  valid: true,
  keyid: "https://trust-a.htmltrust.test/keys/k_test",
  algorithm: "ed25519",
  contentHash: "sha256:content",
  claimsHash: "sha256:claims",
  claims: {},
  signedAt: "2026-08-28T12:00:00Z",
  domain: "https://author.htmltrust.test",
  origin: "https://author.htmltrust.test",
  inputState: "rendered-match" as const,
};

describe("browser lifecycle evidence", () => {
  it("fails closed when response source capture or identity mapping is incomplete", () => {
    expect(mapSourceSnapshot("", ["<signed-section />"], ["id"], ["id"])).toEqual({
      complete: false,
      sourceByLiveIndex: [null],
    });
    expect(mapSourceSnapshot("<signed-section />", ["<signed-section />"], ["source"], ["live"])).toEqual({
      complete: false,
      sourceByLiveIndex: [null],
    });
    expect(mapSourceSnapshot(
      "<signed-section />",
      ["source-one", "source-two"],
      ["duplicate", "duplicate"],
      ["duplicate", "duplicate"],
    )).toEqual({ complete: true, sourceByLiveIndex: ["source-one", "source-two"] });
  });

  it("resets the frozen source snapshot on reload and fails closed on a read error", async () => {
    const first = await captureSourceSnapshot(
      { text: async () => '<signed-section profile="one"></signed-section>', url: () => "https://example.test/one" },
      "https://example.test/requested-one",
    );
    const second = await captureSourceSnapshot(
      { text: async () => '<signed-section profile="two"></signed-section>', url: () => "https://example.test/two" },
      "https://example.test/requested-two",
    );
    const failed = await captureSourceSnapshot(
      { text: async () => { throw new Error("body unavailable"); }, url: () => "https://example.test/failed" },
      "https://example.test/requested-failed",
    );

    expect(first.html).toContain('profile="one"');
    expect(second.html).toContain('profile="two"');
    expect(second.html).not.toContain('profile="one"');
    expect(failed).toEqual({ html: "", url: "https://example.test/requested-failed", sections: [] });
  });
});

describe("federated directory evidence", () => {
  it("records exact signer routes and conflicting weighted contributions", async () => {
    const calls: string[] = [];
    const transport: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const score = new URL(url).hostname === "trust-a.htmltrust.test" ? 0.9 : 0.1;
      return new Response(JSON.stringify({ score, reports: 0 }), { status: 200 });
    };

    const result = await evaluateFederatedTrust(verify, {
      personalTrustList: [],
      directorySubscriptions: directories.map((directory) => ({
        id: directory.id,
        url: directory.public_url,
        weight: directory.weight,
      })),
    }, directories, transport);

    const encoded = encodeURIComponent(verify.keyid);
    expect(calls).toEqual([
      `https://trust-a.htmltrust.test/signers/${encoded}/reputation`,
      `https://trust-b.htmltrust.test/signers/${encoded}/reputation`,
    ]);
    expect(result.directoryResults.map((entry) => entry.status)).toEqual(["ok", "ok"]);
    expect(result.directoryResults.map((entry) => entry.contribution)).toEqual([16, -8]);
    expect(result.trust.score).toBe(58);
    expect(result.directoryResults.every((entry) => entry.latencyMs >= 0)).toBe(true);
  });

  it("records no-opinion and malformed responses without inventing scores", async () => {
    const result = await evaluateFederatedTrust(verify, {
      personalTrustList: [],
      directorySubscriptions: directories.map((directory) => ({
        id: directory.id,
        url: directory.public_url,
        weight: directory.weight,
      })),
    }, directories, async (input) => {
      return new URL(String(input)).hostname === "trust-a.htmltrust.test"
        ? new Response(JSON.stringify({ type: "no-opinion" }), { status: 404 })
        : new Response(JSON.stringify({ score: "high" }), { status: 200 });
    });

    expect(result.trust.score).toBe(50);
    expect(result.directoryResults.map((entry) => entry.status)).toEqual(["unavailable", "malformed"]);
    expect(result.directoryResults.every((entry) => entry.score === undefined)).toBe(true);
  });

  it("records reports and preserves the policy override", async () => {
    const result = await evaluateFederatedTrust(verify, {
      personalTrustList: [verify.keyid],
      directorySubscriptions: directories.map((directory) => ({
        id: directory.id,
        url: directory.public_url,
        weight: directory.weight,
      })),
    }, directories, async () => new Response(JSON.stringify({ score: 0.5, reports: 1 }), { status: 200 }));

    expect(result.reports).toBe(2);
    expect(result.trust.indicator).toBe("red");
    expect(result.directoryResults.map((entry) => entry.reports)).toEqual([1, 1]);
  });

  it("maps container URLs to stable directory identifiers", async () => {
    const evidence = createDirectoryEvidenceFetch(
      directories,
      async () => new Response(JSON.stringify({ score: 0.75 }), { status: 200 }),
    );
    await evidence.fetchImpl("http://trust-directory-beta:3000/signers/test/reputation");
    expect(evidence.results).toHaveLength(1);
    expect(evidence.results[0].directoryId).toBe("beta");
    expect(evidence.results[0].url).toBe("https://trust-b.htmltrust.test");
  });
});
