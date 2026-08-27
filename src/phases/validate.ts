import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { TrustApiClient } from "../lib/trust-api.js";
import type { ScenarioConfig, AuthorProfile, Article, SessionLog, PhaseResult } from "../types.js";
import type { ResearcherReport } from "./researcher.js";

export async function runPhase5(
  config: ScenarioConfig, authors: AuthorProfile[], articles: Article[],
  sessionLogs: SessionLog[], postReportLogs: SessionLog[], reports: ResearcherReport[], e2eDir: string
): Promise<PhaseResult> {
  const errors: string[] = [];
  const start = Date.now();
  const resultsDir = path.join(e2eDir, "results");
  await mkdir(resultsDir, { recursive: true });

  const client = new TrustApiClient(config.trust_server.url, config.trust_server.general_api_key, config.trust_server.admin_api_key);
  const allLogs = [...sessionLogs, ...postReportLogs];

  const authorSummary = await Promise.all(authors.map(async (a) => {
    const arts = articles.filter((ar) => ar.authorId === a.id);
    const rep = a.keyId ? await client.getKeyReputation(a.keyId) : { trustScore: 0, reports: 0 };
    let trustV = 0, distrustV = 0;
    for (const l of allLogs) for (const v of l.votesCast) {
      if (v.authorId === a.id) { if (v.vote === "TRUST") trustV++; else distrustV++; }
    }
    return {
      authorId: a.id, name: a.name, cmsType: a.cmsType, maliciousPct: a.malicious_pct,
      totalArticles: arts.length, maliciousArticles: arts.filter((x) => x.isMalicious).length,
      trustScore: rep.trustScore, trustVotes: trustV, distrustVotes: distrustV, reports: rep.reports,
    };
  }));

  const stats = {
    totalSessions: allLogs.length,
    totalPageVisits: allLogs.reduce((s, l) => s + l.pagesVisited.length, 0),
    verificationSuccesses: allLogs.reduce((s, l) => s + l.pagesVisited.filter((v) => v.signatureValid).length, 0),
    verificationFailures: allLogs.reduce((s, l) => s + l.pagesVisited.filter((v) => !v.signatureValid).length, 0),
    sourceSnapshotMatches: allLogs.reduce((s, l) => s + l.pagesVisited.filter((v) => v.verificationInputState === "rendered-match").length, 0),
    staleSourceSnapshots: allLogs.reduce((s, l) => s + l.pagesVisited.filter((v) => v.verificationInputState === "stale").length, 0),
    sourceOnlyVerifications: allLogs.reduce((s, l) => s + l.pagesVisited.filter((v) => v.verificationInputState === "source-only").length, 0),
    totalVotes: allLogs.reduce((s, l) => s + l.votesCast.length, 0),
    screenshots: allLogs.reduce((s, l) => s + l.screenshots.length, 0),
  };

  const malIds = new Set(articles.filter((a) => a.isMalicious).map((a) => a.authorId));
  const repIds = new Set(reports.map((r) => r.authorId));
  const tp = [...repIds].filter((id) => malIds.has(id)).length;
  const fp = [...repIds].filter((id) => !malIds.has(id)).length;
  const fn = [...malIds].filter((id) => !repIds.has(id)).length;
  if (fp > 0) errors.push(`${fp} false positive reports`);

  const detection = { totalMalicious: malIds.size, tp, fp, fn, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1) };

  await writeFile(path.join(resultsDir, "data.json"), JSON.stringify({ authorSummary, consumerStats: stats, detectionStats: detection }, null, 2));

  const csv = "author_id,name,cms,malicious_pct,articles,malicious,trust_score,trust_votes,distrust_votes,reports\n"
    + authorSummary.map((a) => `${a.authorId},${a.name},${a.cmsType},${a.maliciousPct},${a.totalArticles},${a.maliciousArticles},${a.trustScore},${a.trustVotes},${a.distrustVotes},${a.reports}`).join("\n");
  await writeFile(path.join(resultsDir, "summary.csv"), csv);

  const report = `# HTMLTrust E2E Results\n\n## Config\n- Seed: ${config.seed}\n- Authors: ${authors.length}\n- Consumers: ${config.consumers.count}\n- Articles: ${articles.length}\n\n## Verification\n- Successes: ${stats.verificationSuccesses}\n- Failures: ${stats.verificationFailures}\n- Source/rendered matches: ${stats.sourceSnapshotMatches}\n- Stale source snapshots: ${stats.staleSourceSnapshots}\n- Source-only verifications: ${stats.sourceOnlyVerifications}\n\n## Detection\n- Precision: ${(detection.precision * 100).toFixed(1)}%\n- Recall: ${(detection.recall * 100).toFixed(1)}%\n- False positives: ${fp}\n\n## Authors\n| Name | CMS | Mal% | Score | Reports |\n|------|-----|------|-------|---------|\n${authorSummary.map((a) => `| ${a.name} | ${a.cmsType} | ${(a.maliciousPct * 100).toFixed(0)}% | ${a.trustScore.toFixed(3)} | ${a.reports} |`).join("\n")}\n`;
  await writeFile(path.join(resultsDir, "report.md"), report);

  console.log(`[Phase 5] Results exported to ${resultsDir}`);
  return { phase: "validate", success: errors.length === 0, duration: Date.now() - start, errors };
}
