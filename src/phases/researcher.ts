import { TrustApiClient } from "../lib/trust-api.js";
import type { ScenarioConfig, AuthorProfile, Article, PhaseResult } from "../types.js";

export interface ResearcherReport {
  articleId: string;
  authorId: string;
  directoryId: string;
  reportId: string;
  reason: string;
  isTruePositive: boolean;
}

export async function runPhase35(
  config: ScenarioConfig, authors: AuthorProfile[], articles: Article[], _e2eDir: string
): Promise<{ result: PhaseResult; reports: ResearcherReport[] }> {
  const errors: string[] = [];
  const start = Date.now();
  const reports: ResearcherReport[] = [];

  if (!config.researcher.enabled) return { result: { phase: "researcher", success: true, duration: 0, errors: [] }, reports };

  const reportingDirectories = config.trust_directories.filter((directory) => directory.reports);
  const clients = new Map(reportingDirectories.map((directory) => [
    directory.id,
    new TrustApiClient(directory.url, directory.general_api_key, directory.admin_api_key),
  ]));

  const preScores: Record<string, number> = {};
  for (const directory of reportingDirectories) {
    const client = clients.get(directory.id)!;
    for (const author of authors) {
      try {
        preScores[`${directory.id}:${author.id}`] = (await client.getSignerReputation(author.keyId)).score;
      } catch {
        preScores[`${directory.id}:${author.id}`] = 0.5;
      }
    }
  }

  console.log("[Phase 3.5] Researcher crawling...");
  const malicious = articles.filter((a) => a.isMalicious);
  console.log(`  ${malicious.length} malicious of ${articles.length} total`);

  for (const article of malicious) {
    const author = authors.find((a) => a.id === article.authorId);
    if (!author) continue;
    for (const directory of reportingDirectories) {
      try {
        const identity = author.directoryIdentities[directory.id];
        const reportData = {
          reason: "MISINFORMATION",
          details: `"${article.title}": ${article.maliciousReason}`,
          evidence: article.url,
        };
        const r = identity.keyRecordId
          ? await clients.get(directory.id)!.reportKey(identity.keyRecordId, reportData)
          : await clients.get(directory.id)!.reportSigner(author.keyId, reportData);
        reports.push({
          articleId: article.id,
          authorId: author.id,
          directoryId: directory.id,
          reportId: r.reportId,
          reason: article.maliciousReason || "",
          isTruePositive: true,
        });
        console.log(`  Reported in ${directory.id}: ${article.title}`);
      } catch (err) {
        errors.push(`Report failed for ${article.id} in ${directory.id}: ${err}`);
      }
    }
  }

  for (const directory of reportingDirectories) {
    const client = clients.get(directory.id)!;
    for (const author of authors) {
      let post = 0.5;
      try {
        post = (await client.getSignerReputation(author.keyId)).score;
      } catch {
        // A directory with no local opinion contributes the neutral baseline.
      }
      const wasReported = reports.some((report) => report.authorId === author.id && report.directoryId === directory.id);
      const pre = preScores[`${directory.id}:${author.id}`] ?? 0;
      if (wasReported && post >= pre && malicious.some((article) => article.authorId === author.id)) {
        errors.push(`${author.name}: score did not decrease after reports in ${directory.id}`);
      }
      if (!wasReported && author.malicious_pct === 0 && post < pre) {
        errors.push(`${author.name}: honest author score decreased in ${directory.id}`);
      }
    }
  }

  return { result: { phase: "researcher", success: errors.length === 0, duration: Date.now() - start, errors }, reports };
}
