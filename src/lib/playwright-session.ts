import { chromium } from "playwright";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  verifySignedSection,
  evaluateTrustPolicy,
  defaultResolverChain,
  type VerifyResult,
  type TrustEvaluation,
  type TrustInput,
} from "@htmltrust/browser-client";
import type { ConsumerProfile, AuthorProfile, Article, SessionLog, TrustIndicator } from "../types.js";

interface SessionOptions {
  consumer: ConsumerProfile;
  authors: AuthorProfile[];
  articles: Article[];
  screenshotDir: string;
  /**
   * Trust directories the consumer is subscribed to. Used both for
   * key resolution (the resolver chain) and reputation lookups. The
   * orchestrator may pass either a single URL string or an array; the
   * session normalizes both forms.
   */
  trustDirectoryUrls: string[] | string;
}

/** Shape returned by the Node-side __htmltrustVerifyAndScore helper. */
interface VerifyAndScoreResult {
  verify: VerifyResult;
  trust: TrustEvaluation;
  /** Author id extracted from the keyid URL (used downstream for badges/votes). */
  authorId: string | null;
  /** Aggregated report count across queried directories. */
  reports: number;
}

/**
 * Convert a Layer 2 indicator + reports override into the SessionLog's
 * legacy TrustIndicator vocabulary. Kept verbatim with the previous
 * implementation so downstream phase 4 / phase 5 assertions don't break.
 */
function mapIndicator(indicator: TrustEvaluation["indicator"]): TrustIndicator {
  if (indicator === "green") return "trusted";
  if (indicator === "red") return "warning";
  return "verified-unknown";
}

/**
 * Reputation lookup that mirrors the e2e prototype's two-step shape:
 *   1. GET /api/authors/{authorId}/public-key  -> { id: keyId, ... }
 *   2. GET /api/directory/keys/{keyId}/reputation
 *
 * The browser-client lib's evaluateTrustPolicy expects the reputation URL
 * to be `<directory>/keys/<keyid>/reputation` (the spec shape). The e2e
 * trust server uses a different path that requires the keyid lookup
 * round-trip above, so we layer the reports/score handling on top of the
 * lib's evaluateTrustPolicy output instead of relying on its built-in
 * directory subscription path.
 *
 * TODO(directory-shape): once the trust server is extended (or replaced)
 * with a spec-compliant `/keys/{keyid}/reputation` endpoint, switch this
 * to `directorySubscriptions: directories.map(url => ({ url, weight: 1 }))`
 * and drop this helper.
 */
async function fetchReputationFromE2eServer(
  directoryBase: string,
  authorId: string,
): Promise<{ trustScore: number; reports: number } | null> {
  try {
    const keyRes = await fetch(`${directoryBase}/api/authors/${authorId}/public-key`);
    if (!keyRes.ok) return null;
    const key = (await keyRes.json()) as { id?: string };
    if (!key.id) return null;
    const repRes = await fetch(`${directoryBase}/api/directory/keys/${key.id}/reputation`);
    if (!repRes.ok) return null;
    const rep = (await repRes.json()) as { trustScore?: number; reports?: number };
    return {
      trustScore: typeof rep.trustScore === "number" ? rep.trustScore : 0.5,
      reports: typeof rep.reports === "number" ? rep.reports : 0,
    };
  } catch {
    return null;
  }
}

/** Pull authorId out of a `.../authors/{id}/public-key` keyid URL. Null if not that shape. */
function authorIdFromKeyid(keyid: string): string | null {
  const m = keyid.match(/\/authors\/([^/]+)/);
  return m ? m[1] : null;
}

/**
 * Inline DOM walker + badge renderer. Runs in the page context so that
 * `document.querySelectorAll`, `window.location`, and DOM mutation are
 * available. Per signed-section it ships the section's outerHTML to the
 * exposed Node-side helper which calls verifySignedSection /
 * evaluateTrustPolicy from @htmltrust/browser-client.
 *
 * Why Node-side: the simulation runs over plain HTTP, so SubtleCrypto is
 * unavailable in-page; and the lib's resolver chain wants `globalThis.fetch`
 * which behaves more predictably from Node than from the page (which is
 * subject to CORS and same-origin rules per request).
 */
