import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateArticle } from "../../src/lib/ollama.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("generateArticle", () => {
  beforeEach(() => mockFetch.mockReset());

  it("calls ollama API and returns titled content", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: "Generated article content about technology." }),
    });
    const result = await generateArticle("http://localhost:11434", "llama3.2:3b", { authorName: "Author 1", index: 0 });
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:11434/api/generate", expect.objectContaining({ method: "POST" }));
    expect(result.title).toBeTruthy();
    expect(result.content).toBe("Generated article content about technology.");
  });
});
