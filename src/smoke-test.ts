/**
 * Smoke test: runs Phase 1 (partial) and Phase 2 against a live Docker stack.
 * Assumes `docker compose up -d` has already been run.
 * Usage: node --import tsx src/smoke-test.ts [scenario.yaml]
 */
import path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import { fileURLToPath } from "node:url";
import { loadScenario, generateAuthorProfiles } from "./lib/scenario.js";
import { TrustApiClient } from "./lib/trust-api.js";
import { GroundTruthTracker } from "./lib/ground-truth.js";
import { composeExec } from "./lib/docker.js";
import { generateNginxConfig } from "./lib/nginx-config.js";
import { runPhase2 } from "./phases/publish.js";

async function rawHttpGet(
  proxyProtocol: "http:" | "https:",
  proxyHost: string,
  proxyPort: number,
  siteHost: string,
  reqPath: string,
  maxRedirects = 5
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = proxyProtocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: proxyHost,
        port: proxyPort,
        path: reqPath,
        method: "GET",
        headers: { Host: siteHost },
        ...(proxyProtocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      async (res) => {
        // Follow redirects with Host header preserved
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
          res.resume(); // drain
          try {
            const loc = res.headers.location;
            const nextPath = loc.startsWith("http")
              ? new URL(loc).pathname + new URL(loc).search
              : loc;
            const result = await rawHttpGet(proxyProtocol, proxyHost, proxyPort, siteHost, nextPath, maxRedirects - 1);
            resolve(result);
          } catch (err) {
            reject(err);
          }
          return;
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(__dirname, "..");

async function main(): Promise<void> {
  const scenarioPath = process.argv[2] || path.join(E2E_DIR, "scenario-small.yaml");
  console.log(`\nSmoke Test\nScenario: ${scenarioPath}\n`);

  const config = await loadScenario(scenarioPath);
  const authors = generateAuthorProfiles(config);
  const tracker = new GroundTruthTracker(config.seed);

  // Generate nginx.conf from the scenario and reload nginx.
  // We use `nginx -s reload` with retry to handle the case where nginx is
  // still initializing (PID file not yet created). If reload repeatedly
  // fails, fall back to restarting the container, which is slower but
  // always works.
  console.log("=== Regenerating nginx.conf ===");
  await generateNginxConfig(authors, path.join(E2E_DIR, ".runtime", "nginx.conf"));

  let reloaded = false;
  for (let attempt = 0; attempt < 5 && !reloaded; attempt++) {
    try {
      await composeExec(E2E_DIR, "nginx", ["nginx", "-s", "reload"]);
      reloaded = true;
    } catch {
      // Wait briefly and retry
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!reloaded) {
    console.log("  nginx reload failed, restarting container instead");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("docker", ["compose", "restart", "nginx"], { cwd: E2E_DIR });
  }
  console.log("  nginx ready\n");

  const client = new TrustApiClient(
    config.trust_server.url,
    config.trust_server.general_api_key,
    config.trust_server.admin_api_key
  );

  // --- Phase 1 (manual, since Docker is already running) ---
  console.log("=== Phase 1: Setup ===");

  // Create claim types
  for (const claim of [
    { name: "ContentType", description: "Type of content", possibleValues: ["Article", "Opinion", "News"] },
    { name: "License", description: "Content license", possibleValues: ["MIT", "CC-BY-4.0", "All Rights Reserved"] },
    { name: "AIAssistance", description: "AI involvement", possibleValues: ["None", "Human+AI", "AI-only"] },
  ]) {
    try { await client.createClaimType(claim); } catch { /* may already exist */ }
  }
  console.log("  Claim types created");

  // Create authors
  for (const author of authors) {
    const result = await client.createAuthor({
      name: author.name,
      keyType: "HUMAN",
      keyAlgorithm: "ED25519",
      description: `${author.cmsType} author`,
      url: `https://${author.domain}`,
    });
    author.id = result.author.id;
    author.authorApiKey = result.authorApiKey;
    const pubKey = await client.getAuthorPublicKey(author.id);
    author.keyId = pubKey.id;
    console.log(`  ${author.name} (${author.cmsType}, mal=${author.malicious_pct}) -> ${author.id}`);
  }

  // Create WP databases + install
  const wpAuthors = authors.filter((a) => a.cmsType === "wordpress");
  for (let i = 0; i < wpAuthors.length; i++) {
    try {
      const rootPassword = process.env.WP_DB_ROOT_PASSWORD || "rootpass";
      await composeExec(E2E_DIR, "wp-db", ["mariadb", "-uroot", `-p${rootPassword}`, "-e", `CREATE DATABASE IF NOT EXISTS wp${i + 1};`]);
      const c = wpAuthors[i].wpContainerName!;
      // Wait a bit for WP to be ready
      await new Promise((r) => setTimeout(r, 3000));
      await composeExec(E2E_DIR, c, [
        "wp", "core", "install",
        `--url=https://${wpAuthors[i].domain}`,
        `--title=${wpAuthors[i].name} Blog`,
        "--admin_user=admin", "--admin_password=admin",
        `--admin_email=admin@test.test`,
        "--skip-email", "--allow-root",
      ]);
      await composeExec(E2E_DIR, c, ["wp", "option", "update", "permalink_structure", "", "--allow-root"]);
      const appPw = (await composeExec(E2E_DIR, c, [
        "wp", "user", "application-password", "create", "admin", "e2e-sim", "--porcelain", "--allow-root",
      ])).trim();
      wpAuthors[i].wpAppPassword = appPw;
      console.log(`  Installed ${c} (app password: ${appPw.slice(0, 8)}...)`);
    } catch (err) {
      console.error(`  WP setup failed for ${wpAuthors[i].name}:`, err);
    }
  }

  // Verify
  for (const author of authors) {
    const pk = await client.getAuthorPublicKey(author.id);
    console.log(`  ${author.name}: key=${pk.id.slice(0, 8)}... algo=${pk.algorithm}`);
  }

  tracker.setAuthors(authors);

  // --- Phase 2: Publish ---
  console.log("\n=== Phase 2: Content Publishing ===");
  const p2result = await runPhase2(config, authors, tracker, E2E_DIR);
  console.log(`\nPhase 2: ${p2result.success ? "PASS" : "FAIL"} (${(p2result.duration / 1000).toFixed(1)}s)`);
  if (p2result.errors.length > 0) {
    console.log("Errors:", p2result.errors);
  }

  // Summary
  const manifest = tracker.getManifest();
  console.log(`\n=== Summary ===`);
  console.log(`Authors: ${manifest.authors.length}`);
  console.log(`Articles: ${manifest.articles.length}`);
  console.log(`Malicious: ${manifest.articles.filter((a) => a.isMalicious).length}`);
  console.log(`Honest: ${manifest.articles.filter((a) => !a.isMalicious).length}`);

  // Verify articles are accessible and contain signed-section
  console.log(`\n=== Verification ===`);
  const proxyUrl = new URL(config.nginx_proxy_url || "https://localhost:18443");
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
    throw new Error(`Unsupported nginx proxy protocol: ${proxyUrl.protocol}`);
  }
  const proxyHost = proxyUrl.hostname;
  const proxyPort = parseInt(proxyUrl.port, 10) || (proxyUrl.protocol === "https:" ? 443 : 80);

  let passing = 0;
  let totalFetched = 0;
  for (const article of manifest.articles) {
    try {
      const parsed = new URL(article.url);
      const res = await rawHttpGet(proxyUrl.protocol, proxyHost, proxyPort, parsed.host, parsed.pathname + parsed.search);
      totalFetched++;
      const hasSignedSection = res.body.includes("signed-section");
      const marker = hasSignedSection ? "[signed]" : "[UNSIGNED]";
      console.log(`  ${article.url} -> ${res.status} ${marker}`);
      if (res.status === 200 && hasSignedSection) passing++;
    } catch (err) {
      console.log(`  ${article.url} -> ERROR: ${err}`);
    }
  }
  console.log(`\n  ${passing}/${totalFetched} articles verified (200 + signed-section present)`);

  if (!p2result.success || totalFetched !== manifest.articles.length || passing !== manifest.articles.length) {
    throw new Error("Smoke test failed: publication or rendered signed-section checks did not pass");
  }

  console.log("\nSmoke test passed.\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
