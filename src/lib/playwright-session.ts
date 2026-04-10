import { chromium } from "playwright";
import path from "node:path";
import type { ConsumerProfile, AuthorProfile, Article, SessionLog, PageVisit, TrustIndicator } from "../types.js";

interface SessionOptions {
  consumer: ConsumerProfile;
  authors: AuthorProfile[];
  articles: Article[];
  extensionPath: string;
  screenshotDir: string;
}

export async function runConsumerSession(opts: SessionOptions): Promise<SessionLog> {
  const { consumer, authors, articles, extensionPath, screenshotDir } = opts;
  const log: SessionLog = { consumerId: consumer.id, trustedAuthors: consumer.trustedAuthors, pagesVisited: [], votesCast: [], screenshots: [] };

  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-first-run", "--no-default-browser-check"],
  });

  try {
    // Wait for extension service worker
    const sw = context.serviceWorkers().length > 0
      ? context.serviceWorkers()[0]
      : await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const extensionId = new URL(sw.url()).hostname;

    // Pre-configure extension with consumer's trusted authors
    const setupPage = await context.newPage();
    await setupPage.goto(`chrome-extension://${extensionId}/options.html`);
    await setupPage.evaluate((trusted: string[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cr = (globalThis as any).chrome;
      cr.storage.local.set({
        profiles: [{ id: "sim", name: "Sim", isDefault: true, trustDirectoryUrl: "", metadata: {}, createdAt: Date.now(), updatedAt: Date.now() }],
        activeProfile: "sim",
      });
      for (const authorId of trusted) {
        cr.storage.local.set({ [`authorVotes:${authorId}`]: { authorId, vote: "upvote", timestamp: Date.now() } });
      }
    }, consumer.trustedAuthors);
    await setupPage.close();

    const page = await context.newPage();
    for (const authorId of consumer.visitAuthors) {
      const author = authors.find((a) => a.id === authorId || a.name === authorId);
      if (!author) continue;
      const authorArticles = articles.filter((a) => a.authorId === author.id);
      if (authorArticles.length === 0) continue;

      const article = authorArticles[Math.floor(Math.random() * authorArticles.length)];
      try {
        await page.goto(article.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.waitForSelector("signed-section", { timeout: 5_000 }).catch(() => null);
        await page.waitForTimeout(1000);

        const indicator = await page.evaluate((): TrustIndicator => {
          if (document.querySelector(".cs-trust-badge-trusted")) return "trusted";
          if (document.querySelector(".cs-trust-badge-untrusted")) return "warning";
          return "verified-unknown";
        });
        const sigValid = await page.evaluate(() => document.querySelector(".cs-verification-badge-verified") !== null);

        log.pagesVisited.push({ url: article.url, authorId: author.id, timestamp: Date.now(), signatureValid: sigValid, contentHashValid: sigValid, trustIndicator: indicator });

        if (consumer.willVote) {
          const isTrusted = consumer.trustedAuthors.includes(author.id);
          const btn = await page.$(isTrusted ? ".cs-upvote-button" : ".cs-downvote-button");
          if (btn) {
            await btn.click();
            log.votesCast.push({ authorId: author.id, vote: isTrusted ? "TRUST" : "DISTRUST", timestamp: Date.now() });
          }
        }

        if (consumer.captureScreenshots) {
          const ssPath = path.join(screenshotDir, `${consumer.id}-${author.name.replace(/\s/g, "-")}.png`);
          await page.screenshot({ path: ssPath, fullPage: true });
          log.screenshots.push(ssPath);
        }
      } catch {
        log.pagesVisited.push({ url: article.url, authorId: author.id, timestamp: Date.now(), signatureValid: false, contentHashValid: false, trustIndicator: "verified-unknown" });
      }
    }
  } finally {
    await context.close();
  }
  return log;
}
