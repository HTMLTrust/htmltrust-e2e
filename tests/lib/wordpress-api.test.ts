import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WordPressClient } from "../../src/lib/wordpress-api.js";
import * as http from "node:http";

describe("WordPressClient", () => {
  let server: http.Server;
  let port: number;
  let lastRequest: { path: string; method: string; headers: http.IncomingHttpHeaders; body: string } | null;

  beforeEach(async () => {
    lastRequest = null;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { path: req.url || "", method: req.method || "", headers: req.headers, body };
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: 42, link: "http://author1.htmltrust.test/?p=42", status: "publish" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (addr && typeof addr === "object") port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("publishes a post via WP REST API with correct Host header through proxy", async () => {
    const client = new WordPressClient(
      "http://author1.htmltrust.test",
      "admin",
      "admin",
      `http://127.0.0.1:${port}`
    );
    const result = await client.createPost({ title: "Test", content: "<p>Hello</p>", status: "publish" });

    expect(result.id).toBe(42);
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.path).toBe("/wp-json/wp/v2/posts");
    expect(lastRequest!.method).toBe("POST");
    expect(lastRequest!.headers.host).toBe("author1.htmltrust.test");
    expect(lastRequest!.headers.authorization).toMatch(/^Basic /);
    expect(JSON.parse(lastRequest!.body)).toEqual({ title: "Test", content: "<p>Hello</p>", status: "publish" });
  });
});
