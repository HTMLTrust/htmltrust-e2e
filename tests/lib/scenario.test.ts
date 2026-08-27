import { describe, it, expect } from "vitest";
import { loadScenario, generateAuthorProfiles, generateConsumerProfiles } from "../../src/lib/scenario.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenarioPath = path.resolve(__dirname, "../../scenario.yaml");

describe("loadScenario", () => {
  it("parses the default scenario.yaml", async () => {
    const config = await loadScenario(scenarioPath);
    expect(config.seed).toBe(42);
    expect(config.authors.count).toBe(10);
    expect(config.authors.cms_split.wordpress).toBe(5);
    expect(config.consumers.count).toBe(1000);
    expect(config.trust_server.url).toBe("http://trust-server:3000");
  });

  it("applies runtime service and credential overrides", async () => {
    const previous = {
      url: process.env.HTMLTRUST_TRUST_SERVER_URL,
      general: process.env.HTMLTRUST_GENERAL_API_KEY,
      admin: process.env.HTMLTRUST_ADMIN_API_KEY,
      proxy: process.env.HTMLTRUST_NGINX_PROXY_URL,
    };
    process.env.HTMLTRUST_TRUST_SERVER_URL = "http://trust.test:3001";
    process.env.HTMLTRUST_GENERAL_API_KEY = "runtime-general";
    process.env.HTMLTRUST_ADMIN_API_KEY = "runtime-admin";
    process.env.HTMLTRUST_NGINX_PROXY_URL = "http://proxy.test:8081";

    try {
      const config = await loadScenario(scenarioPath);
      expect(config.trust_server.url).toBe("http://trust.test:3001");
      expect(config.trust_server.general_api_key).toBe("runtime-general");
      expect(config.trust_server.admin_api_key).toBe("runtime-admin");
      expect(config.nginx_proxy_url).toBe("http://proxy.test:8081");
    } finally {
      if (previous.url === undefined) delete process.env.HTMLTRUST_TRUST_SERVER_URL;
      else process.env.HTMLTRUST_TRUST_SERVER_URL = previous.url;
      if (previous.general === undefined) delete process.env.HTMLTRUST_GENERAL_API_KEY;
      else process.env.HTMLTRUST_GENERAL_API_KEY = previous.general;
      if (previous.admin === undefined) delete process.env.HTMLTRUST_ADMIN_API_KEY;
      else process.env.HTMLTRUST_ADMIN_API_KEY = previous.admin;
      if (previous.proxy === undefined) delete process.env.HTMLTRUST_NGINX_PROXY_URL;
      else process.env.HTMLTRUST_NGINX_PROXY_URL = previous.proxy;
    }
  });
});

describe("generateAuthorProfiles", () => {
  it("generates correct number of authors with CMS split", async () => {
    const config = await loadScenario(scenarioPath);
    const authors = generateAuthorProfiles(config);
    expect(authors).toHaveLength(10);
    expect(authors.filter((a) => a.cmsType === "wordpress")).toHaveLength(5);
    expect(authors.filter((a) => a.cmsType === "hugo")).toHaveLength(5);
  });

  it("assigns domains as authorN.htmltrust.test", async () => {
    const config = await loadScenario(scenarioPath);
    const authors = generateAuthorProfiles(config);
    expect(authors[0].domain).toBe("author1.htmltrust.test");
    expect(authors[9].domain).toBe("author10.htmltrust.test");
  });

  it("assigns malicious_pct from weighted distribution deterministically", async () => {
    const config = await loadScenario(scenarioPath);
    const authors1 = generateAuthorProfiles(config);
    const authors2 = generateAuthorProfiles(config);
    expect(authors1.map((a) => a.malicious_pct)).toEqual(authors2.map((a) => a.malicious_pct));
    const pcts = authors1.map((a) => a.malicious_pct);
    expect(pcts.some((p) => p === 0)).toBe(true);
    expect(pcts.some((p) => p > 0 && p < 1)).toBe(true);
    expect(pcts.some((p) => p === 1)).toBe(true);
  });
});

describe("generateConsumerProfiles", () => {
  it("generates correct count with deterministic output", async () => {
    const config = await loadScenario(scenarioPath);
    const authors = generateAuthorProfiles(config);
    const consumers1 = generateConsumerProfiles(config, authors);
    const consumers2 = generateConsumerProfiles(config, authors);
    expect(consumers1).toHaveLength(1000);
    expect(consumers1[0].trustedAuthors).toEqual(consumers2[0].trustedAuthors);
  });

  it("assigns trusted authors within configured range", async () => {
    const config = await loadScenario(scenarioPath);
    const authors = generateAuthorProfiles(config);
    const consumers = generateConsumerProfiles(config, authors);
    for (const c of consumers) {
      expect(c.trustedAuthors.length).toBeGreaterThanOrEqual(0);
      expect(c.trustedAuthors.length).toBeLessThanOrEqual(5);
    }
  });

  it("assigns screenshot sampling at configured percentage", async () => {
    const config = await loadScenario(scenarioPath);
    const authors = generateAuthorProfiles(config);
    const consumers = generateConsumerProfiles(config, authors);
    const screenshotCount = consumers.filter((c) => c.captureScreenshots).length;
    expect(screenshotCount).toBeGreaterThan(50);
    expect(screenshotCount).toBeLessThan(150);
  });
});
