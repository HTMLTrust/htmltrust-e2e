import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateNginxConfig } from "../../src/lib/nginx-config.js";
import type { AuthorProfile, TrustDirectoryConfig } from "../../src/types.js";

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
        keyId: "key-id",
        directoryIdentities: {},
        cmsType: "wordpress",
        domain: "author1.htmltrust.test",
        malicious_pct: 0,
        wpContainerName: "wp-1",
      },
      {
        id: "hugo",
        name: "Hugo author",
        keyId: "key-id",
        directoryIdentities: {},
        cmsType: "hugo",
        domain: "author2.htmltrust.test",
        malicious_pct: 0,
      },
    ] satisfies AuthorProfile[];
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
        weight: 0.75,
        publisher: false,
        reports: true,
        initial_opinion: "challenge",
        general_api_key: "general",
        admin_api_key: "admin",
      },
    ] satisfies TrustDirectoryConfig[];

    await generateNginxConfig(authors, directories, output);
    const config = await readFile(output, "utf8");

    expect(config).toContain("listen 80; listen 443 ssl;");
    expect(config).toContain("ssl_certificate /etc/nginx/certs/htmltrust.test.crt;");
    expect(config).toContain("server_name author1.htmltrust.test;");
    expect(config).toContain("proxy_pass http://wp-1:80;");
    expect(config).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    expect(config).toContain("server_name author2.htmltrust.test;");
    expect(config).toContain("root /var/www/hugo/author2;");
    expect(config).toContain("server_name trust-a.htmltrust.test;");
    expect(config).toContain("proxy_pass http://trust-directory-alpha:3000;");
    expect(config).toContain("server_name trust-b.htmltrust.test;");
    expect(config).toContain("proxy_pass http://trust-directory-beta:3000;");
    expect(config).toContain("listen 443 ssl default_server;");
    expect(config).toContain("location = /healthz { return 200 'ok'; }");
    expect(config).toContain("location / { return 404; }");
  });
});
