import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateNginxConfig } from "../../src/lib/nginx-config.js";
import type { AuthorProfile } from "../../src/types.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generateNginxConfig", () => {
  it("routes WordPress and Hugo authors over HTTP and test TLS", async () => {
    const directory = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "htmltrust-nginx-config-"));
    scratch.push(directory);
    const output = path.join(directory, "nginx.conf");
    const authors = [
      {
        id: "wp",
        name: "WordPress author",
        authorApiKey: "key",
        keyId: "key-id",
        cmsType: "wordpress",
        domain: "author1.htmltrust.test",
        malicious_pct: 0,
        wpContainerName: "wp-1",
      },
      {
        id: "hugo",
        name: "Hugo author",
        authorApiKey: "key",
        keyId: "key-id",
        cmsType: "hugo",
        domain: "author2.htmltrust.test",
        malicious_pct: 0,
      },
    ] satisfies AuthorProfile[];

    await generateNginxConfig(authors, output);
    const config = await readFile(output, "utf8");

    expect(config).toContain("listen 80; listen 443 ssl;");
    expect(config).toContain("ssl_certificate /etc/nginx/certs/htmltrust.test.crt;");
    expect(config).toContain("server_name author1.htmltrust.test;");
    expect(config).toContain("proxy_pass http://wp-1:80;");
    expect(config).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    expect(config).toContain("server_name author2.htmltrust.test;");
    expect(config).toContain("root /var/www/hugo/author2;");
    expect(config).toContain("server_name trust.htmltrust.test;");
    expect(config).toContain("proxy_pass http://trust-server:3000;");
    expect(config).toContain("listen 443 ssl default_server;");
  });
});
