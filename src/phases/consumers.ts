import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConsumerSession } from "../lib/playwright-session.js";
import type {
  ScenarioConfig,
  AuthorProfile,
  Article,
  ConsumerProfile,
  SessionLog,
  PhaseResult,
  TrustDirectoryConfig,
  PageVisit,
  TrustIndicator,
} from "../types.js";

/**
 * Check the browser-client's default score thresholds and report override.
 * Directory votes can move a personally trusted signer below the green
 * threshold, so membership in the personal list alone is not an expected
 * final indicator.
 */
export function expectedTrustIndicator(
  visit: Pick<PageVisit, "trustScore" | "directoryResults">,
): TrustIndicator {
  if (visit.directoryResults.some((result) => (result.reports ?? 0) > 0)) return "warning";
  if (visit.trustScore < 20) return "warning";
  if (visit.trustScore >= 70) return "trusted";
  return "verified-unknown";
}

export async function runPhase3(
  config: ScenarioConfig, authors: AuthorProfile[], articles: Article[],
  consumers: ConsumerProfile[], directories: TrustDirectoryConfig[], e2eDir: string
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
      runConsumerSession({ consumer: c, authors, articles, directories, screenshotDir: ssDir })
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
      const expected = expectedTrustIndicator(v);
      if (v.trustIndicator !== expected) indMismatch++;
    }
  }
  if (sigFails > 0) {
    const reasonCounts = new Map<string, number>();
    for (const visit of sessionLogs.flatMap((log) => log.pagesVisited).filter((visit) => !visit.signatureValid)) {
      const reason = visit.verificationReason || "unknown";
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    const summary = [...reasonCounts].map(([reason, count]) => `${reason} (${count})`).join(", ");
    errors.push(`${sigFails} signature verification failures: ${summary}`);
  }
  if (indMismatch > 0) errors.push(`${indMismatch} trust indicator mismatches`);

  console.log(`[Phase 3] ${sessionLogs.length} sessions, ${sigFails} sig failures, ${indMismatch} indicator mismatches`);
  return { result: { phase: "consumers", success: errors.length === 0, duration: Date.now() - start, errors }, sessionLogs };
}
