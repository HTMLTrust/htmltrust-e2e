/**
 * Runs Phases 3, 3.5, 4, and 5 against a running Docker stack.
 * Designed to be executed INSIDE the playwright container, which has:
 *  - Browser binaries preinstalled
 *  - Docker network access to trust-server, nginx, author*.htmltrust.test
 *  - /workspace mounted to the e2e project dir
 *
 * Prerequisites:
 *  - Phases 1-2 have already been run from the host (via smoke-test.ts or orchestrator.ts)
 *  - results/ground-truth.json exists with authors and articles
 *
 * Usage (from host):
 *   docker compose run --rm playwright npx tsx src/run-phases-3-5.ts [scenario.yaml]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { loadScenario, generateAuthorProfiles, generateConsumerProfiles } from "./lib/scenario.js";
import { GroundTruthTracker } from "./lib/ground-truth.js";
import { runPhase3 } from "./phases/consumers.js";
import { runPhase35 } from "./phases/researcher.js";
import { runPhase4 } from "./phases/post-report.js";
import { runPhase5 } from "./phases/validate.js";
import type { PhaseResult, AuthorProfile } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = process.env.E2E_DIR || path.resolve(__dirname, "..");

async function main(): Promise<void> {
  const scenarioPath = process.argv[2] || path.join(E2E_DIR, "scenario-small.yaml");
  console.log(`\nPhases 3-5 Runner\nE2E_DIR: ${E2E_DIR}\nScenario: ${scenarioPath}\n`);

  const config = await loadScenario(scenarioPath);

  // Override trust server URL for in-container execution (use Docker DNS)
  const trustServerUrl = "http://trust-server:3000";
  console.log(`Using trust server: ${trustServerUrl}\n`);

  // Load ground truth from Phases 1-2
  const gtPath = path.join(E2E_DIR, "results/ground-truth.json");
  const manifest = JSON.parse(await readFile(gtPath, "utf-8")) as {
    authors: AuthorProfile[];
    articles: Array<{ id: string; authorId: string; title: string; content: string; url: string; declaredMetadata: unknown; actualMetadata: unknown; isMalicious: boolean; maliciousReason?: string; contentHash?: string; signature?: string }>;
  };

  const authors = manifest.authors;
  if (!authors || authors.length === 0) {
    throw new Error("No authors in ground-truth.json. Run Phases 1-2 first.");
  }

  // Rewrite article URLs to use Docker-internal hostnames
  // (Phases 1-2 used :8080 via host proxy; inside Docker we hit authorN.htmltrust.test directly on port 80)
  const articles = manifest.articles.map((a) => ({
    ...a,
    url: a.url.replace(/:8080\//, "/").replace(/localhost/g, new URL(a.url).hostname || ""),
  })) as unknown as Array<{ id: string; authorId: string; title: string; content: string; url: string; declaredMetadata: { ContentType: string; License: string; AIAssistance: "None" | "Human+AI" | "AI-only" }; actualMetadata: { ContentType: string; License: string; AIAssistance: "None" | "Human+AI" | "AI-only" }; isMalicious: boolean; maliciousReason?: string; contentHash?: string; signature?: string }>;

  console.log(`Loaded ${authors.length} authors, ${articles.length} articles`);
  console.log(`  Authors: ${authors.map((a) => `${a.name}(${a.cmsType})`).join(", ")}`);

  // Also override the scenario's trust server URL for any internal calls
  config.trust_server.url = trustServerUrl;

  // Generate consumer profiles deterministically
  const consumers = generateConsumerProfiles(config, authors);
  console.log(`Generated ${consumers.length} consumer profiles`);

  const results: PhaseResult[] = [];

  // --- Phase 3: Consumer Browsing ---
  console.log("\n=== Phase 3: Consumer Browsing ===");
  const { result: p3, sessionLogs } = await runPhase3(
    config, authors, articles, consumers, trustServerUrl, E2E_DIR
  );
  results.push(p3);
  console.log(`Phase 3: ${p3.success ? "PASS" : "FAIL"} (${(p3.duration / 1000).toFixed(1)}s)`);
  if (p3.errors.length > 0) {
    console.log(`  Errors (${p3.errors.length}):`);
    for (const e of p3.errors.slice(0, 5)) console.log(`    - ${e}`);
  }

  // --- Phase 3.5: Researcher ---
  console.log("\n=== Phase 3.5: Researcher ===");
  const { result: p35, reports } = await runPhase35(config, authors, articles, E2E_DIR);
  results.push(p35);
  console.log(`Phase 3.5: ${p35.success ? "PASS" : "FAIL"} (${(p35.duration / 1000).toFixed(1)}s) -- ${reports.length} reports filed`);
  if (p35.errors.length > 0) {
    console.log(`  Errors:`);
    for (const e of p35.errors) console.log(`    - ${e}`);
  }

  // --- Phase 4: Post-Report Re-visit ---
  console.log("\n=== Phase 4: Post-Report Consumer Pass ===");
  const { result: p4, sessionLogs: postLogs } = await runPhase4(
    config, authors, articles, consumers, sessionLogs, reports, trustServerUrl, E2E_DIR
  );
  results.push(p4);
  console.log(`Phase 4: ${p4.success ? "PASS" : "FAIL"} (${(p4.duration / 1000).toFixed(1)}s) -- ${postLogs.length} sessions`);
  if (p4.errors.length > 0) {
    console.log(`  Errors (${p4.errors.length}):`);
    for (const e of p4.errors.slice(0, 5)) console.log(`    - ${e}`);
  }

  // --- Phase 5: Validation & Export ---
  console.log("\n=== Phase 5: Validation & Export ===");
  const p5 = await runPhase5(config, authors, articles, sessionLogs, postLogs, reports, E2E_DIR);
  results.push(p5);
  console.log(`Phase 5: ${p5.success ? "PASS" : "FAIL"} (${(p5.duration / 1000).toFixed(1)}s)`);

  // Summary
  console.log("\n=== Summary ===");
  for (const r of results) {
    const status = r.success ? "PASS" : "FAIL";
    console.log(`  ${r.phase}: ${status} (${(r.duration / 1000).toFixed(1)}s)${r.errors.length > 0 ? ` [${r.errors.length} errors]` : ""}`);
  }

  const allPassed = results.every((r) => r.success);
  console.log(`\nOverall: ${allPassed ? "ALL PHASES PASSED" : "SOME PHASES FAILED"}`);
  console.log(`Results: ${path.join(E2E_DIR, "results/")}\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(2);
});
