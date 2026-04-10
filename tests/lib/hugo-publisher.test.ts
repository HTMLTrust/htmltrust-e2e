import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HugoPublisher } from "../../src/lib/hugo-publisher.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("HugoPublisher", () => {
  let workDir: string;
  beforeEach(async () => { workDir = await mkdtemp(path.join(tmpdir(), "hugo-test-")); });
  afterEach(async () => { await rm(workDir, { recursive: true, force: true }); });

  it("scaffolds a Hugo site", async () => {
    const pub = new HugoPublisher(workDir, "Author 6", "author6.htmltrust.test");
    await pub.scaffold();
    const config = await readFile(path.join(workDir, "hugo.toml"), "utf-8");
    expect(config).toContain("author6.htmltrust.test");
  });

  it("writes article markdown with HTMLTrust frontmatter", async () => {
    const pub = new HugoPublisher(workDir, "Author 6", "author6.htmltrust.test");
    await pub.scaffold();
    await pub.addArticle({ slug: "test-article", title: "Test", content: "Hello", claims: { ContentType: "Article", License: "MIT", AIAssistance: "None" } });
    const md = await readFile(path.join(workDir, "content/posts/test-article.md"), "utf-8");
    expect(md).toContain('title: "Test"');
    expect(md).toContain("sign: true");
    expect(md).toContain('AIAssistance: "None"');
  });
});
