import { TrustApiClient } from "../lib/trust-api.js";
import type { ScenarioConfig, AuthorProfile, Article, PhaseResult } from "../types.js";

export interface ResearcherReport {
  articleId: string; authorId: string; reportId: string; reason: string; isTruePositive: boolean;
}

export async function runPhase35(
  config: ScenarioConfig, authors: AuthorProfile[], articles: Article[], _e2eDir: string
): Promise<{ result: PhaseResult; reports: ResearcherReport[] }> {
  const errors: string[] = [];
  const start = Date.now();
  const reports: ResearcherReport[] = [];

  if (!config.researcher.enabled) return { result: { phase: "researcher", success: true, duration: 0, errors: [] }, reports };

  const client = new TrustApiClient(config.trust_server.url, config.trust_server.general_api_key, config.trust_server.admin_api_key);

  const preScores: Record<string, number> = {};
  for (const a of authors) {
    if (a.keyId) preScores[a.id] = (await client.getKeyReputation(a.keyId)).trustScore;
  }

  console.log("[Phase 3.5] Researcher crawling...");
  const malicious = articles.filter((a) => a.isMalicious);
  console.log(`  ${malicious.length} malicious of ${articles.length} total`);

  for (const article of malicious) {
    const author = authors.find((a) => a.id === article.authorId);
    if (!author) continue;
    try {
      const r = await client.reportKey(author.keyId, {
        reason: "MISINFORMATION",
        details: `"${article.title}": ${article.maliciousReason}`,
        evidence: article.url,
      });
      reports.push({ articleId: article.id, authorId: author.id, reportId: r.reportId, reason: article.maliciousReason || "", isTruePositive: true });
      console.log(`  Reported: ${article.title}`);
    } catch (err) {
      errors.push(`Report failed for ${article.id}: ${err}`);
    }
  }

  for (const a of authors) {
    if (!a.keyId) continue;
    const post = (await client.getKeyReputation(a.keyId)).trustScore;
    const wasReported = reports.some((r) => r.authorId === a.id);
    if (wasReported && post >= (preScores[a.id] ?? 0) && malicious.some((m) => m.authorId === a.id))
      errors.push(`${a.name}: score did not decrease after reports`);
    if (!wasReported && a.malicious_pct === 0 && post < (preScores[a.id] ?? 0))
      errors.push(`${a.name}: honest author score decreased`);
  }

  return { result: { phase: "researcher", success: errors.length === 0, duration: Date.now() - start, errors }, reports };
}
