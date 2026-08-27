import { describe, it, expect, vi, beforeEach } from "vitest";
import { TrustApiClient } from "../../src/lib/trust-api.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("TrustApiClient", () => {
  let client: TrustApiClient;
  beforeEach(() => { mockFetch.mockReset(); client = new TrustApiClient("http://trust-server:3000", "general-key", "admin-key"); });

  it("creates an author with correct headers", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ author: { id: "a1", name: "Test" }, authorApiKey: "author-key-1" }) });
    const result = await client.createAuthor({ name: "Test", keyType: "HUMAN", keyAlgorithm: "ED25519" });
    expect(mockFetch).toHaveBeenCalledWith("http://trust-server:3000/api/authors", {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": "general-key" },
      body: JSON.stringify({ name: "Test", keyType: "HUMAN", keyAlgorithm: "ED25519" }),
    });
    expect(result.authorApiKey).toBe("author-key-1");
  });

  it("signs content with author API key and new binding format", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ contentHash: "sha256:abc", claimsHash: "sha256:def", signedAt: "2026-04-10T12:00:00Z", signature: "sig123", algorithm: "ed25519", keyid: "https://directory.test/api/keys/k1", authorId: "a1", domain: "https://example.test", claims: {} }) });
    const result = await client.signContent("author-key-1", {
      contentHash: "sha256:abc",
      claimsHash: "sha256:def",
      signedAt: "2026-04-10T12:00:00Z",
      domain: "https://example.test",
      claims: { author: "Test", "signed-at": "2026-04-10T12:00:00Z", "claim:ContentType": "Article" },
    });
    expect(mockFetch).toHaveBeenCalledWith("http://trust-server:3000/api/content/sign", expect.objectContaining({
      method: "POST", headers: { "Content-Type": "application/json", "X-AUTHOR-API-KEY": "author-key-1" },
    }));
    // Verify the new binding fields are in the request body
    const callArgs = mockFetch.mock.calls[0][1];
    const body = JSON.parse(callArgs.body);
    expect(body.contentHash).toBe("sha256:abc");
    expect(body.claimsHash).toBe("sha256:def");
    expect(body.signedAt).toBe("2026-04-10T12:00:00Z");
    expect(body.domain).toBe("https://example.test");
    expect(body.claims).toEqual({ author: "Test", "signed-at": "2026-04-10T12:00:00Z", "claim:ContentType": "Article" });
    expect(result.signature).toBe("sig123");
    expect(result.keyid).toBe("https://directory.test/api/keys/k1");
  });

  it("casts a vote", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ _id: "v1", voteType: "TRUST" }) });
    await client.vote({ userId: "consumer-1", targetType: "AUTHOR", targetId: "a1", voteType: "TRUST" });
    expect(mockFetch).toHaveBeenCalledWith("http://trust-server:3000/api/votes", expect.objectContaining({ method: "POST" }));
  });

  it("reports a key", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ reportId: "r1", status: "PENDING" }) });
    await client.reportKey("key-1", { reason: "MISINFORMATION", details: "Misleading", evidence: "http://example.test" });
    expect(mockFetch).toHaveBeenCalledWith("http://trust-server:3000/api/directory/keys/key-1/report", expect.objectContaining({ method: "POST" }));
  });

  it("gets key reputation", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ keyId: "key-1", trustScore: 0.95, verifiedSignatures: 10, reports: 0 }) });
    const rep = await client.getKeyReputation("key-1");
    expect(rep.trustScore).toBe(0.95);
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized", text: async () => '{"code":"UNAUTHORIZED"}' });
    await expect(client.createAuthor({ name: "Test", keyType: "HUMAN" })).rejects.toThrow("401");
  });
});
