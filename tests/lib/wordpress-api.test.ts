import { describe, it, expect, vi, beforeEach } from "vitest";
import { WordPressClient } from "../../src/lib/wordpress-api.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("WordPressClient", () => {
  let client: WordPressClient;
  beforeEach(() => { mockFetch.mockReset(); client = new WordPressClient("http://author1.htmltrust.test", "admin", "admin"); });

  it("publishes a post via WP REST API", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 42, link: "http://author1.htmltrust.test/?p=42", status: "publish" }) });
    const result = await client.createPost({ title: "Test", content: "<p>Hello</p>", status: "publish" });
    expect(mockFetch).toHaveBeenCalledWith("http://author1.htmltrust.test/wp-json/wp/v2/posts", expect.objectContaining({ method: "POST" }));
    expect(result.id).toBe(42);
  });
});
