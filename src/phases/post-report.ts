import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runConsumerSession } from "../lib/playwright-session.js";
import type { ScenarioConfig, AuthorProfile, Article, ConsumerProfile, SessionLog, PhaseResult } from "../types.js";
import type { ResearcherReport } from "./researcher.js";

export async function runPhase4(
  config: ScenarioConfig, authors: AuthorProfile[], articles: Article[],
  allConsumers: ConsumerProfile[], prevLogs: SessionLog[], reports: ResearcherReport[],
  trustDirectoryUrls: string[], e2eDir: string
): Promise<{ result: PhaseResult; sessionLogs: SessionLog[] }> {
  const errors: string[] = [];
  const start = Date.now();
  const ssDir = path.join(e2eDir, "results/screenshots/phase4");
  await mkdir(ssDir, { recursive: true });

  const reportedIds = new Set(reports.map((r) => r.authorId));
  const eligible = allConsumers.filter((c) => {
    const prev = prevLogs.find((l) => l.consumerId === c.id);
    return prev?.pagesVisited.some((v) => reportedIds.has(v.authorId));
  });
  const selected = eligible.slice(0, config.post_report_consumers).map((c) => ({ ...c, captureScreenshots: true }));

  console.log(`[Phase 4] Re-running ${selected.length} consumers (100% screenshots)...`);
  const sessionLogs: SessionLog[] = [];

  for (let i = 0; i < selected.length; i += config.consumers.batch_size) {
    const batch = selected.slice(i, i + config.consumers.batch_size);
    const results = await Promise.allSettled(batch.map((c) =>
      runConsumerSession({ consumer: c, authors, articles, trustDirectoryUrls, screenshotDir: ssDir })
    ));
    for (const r of results) {
      if (r.status === "fulfilled") sessionLogs.push(r.value);
      else errors.push(`Post-report session failed: ${r.reason}`);
    }
  }

  for (const log of sessionLogs) {
    for (const v of log.pagesVisited) {
      if (reportedIds.has(v.authorId) && v.trustIndicator !== "warning")
        errors.push(`${log.consumerId}: reported author ${v.authorId} showed "${v.trustIndicator}" not "warning"`);
    }
  }

  return { result: { phase: "post-report", success: errors.length === 0, duration: Date.now() - start, errors }, sessionLogs };
}
