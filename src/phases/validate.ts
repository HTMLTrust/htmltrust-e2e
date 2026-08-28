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

  const clients = new Map(config.trust_directories.map((directory) => [
    directory.id,
    new TrustApiClient(directory.url, directory.general_api_key, directory.admin_api_key),
  ]));
  const allLogs = [...sessionLogs, ...postReportLogs];

  const authorSummary = await Promise.all(authors.map(async (a) => {
    const arts = articles.filter((ar) => ar.authorId === a.id);
    const directoryReputation = await Promise.all(config.trust_directories.map(async (directory) => {
      let reputation = { score: 0.5, reports: 0 };
      try {
        reputation = await clients.get(directory.id)!.getSignerReputation(a.keyId);
      } catch {
        // A directory with no local opinion contributes the neutral baseline.
      }
      return {
        directoryId: directory.id,
        weight: directory.weight,
        trustScore: reputation.score,
        reports: reputation.reports,
      };
    }));
    let trustV = 0, distrustV = 0;
    for (const l of allLogs) for (const v of l.votesCast) {
      if (v.authorId === a.id) { if (v.vote === "TRUST") trustV++; else distrustV++; }
    }
    return {
      authorId: a.id, name: a.name, cmsType: a.cmsType, maliciousPct: a.malicious_pct,
      totalArticles: arts.length, maliciousArticles: arts.filter((x) => x.isMalicious).length,
      directoryReputation, trustVotes: trustV, distrustVotes: distrustV,
    };
  }));

  const directoryQueries = allLogs.flatMap((log) =>
    log.pagesVisited.flatMap((visit) => visit.directoryResults)
  );
  const federationConflicts = allLogs.reduce((count, log) => count + log.pagesVisited.filter((visit) => {
    const contributions = visit.directoryResults
      .filter((result) => result.status === "ok" && typeof result.contribution === "number")
      .map((result) => result.contribution as number);
    return contributions.some((value) => value > 0) && contributions.some((value) => value < 0);
  }).length, 0);

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
    directoryQueries: directoryQueries.length,
    directoryFailures: directoryQueries.filter((query) => query.status !== "ok").length,
    averageDirectoryLatencyMs: directoryQueries.length > 0
      ? directoryQueries.reduce((sum, query) => sum + query.latencyMs, 0) / directoryQueries.length
      : 0,
    federationConflicts,
  };

  const malIds = new Set(articles.filter((a) => a.isMalicious).map((a) => a.authorId));
  const repIds = new Set(reports.map((r) => r.authorId));
  const tp = [...repIds].filter((id) => malIds.has(id)).length;
  const fp = [...repIds].filter((id) => !malIds.has(id)).length;
  const fn = [...malIds].filter((id) => !repIds.has(id)).length;
  if (fp > 0) errors.push(`${fp} false positive reports`);

  const detection = { totalMalicious: malIds.size, tp, fp, fn, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1) };

  await writeFile(path.join(resultsDir, "data.json"), JSON.stringify({ authorSummary, consumerStats: stats, detectionStats: detection }, null, 2));

  const csv = "author_id,name,cms,malicious_pct,articles,malicious,trust_votes,distrust_votes,directory_reputation\n"
    + authorSummary.map((a) => {
      const reputation = a.directoryReputation
        .map((entry) => `${entry.directoryId}:${entry.trustScore.toFixed(3)}:${entry.reports}`)
        .join(";");
      return `${a.authorId},${a.name},${a.cmsType},${a.maliciousPct},${a.totalArticles},${a.maliciousArticles},${a.trustVotes},${a.distrustVotes},${reputation}`;
    }).join("\n");
  await writeFile(path.join(resultsDir, "summary.csv"), csv);

  const report = `# HTMLTrust E2E Results\n\n## Config\n- Seed: ${config.seed}\n- Authors: ${authors.length}\n- Consumers: ${config.consumers.count}\n- Articles: ${articles.length}\n- Directories: ${config.trust_directories.map((directory) => directory.id).join(", ")}\n\n## Verification\n- Successes: ${stats.verificationSuccesses}\n- Failures: ${stats.verificationFailures}\n- Source/rendered matches: ${stats.sourceSnapshotMatches}\n- Stale source snapshots: ${stats.staleSourceSnapshots}\n- Source-only verifications: ${stats.sourceOnlyVerifications}\n- Directory queries: ${stats.directoryQueries}\n- Directory failures: ${stats.directoryFailures}\n- Average directory latency: ${stats.averageDirectoryLatencyMs.toFixed(1)} ms\n- Visits with conflicting directory contributions: ${stats.federationConflicts}\n\n## Detection\n- Precision: ${(detection.precision * 100).toFixed(1)}%\n- Recall: ${(detection.recall * 100).toFixed(1)}%\n- False positives: ${fp}\n\n## Authors\n| Name | CMS | Mal% | Directory scores and reports |\n|------|-----|------|------------------------------|\n${authorSummary.map((a) => `| ${a.name} | ${a.cmsType} | ${(a.maliciousPct * 100).toFixed(0)}% | ${a.directoryReputation.map((entry) => `${entry.directoryId}: ${entry.trustScore.toFixed(3)} (${entry.reports} reports)`).join("<br>")} |`).join("\n")}\n`;
  await writeFile(path.join(resultsDir, "report.md"), report);

  console.log(`[Phase 5] Results exported to ${resultsDir}`);
  return { phase: "validate", success: errors.length === 0, duration: Date.now() - start, errors };
}
