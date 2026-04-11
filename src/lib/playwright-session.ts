import { chromium } from "playwright";
import path from "node:path";
import type { ConsumerProfile, AuthorProfile, Article, SessionLog, TrustIndicator } from "../types.js";

interface SessionOptions {
  consumer: ConsumerProfile;
  authors: AuthorProfile[];
  articles: Article[];
  screenshotDir: string;
  trustServerUrl: string;   // e.g. "http://trust-server:3000" (from inside Docker)
}

/**
 * Verification script injected into every page before navigation.
 * Implements the HTMLTrust client-side verification flow per the HTML protocol:
 * 1. Find all <signed-section> elements
 * 2. Read keyid / signature / content-hash / claims
 * 3. Verify via trust server
 * 4. Check trust score against consumer's personal trust list
 * 5. Inject cs-trust-badge-{trusted|untrusted|unknown} + cs-verification-badge-{verified|unverified} into the DOM
 */
function buildVerificationScript(trustServerUrl: string, trustedAuthorIds: string[]): string {
  return `(async () => {
    const TRUST_SERVER = ${JSON.stringify(trustServerUrl)};
    const TRUSTED_AUTHORS = new Set(${JSON.stringify(trustedAuthorIds)});

    // Wait for DOM
    if (document.readyState === "loading") {
      await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true }));
    }

    const sections = document.querySelectorAll("signed-section[signature]");
    for (const section of sections) {
      const signature = section.getAttribute("signature");
      const keyid = section.getAttribute("keyid");
      const contentHash = section.getAttribute("content-hash");

      if (!signature || !keyid || !contentHash) continue;

      // Extract author ID from keyid URL (e.g. http://.../api/authors/{id}/public-key)
      const m = keyid.match(/\\/authors\\/([^/]+)/);
      if (!m) continue;
      const authorId = m[1];

      // Extract domain from current page
      const domain = window.location.hostname;

      // Call trust server to verify signature
      let verifyResult = { valid: false, trustScore: 1, reports: 0 };
      try {
        const res = await fetch(TRUST_SERVER + "/api/content/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentHash, domain, authorId, signature }),
        });
        if (res.ok) {
          const data = await res.json();
          verifyResult.valid = !!data.valid;
        }
      } catch (err) {
        console.error("[htmltrust] verify failed:", err);
      }

      // Fetch author key reputation
      try {
        const keyRes = await fetch(TRUST_SERVER + "/api/authors/" + authorId + "/public-key");
        if (keyRes.ok) {
          const key = await keyRes.json();
          const repRes = await fetch(TRUST_SERVER + "/api/directory/keys/" + key.id + "/reputation");
          if (repRes.ok) {
            const rep = await repRes.json();
            verifyResult.trustScore = rep.trustScore ?? 1;
            verifyResult.reports = rep.reports ?? 0;
          }
        }
      } catch (err) {
        console.error("[htmltrust] reputation fetch failed:", err);
      }

      // Decide trust indicator state:
      //   - warning: signature invalid OR author has any reports against them
      //   - trusted: signature valid AND author in consumer's personal trust list
      //   - verified-unknown: signature valid but author not in personal trust list
      let indicator;
      if (!verifyResult.valid || verifyResult.reports > 0) {
        indicator = "warning";
      } else if (TRUSTED_AUTHORS.has(authorId)) {
        indicator = "trusted";
      } else {
        indicator = "verified-unknown";
      }

      // Build badge UI
      const badges = document.createElement("div");
      badges.className = "cs-verification-badges";
      badges.setAttribute("data-author-id", authorId);
      badges.style.cssText = "display: flex; gap: 8px; padding: 8px; margin: 8px 0; font-family: sans-serif; font-size: 14px; border-radius: 6px;";

      const sigBadge = document.createElement("span");
      if (verifyResult.valid) {
        sigBadge.className = "cs-verification-badge cs-verification-badge-verified cs-validity-badge";
        sigBadge.textContent = "\u2713 Signature valid";
        sigBadge.style.cssText = "background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 4px;";
      } else {
        sigBadge.className = "cs-verification-badge cs-verification-badge-unverified cs-validity-badge";
        sigBadge.textContent = "\u2717 Signature INVALID";
        sigBadge.style.cssText = "background: #f8d7da; color: #721c24; padding: 4px 8px; border-radius: 4px;";
      }
      badges.appendChild(sigBadge);

      const trustBadge = document.createElement("span");
      trustBadge.className = "cs-trust-badge cs-trust-badge-" + indicator.replace("verified-unknown", "unknown").replace("warning", "untrusted");
      if (indicator === "trusted") {
        trustBadge.textContent = "\ud83d\udd12 Trusted author";
        trustBadge.style.cssText = "background: #d1ecf1; color: #0c5460; padding: 4px 8px; border-radius: 4px;";
      } else if (indicator === "warning") {
        trustBadge.textContent = "\u26a0\ufe0f Warning: low trust";
        trustBadge.style.cssText = "background: #fff3cd; color: #856404; padding: 4px 8px; border-radius: 4px;";
      } else {
        trustBadge.textContent = "? Unknown author";
        trustBadge.style.cssText = "background: #e2e3e5; color: #383d41; padding: 4px 8px; border-radius: 4px;";
      }
      badges.appendChild(trustBadge);

      // Vote buttons
      const upvote = document.createElement("button");
      upvote.className = "cs-vote-button cs-upvote-button";
      upvote.setAttribute("data-author-id", authorId);
      upvote.setAttribute("data-vote-type", "TRUST");
      upvote.textContent = "\ud83d\udc4d Trust";
      upvote.style.cssText = "cursor: pointer; padding: 4px 8px; border: 1px solid #ccc; background: white; border-radius: 4px;";
      badges.appendChild(upvote);

      const downvote = document.createElement("button");
      downvote.className = "cs-vote-button cs-downvote-button";
      downvote.setAttribute("data-author-id", authorId);
      downvote.setAttribute("data-vote-type", "DISTRUST");
      downvote.textContent = "\ud83d\udc4e Distrust";
      downvote.style.cssText = "cursor: pointer; padding: 4px 8px; border: 1px solid #ccc; background: white; border-radius: 4px;";
      badges.appendChild(downvote);

      // Insert before the signed-section
      section.parentNode.insertBefore(badges, section);

      // Expose result for Playwright to read
      (window).__htmltrustVerified = (window).__htmltrustVerified || [];
      (window).__htmltrustVerified.push({
        authorId,
        signatureValid: verifyResult.valid,
        trustScore: verifyResult.trustScore,
        indicator,
      });
    }
  })();`;
}

