import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConsumerSession } from "../lib/playwright-session.js";
import type { ScenarioConfig, AuthorProfile, Article, ConsumerProfile, SessionLog, PhaseResult } from "../types.js";

export async function runPhase3(
  config: ScenarioConfig, authors: AuthorProfile[], articles: Article[],
  consumers: ConsumerProfile[], extensionPath: string, e2eDir: string
): Promise<{ result: PhaseResult; sessionLogs: SessionLog[] }> {
  const errors: string[] = [];
  const start = Date.now();
  const sessionLogs: SessionLog[] = [];
  const ssDir = path.join(e2eDir, "results/screenshots/phase3");
  await mkdir(ssDir, { recursive: true });

  const bs = config.consumers.batch_size;
  const total = Math.ceil(consumers.length / bs);

  for (let b = 0; b < total; b++) {
    const batch = consumers.slice(b * bs, (b + 1) * bs);
    console.log(`[Phase 3] Batch ${b + 1}/${total} (${batch.length} consumers)...`);
    const results = await Promise.allSettled(batch.map((c) =>
      runConsumerSession({ consumer: c, authors, articles, extensionPath, screenshotDir: ssDir })
    ));
    for (const r of results) {
      if (r.status === "fulfilled") sessionLogs.push(r.value);
      else errors.push(`Session failed: ${r.reason}`);
    }
  }

  await writeFile(path.join(e2eDir, "results/session-logs.json"), JSON.stringify(sessionLogs, null, 2));

  let sigFails = 0, indMismatch = 0;
  for (const log of sessionLogs) {
    for (const v of log.pagesVisited) {
      if (!v.signatureValid) sigFails++;
      const expected = log.trustedAuthors.includes(v.authorId) ? "trusted" : "verified-unknown";
      if (v.trustIndicator !== expected) indMismatch++;
    }
  }
  if (sigFails > 0) errors.push(`${sigFails} signature verification failures`);
  if (indMismatch > 0) errors.push(`${indMismatch} trust indicator mismatches`);

  console.log(`[Phase 3] ${sessionLogs.length} sessions, ${sigFails} sig failures, ${indMismatch} indicator mismatches`);
  return { result: { phase: "consumers", success: errors.length === 0, duration: Date.now() - start, errors }, sessionLogs };
}