const DOM_SCRIPT_BODY = `
  const results = [];
  const sections = document.querySelectorAll("signed-section[signature]");
  for (const section of sections) {
    const domain = window.location.hostname;
    const html = section.outerHTML;

    // Best-effort author display name from inner <meta name="author">,
    // preserved purely for badge data attributes.
    let authorName = "";
    for (const meta of section.querySelectorAll("meta")) {
      if (meta.getAttribute("name") === "author") {
        authorName = meta.getAttribute("content") || "";
        break;
      }
    }

    const score = await window.__htmltrustVerifyAndScore({ html, domain });

    // Map indicator -> legacy class suffix used in tests/reports.
    const indicator = score.trust.indicator === "green" ? "trusted"
      : score.trust.indicator === "red" ? "warning"
      : "verified-unknown";
    const normalizedIndicator = indicator
      .replace("verified-unknown", "unknown")
      .replace("warning", "untrusted");

    const cryptoValid = score.verify.valid === true;
    const contentHashValid = cryptoValid || (score.verify.reason !== "content hash mismatch");

    // --- Inject badges (DOM structure must match the previous impl exactly) ---
    const badges = document.createElement("div");
    badges.className = "cs-verification-badges";
    badges.setAttribute("data-author-id", score.authorId || "");
    badges.setAttribute("data-trust-score", String(score.trust.score));
    badges.style.cssText = "display: flex; gap: 8px; padding: 8px; margin: 8px 0; font-family: sans-serif; font-size: 14px; align-items: center; flex-wrap: wrap;";

    const sigBadge = document.createElement("span");
    if (cryptoValid) {
      sigBadge.className = "cs-verification-badge cs-verification-badge-verified cs-validity-badge";
      sigBadge.textContent = "✓ Signature valid";
      sigBadge.style.cssText = "background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 4px;";
    } else {
      sigBadge.className = "cs-verification-badge cs-verification-badge-unverified cs-validity-badge";
      sigBadge.textContent = "✗ Signature INVALID";
      sigBadge.style.cssText = "background: #f8d7da; color: #721c24; padding: 4px 8px; border-radius: 4px;";
    }
    badges.appendChild(sigBadge);

    const trustBadge = document.createElement("span");
    trustBadge.className = "cs-trust-badge cs-trust-badge-" + normalizedIndicator;
    trustBadge.textContent = "Trust: " + score.trust.score + "%";
    if (score.trust.score >= 70) {
      trustBadge.style.cssText = "background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 4px;";
    } else if (score.trust.score < 20) {
      trustBadge.style.cssText = "background: #f8d7da; color: #721c24; padding: 4px 8px; border-radius: 4px;";
    } else {
      trustBadge.style.cssText = "background: #fff3cd; color: #856404; padding: 4px 8px; border-radius: 4px;";
    }
    trustBadge.title = score.trust.inputs
      .map(function(r) { return r.source + ": " + r.contribution + " (" + r.rationale + ")"; })
      .join("\\n");
    badges.appendChild(trustBadge);

    const upvote = document.createElement("button");
    upvote.className = "cs-vote-button cs-upvote-button";
    upvote.setAttribute("data-author-id", score.authorId || "");
    upvote.setAttribute("data-vote-type", "TRUST");
    upvote.textContent = "👍 Trust";
    upvote.style.cssText = "cursor: pointer; padding: 4px 8px; border: 1px solid #ccc; background: white; border-radius: 4px;";
    badges.appendChild(upvote);

    const downvote = document.createElement("button");
    downvote.className = "cs-vote-button cs-downvote-button";
    downvote.setAttribute("data-author-id", score.authorId || "");
    downvote.setAttribute("data-vote-type", "DISTRUST");
    downvote.textContent = "👎 Distrust";
    downvote.style.cssText = "cursor: pointer; padding: 4px 8px; border: 1px solid #ccc; background: white; border-radius: 4px;";
    badges.appendChild(downvote);

    section.parentNode.insertBefore(badges, section.nextSibling);

    results.push({
      authorId: score.authorId,
      signatureValid: cryptoValid,
      contentHashValid: contentHashValid,
      trustScore: score.trust.score,
      indicator: indicator,
      reports: score.reports,
    });
  }
  return results;
`;