export async function runConsumerSession(opts: SessionOptions): Promise<SessionLog> {
  const { consumer, authors, articles, screenshotDir, trustServerUrl } = opts;
  const log: SessionLog = {
    consumerId: consumer.id,
    trustedAuthors: consumer.trustedAuthors,
    pagesVisited: [],
    votesCast: [],
    screenshots: [],
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  // Inject verification script on every page load
  await context.addInitScript(buildVerificationScript(trustServerUrl, consumer.trustedAuthors));

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
        // Give the injected script time to run
        await page.waitForTimeout(500);

        // Read verification results from the page
        const result = await page.evaluate(() => {
          const verified = (window as unknown as { __htmltrustVerified?: Array<{ authorId: string; signatureValid: boolean; trustScore: number; indicator: string }> }).__htmltrustVerified;
          return verified && verified.length > 0 ? verified[0] : null;
        });

        let indicator: TrustIndicator = "verified-unknown";
        let sigValid = false;
        if (result) {
          sigValid = result.signatureValid;
          if (result.indicator === "trusted") indicator = "trusted";
          else if (result.indicator === "warning") indicator = "warning";
          else indicator = "verified-unknown";
        }

        log.pagesVisited.push({
          url: article.url,
          authorId: author.id,
          timestamp: Date.now(),
          signatureValid: sigValid,
          contentHashValid: sigValid,
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
          // Also post via API to guarantee the vote is recorded (browser click doesn't actually do anything yet)
          try {
            await fetch(`${trustServerUrl}/api/votes`, {
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
            `${consumer.id}-${author.name.replace(/\s/g, "-")}-${Date.now()}.png`
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
