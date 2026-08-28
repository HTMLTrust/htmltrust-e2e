import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadScenario, generateAuthorProfiles, generateConsumerProfiles } from "./lib/scenario.js";
import { GroundTruthTracker } from "./lib/ground-truth.js";
import { runPhase1 } from "./phases/infrastructure.js";
import { runPhase2 } from "./phases/publish.js";
import { runPhase3 } from "./phases/consumers.js";
import { runPhase35 } from "./phases/researcher.js";
import { runPhase4 } from "./phases/post-report.js";
import { runPhase5 } from "./phases/validate.js";
import type { PhaseResult } from "./types.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(__dirname, "..");

async function main(): Promise<void> {
  const scenarioPath = process.argv[2] || path.join(E2E_DIR, "scenario.yaml");
  console.log(`\nHTMLTrust E2E Simulation\nScenario: ${scenarioPath}\n`);

  const config = await loadScenario(scenarioPath);
  const authors = generateAuthorProfiles(config);
  const tracker = new GroundTruthTracker(config.seed);
  await mkdir(path.join(E2E_DIR, "results"), { recursive: true });

  const results: PhaseResult[] = [];

  try {
    const p1 = await runPhase1(config, authors, E2E_DIR);
    results.push(p1);
    if (!p1.success) throw new Error(`Phase 1 failed: ${p1.errors.join(", ")}`);

    const consumers = generateConsumerProfiles(config, authors);
    tracker.setAuthors(authors);

    const p2 = await runPhase2(config, authors, tracker, E2E_DIR);
    results.push(p2);
    if (!p2.success) throw new Error(`Phase 2 failed: ${p2.errors.join(", ")}`);

    const articles = tracker.getManifest().articles;

    const { result: p3, sessionLogs } = await runPhase3(config, authors, articles, consumers, config.trust_directories, E2E_DIR);
    results.push(p3);

    const { result: p35, reports } = await runPhase35(config, authors, articles, E2E_DIR);
    results.push(p35);

    const { result: p4, sessionLogs: postLogs } = await runPhase4(config, authors, articles, consumers, sessionLogs, reports, config.trust_directories, E2E_DIR);
    results.push(p4);

    const p5 = await runPhase5(config, authors, articles, sessionLogs, postLogs, reports, E2E_DIR);
    results.push(p5);

    // Python analysis
    try {
      await execFileAsync("uv", ["run", "python", "analyze.py", path.join(E2E_DIR, "results")], { cwd: path.join(E2E_DIR, "analysis"), timeout: 30_000 });
    } catch (err) {
      console.warn("Python analysis failed (non-fatal):", err);
    }

    console.log("\n=== Simulation Complete ===");
    for (const r of results) {
      const s = r.success ? "PASS" : "FAIL";
      console.log(`  ${r.phase}: ${s} (${(r.duration / 1000).toFixed(1)}s)${r.errors.length ? ` [${r.errors.length} errors]` : ""}`);
    }
    process.exit(results.every((r) => r.success) ? 0 : 1);
  } catch (err) {
    console.error("\nFatal:", err);
    process.exit(2);
  }
}

main();