export async function runConsumerSession(opts: SessionOptions): Promise<SessionLog> {
  const { consumer, authors, articles, screenshotDir } = opts;
  const directoryUrls = Array.isArray(opts.trustDirectoryUrls)
    ? opts.trustDirectoryUrls
    : [opts.trustDirectoryUrls];
  // The first directory in the list is the "primary" used for vote POSTs in
  // the simulation. Multi-directory voting is out of scope for now.
  const primaryDirectoryUrl = directoryUrls[0];

  const log: SessionLog = {
    consumerId: consumer.id,
    trustedAuthors: consumer.trustedAuthors,
    pagesVisited: [],
    votesCast: [],
    screenshots: [],
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  // Node-side SHA-256: returns lowercase hex (verifySignedSection prepends
  // "sha256:"). Used because the simulation pages run over HTTP, where
  // SubtleCrypto is blocked.
  const nodeHash = async (canonical: string): Promise<string> =>
    createHash("sha256").update(canonical, "utf-8").digest("hex");

  // Build the resolver chain once per session. directUrlResolver covers
  // the e2e trust server's keyid URLs (`http://trust-server:.../authors/{id}/public-key`);
  // didWebResolver and trustDirectoryResolver cover the spec-canonical
  // shapes that may appear in future fixtures.
  const keyResolvers = defaultResolverChain({ directories: directoryUrls });

  await context.exposeFunction(
    "__htmltrustVerifyAndScore",
    async (input: { html: string; domain: string }): Promise<VerifyAndScoreResult> => {
      const verify = await verifySignedSection(input.html, {
        keyResolvers,
        domain: input.domain,
        hash: nodeHash,
      });

      const authorId = verify.keyid ? authorIdFromKeyid(verify.keyid) : null;

      // Layer 2 baseline from the lib. We pass an EMPTY directory list
      // because the lib's reputation URL shape (`<base>/keys/<keyid>/reputation`)
      // doesn't match the e2e trust server's two-step lookup. Reports are
      // applied as an override below — see fetchReputationFromE2eServer.
      const trust = await evaluateTrustPolicy(verify, {
        personalTrustList: [], // keyids; e2e maps trust by authorId, layered below
        trustedDomains: [],
        directorySubscriptions: [],
      });

      // Layer the e2e prototype's personal-trust-list (by authorId) on top
      // of evaluateTrustPolicy's score. The lib only knows about keyid
      // matches; the simulation tracks consumer.trustedAuthors as authorIds.
      const extraInputs: TrustInput[] = [];
      let score = trust.score;
      if (verify.valid && authorId && consumer.trustedAuthors.includes(authorId)) {
        score = Math.min(100, score + 40);
        extraInputs.push({
          source: "personal-trust-list",
          contribution: 40,
          rationale: "author in personal trust list (option A)",
        });
      }

      // Reputation from the e2e trust server, aggregated across directories.
      // Any reports trigger the spec's "researcher-flag → red" override.
      let totalReports = 0;
      if (verify.valid && authorId) {
        for (const dir of directoryUrls) {
          const rep = await fetchReputationFromE2eServer(dir, authorId);
          if (!rep) continue;
          totalReports += rep.reports;
          if (rep.reports > 0) {
            // Mirror the previous penalty curve: 35 for the first report,
            // +15 per additional, capped at 60. Keeps phase-3 vs phase-4
            // expectations stable.
            const penalty = Math.min(60, 35 + (rep.reports - 1) * 15);
            score = Math.max(0, score - penalty);
            extraInputs.push({
              source: "directory-reports",
              contribution: -penalty,
              rationale: `${rep.reports} report(s) filed against author at ${dir}`,
            });
          }
        }
      }

      // Recompute the indicator from the layered score; reports force red.
      let indicator: TrustEvaluation["indicator"] = trust.indicator;
      if (verify.valid) {
        indicator = score < 20 ? "red" : score >= 70 ? "green" : "yellow";
      }
      if (totalReports > 0) indicator = "red";

      return {
        verify,
        trust: {
          score,
          indicator,
          inputs: [...trust.inputs, ...extraInputs],
        },
        authorId,
        reports: totalReports,
      };
    },
  );

  try {
    const page = await context.newPage();

    for (const authorId of consumer.visitAuthors) {
      const author = authors.find((a) => a.id === authorId || a.name === authorId);
      if (!author) continue;
      const authorArticles = articles.filter((a) => a.authorId === author.id);
      if (authorArticles.length === 0) continue;

      const article = authorArticles[Math.floor(Math.random() * authorArticles.length)];
      try {
        await page.goto(article.url, { waitUntil: "networkidle", timeout: 15_000 });

        // Run the DOM walker. It calls __htmltrustVerifyAndScore per
        // signed-section, which does verify + policy + reputation Node-side.
        const asyncExpression = `(async () => { ${DOM_SCRIPT_BODY} })()`;
        const results = (await page.evaluate(asyncExpression)) as Array<{
          authorId: string | null;
          signatureValid: boolean;
          contentHashValid: boolean;
          trustScore: number;
          indicator: string;
          reports: number;
        }>;
        const result = results && results.length > 0 ? results[0] : null;

        let indicator: TrustIndicator = "verified-unknown";
        let sigValid = false;
        let contentHashValid = false;
        if (result) {
          sigValid = result.signatureValid;
          contentHashValid = result.contentHashValid;
          if (result.indicator === "trusted") indicator = "trusted";
          else if (result.indicator === "warning") indicator = "warning";
          else indicator = "verified-unknown";
        }

        log.pagesVisited.push({
          url: article.url,
          authorId: author.id,
          timestamp: Date.now(),
          signatureValid: sigValid,
          contentHashValid,
          trustIndicator: indicator,
        });

        // Cast vote by clicking button (and also POST to API for reliability)
        if (consumer.willVote) {
          const isTrusted = consumer.trustedAuthors.includes(author.id);
          const voteType = isTrusted ? "TRUST" : "DISTRUST";
          const selector = isTrusted ? ".cs-upvote-button" : ".cs-downvote-button";
          try {
            await page.click(selector, { timeout: 1000 });
          } catch {
            // Button might not be there if verification failed, that's ok
          }
          // Also post via API to guarantee the vote is recorded
          try {
            await fetch(`${primaryDirectoryUrl}/api/votes`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-API-KEY": "sim_general_key" },
              body: JSON.stringify({
                userId: consumer.id,
                targetType: "AUTHOR",
                targetId: author.id,
                voteType,
              }),
            });
            log.votesCast.push({ authorId: author.id, vote: voteType, timestamp: Date.now() });
          } catch {
            // ignore
          }
        }

        // Screenshot if sampled
        if (consumer.captureScreenshots) {
          const ssPath = path.join(
            screenshotDir,
            `${consumer.id}-${author.name.replace(/\s/g, "-")}-${Date.now()}.png`,
          );
          await page.screenshot({ path: ssPath, fullPage: true });
          log.screenshots.push(ssPath);
        }
      } catch (err) {
        log.pagesVisited.push({
          url: article.url,
          authorId: author.id,
          timestamp: Date.now(),
          signatureValid: false,
          contentHashValid: false,
          trustIndicator: "verified-unknown",
        });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return log;
}

// Mark intentionally-unused mapIndicator so future call sites can pick it
// up without the value disappearing. The Layer 2 -> TrustIndicator mapping
// is small enough to keep here rather than re-deriving.
void mapIndicator;
