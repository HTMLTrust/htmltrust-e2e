import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import {
  verifySignedSection,
  extractSignedSections,
  evaluateTrustPolicy,
  type VerifyResult,
  type TrustEvaluation,
  type TrustInput,
} from "@htmltrust/browser-client";
import { directUrlResolver } from "@htmltrust/canonicalization";
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
  generalApiKey: string;
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
 * Fetch the isolated test directory through Nginx while accepting its
 * generated self-signed certificate. Other destinations retain Node's normal
 * certificate validation. The production extension uses the browser trust
 * store and never calls this helper.
 */
async function fetchTestKeyDocument(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "trust.htmltrust.test") return fetch(input, init);
  if (url.protocol !== "https:") throw new Error("test directory key URL must use HTTPS");

  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(url, {
      method: init?.method || "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      rejectUnauthorized: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode || 500,
          statusText: res.statusMessage,
          headers: res.headers as HeadersInit,
        }));
      });
    });
    req.on("error", reject);
    req.end();
  });
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

export interface SourceSnapshotCapture {
  html: string;
  url: string;
  sections: string[];
}

/**
 * Capture a response body for one navigation. A failed read deliberately
 * returns an empty snapshot; the page walker treats that as unverifiable.
 * Keeping this helper outside the browser makes the reload/reset contract
 * directly testable without requiring a local Chromium download.
 */
export async function captureSourceSnapshot(
  response: { text(): Promise<string>; url(): string } | null,
  requestedUrl: string,
): Promise<SourceSnapshotCapture> {
  if (!response) return { html: "", url: requestedUrl, sections: [] };
  try {
    const html = await response.text();
    return {
      html,
      url: response.url() || requestedUrl,
      sections: extractSignedSections(html),
    };
  } catch {
    return { html: "", url: requestedUrl, sections: [] };
  }
}

export interface SourceSnapshotMapping {
  complete: boolean;
  sourceByLiveIndex: Array<string | null>;
}

/**
 * Match frozen response slices to live sections by their signature-bearing
 * identity. Every section must map exactly once. No caller may substitute the
 * live outerHTML when this check fails.
 */
export function mapSourceSnapshot(
  sourceHtml: string,
  sourceSections: readonly string[],
  sourceIdentities: readonly string[],
  liveIdentities: readonly string[],
): SourceSnapshotMapping {
  const empty = () => ({ complete: false, sourceByLiveIndex: liveIdentities.map(() => null) });
  if (!sourceHtml || sourceSections.length === 0 || sourceSections.length !== sourceIdentities.length) return empty();
  if (sourceSections.some((section) => !section) || sourceIdentities.length !== liveIdentities.length) return empty();

  const queues = new Map<string, string[]>();
  sourceIdentities.forEach((identity, index) => {
    const queue = queues.get(identity) ?? [];
    queue.push(sourceSections[index]);
    queues.set(identity, queue);
  });
  const sourceByLiveIndex = liveIdentities.map((identity) => queues.get(identity)?.shift() ?? null);
  const complete = sourceByLiveIndex.every((section) => section !== null) &&
    [...queues.values()].every((queue) => queue.length === 0);
  return { complete, sourceByLiveIndex: complete ? sourceByLiveIndex : liveIdentities.map(() => null) };
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

/** Resolve the legacy author-key URL or the canonical directory-key URL. */
function authorIdFromKeyid(keyid: string, authors: AuthorProfile[]): string | null {
  const m = keyid.match(/\/authors\/([^/]+)/);
  if (m) return m[1];

  try {
    const keyRecordId = new URL(keyid).pathname.match(/\/keys\/([^/]+)$/)?.[1];
    return authors.find((author) => author.keyId === keyRecordId)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Inline DOM walker + badge renderer. Runs in the page context so that
 * `document.querySelectorAll`, `window.location`, and DOM mutation are
 * available. Per signed-section it ships the exact response source and the
 * live outerHTML to the exposed Node-side helper, which calls verifySignedSection /
 * evaluateTrustPolicy from @htmltrust/browser-client.
 *
 * Why Node-side: key resolution uses Docker-only directory URLs, and the
 * library resolver chain is deliberately exercised outside page CORS.
 */
export const DOM_SCRIPT_BODY = `
  const results = [];
  const snapshot = window.__htmltrustSourceSnapshot || { html: "", url: window.location.href, sections: [] };
  const sourceDocument = new DOMParser().parseFromString(snapshot.html || "", "text/html");
  const sourceNodes = Array.from(sourceDocument.querySelectorAll("signed-section"));
  const identityAttributes = ["profile", "signature-scope", "signature", "keyid", "algorithm", "content-hash"];
  const identity = (section) => identityAttributes.map((name) => name + "=" + (section.getAttribute(name) || "")).join("\\u001f");
  const sourceByIdentity = new Map();
  sourceNodes.forEach((section, index) => {
    const key = identity(section);
    const queue = sourceByIdentity.get(key) || [];
    queue.push(Array.isArray(snapshot.sections) ? snapshot.sections[index] || "" : "");
    sourceByIdentity.set(key, queue);
  });
  const sourceBaseElement = sourceDocument.querySelector("base[href]");
  let sourceBaseUrl = snapshot.url;
  if (sourceBaseElement) {
    try {
      sourceBaseUrl = new URL(sourceBaseElement.getAttribute("href") || "", snapshot.url).href;
    } catch {
      sourceBaseUrl = snapshot.url;
    }
  }
  const sections = Array.from(document.querySelectorAll("signed-section"));
  const markerBySection = new WeakMap();
  const liveIdentityCounts = new Map();
  sections.forEach((section) => {
    const key = identity(section);
    liveIdentityCounts.set(key, (liveIdentityCounts.get(key) || 0) + 1);
  });
  const sourceMappingComplete = Boolean(snapshot.html) &&
    sourceNodes.length === sections.length &&
    Array.isArray(snapshot.sections) &&
    snapshot.sections.length === sourceNodes.length &&
    snapshot.sections.every((sourceHtml) => typeof sourceHtml === "string" && sourceHtml.length > 0) &&
    sourceNodes.every((section) => (sourceByIdentity.get(identity(section)) || []).length > 0) &&
    [...sourceByIdentity.entries()].every(([key, queue]) => queue.length === (liveIdentityCounts.get(key) || 0));
  for (const section of sections) {
    const origin = new URL(snapshot.url).origin;
    const renderedHtml = section.outerHTML;
    const sourceHtml = sourceMappingComplete ? (sourceByIdentity.get(identity(section)) || []).shift() || "" : "";
    // An unavailable or incomplete response snapshot is an unverifiable
    // section. Never replace the signed source with repaired live DOM bytes.
    const html = sourceHtml;

    // Best-effort author display name from inner <meta name="author">,
    // preserved purely for badge data attributes.
    let authorName = "";
    for (const meta of section.querySelectorAll("meta")) {
      if (meta.getAttribute("name") === "author") {
        authorName = meta.getAttribute("content") || "";
        break;
      }
    }

    const score = await window.__htmltrustVerifyAndScore({
      html,
      renderedHtml,
      origin,
      baseUrl: sourceBaseUrl,
      renderedBaseUrl: document.baseURI,
      documentUrl: snapshot.url
    });

    // Map indicator -> legacy class suffix used in tests/reports.
    const indicator = score.trust.indicator === "green" ? "trusted"
      : score.trust.indicator === "red" ? "warning"
      : "verified-unknown";
    const renderedMatch = score.verify.valid === true && score.verify.inputState === "rendered-match";
    const normalizedIndicator = renderedMatch
      ? indicator.replace("verified-unknown", "unknown").replace("warning", "untrusted")
      : "unknown";

    const cryptoValid = score.verify.valid === true;
    const contentHashValid = cryptoValid || (score.verify.reason !== "content-hash-mismatch");

    // --- Inject badges (DOM structure must match the previous impl exactly) ---
    const badges = document.createElement("div");
    badges.className = "cs-verification-badges";
    badges.setAttribute("data-author-id", score.authorId || "");
    badges.setAttribute("data-trust-score", String(score.trust.score));
    badges.style.cssText = "display: flex; gap: 8px; padding: 8px; margin: 8px 0; font-family: sans-serif; font-size: 14px; align-items: center; flex-wrap: wrap;";

    const sigBadge = document.createElement("span");
    if (renderedMatch) {
      sigBadge.className = "cs-verification-badge cs-verification-badge-verified cs-validity-badge";
      sigBadge.textContent = "✓ Signature valid";
      sigBadge.style.cssText = "background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 4px;";
    } else if (cryptoValid) {
      sigBadge.className = "cs-verification-badge cs-verification-badge-warning cs-validity-badge";
      sigBadge.textContent = score.verify.inputState === "stale"
        ? "⚠ Rendered content INVALID (source differs)"
        : "⚠ Source signature valid; rendered content not verified";
      sigBadge.style.cssText = "background: #fff3cd; color: #856404; padding: 4px 8px; border-radius: 4px;";
    } else {
      sigBadge.className = "cs-verification-badge cs-verification-badge-unverified cs-validity-badge";
      sigBadge.textContent = "✗ Signature INVALID";
      sigBadge.style.cssText = "background: #f8d7da; color: #721c24; padding: 4px 8px; border-radius: 4px;";
    }
    badges.appendChild(sigBadge);

    const trustBadge = document.createElement("span");
    trustBadge.className = "cs-trust-badge cs-trust-badge-" + normalizedIndicator;
    trustBadge.textContent = "Trust: " + score.trust.score + "%";
    if (normalizedIndicator === "trusted") {
      trustBadge.style.cssText = "background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 4px;";
    } else if (normalizedIndicator === "untrusted") {
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

    badges.setAttribute("data-verification-state", score.verify.inputState || "source-only");
    const previousBadge = markerBySection.get(section);
    if (previousBadge) previousBadge.remove();
    // Always anchor after the outermost signed section, including nested
    // sections, so extension-owned nodes stay outside signed bytes.
    let anchor = section;
    while (anchor.parentElement && anchor.parentElement.matches("signed-section")) anchor = anchor.parentElement;
    anchor.parentNode && anchor.parentNode.insertBefore(badges, anchor.nextSibling);
    markerBySection.set(section, badges);

    results.push({
      authorId: score.authorId,
      signatureValid: cryptoValid,
      contentHashValid: contentHashValid,
      trustScore: score.trust.score,
      indicator: indicator,
      reports: score.reports,
      verificationInputState: score.verify.inputState,
      verificationReason: score.verify.reason,
    });
    const result = results[results.length - 1];
    const observer = new MutationObserver(() => {
      const badge = markerBySection.get(section);
      if (!badge) return;
      badge.setAttribute("data-verification-state", "stale");
      const sig = badge.querySelector(".cs-validity-badge");
      if (sig) {
        sig.className = "cs-verification-badge cs-verification-badge-warning cs-validity-badge";
        sig.textContent = "⚠ Rendered content INVALID (source differs)";
        sig.style.cssText = "background: #fff3cd; color: #856404; padding: 4px 8px; border-radius: 4px;";
      }
      result.verificationInputState = "stale";
      result.verificationReason = "live content changed";
    });
    observer.observe(section, { attributes: true, characterData: true, childList: true, subtree: true });
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

  // Node-side SHA-256 returns canonical unpadded standard Base64 and keeps
  // verification deterministic across the Docker browser images.
  const nodeHash = async (canonical: string): Promise<string> =>
    createHash("sha256").update(canonical, "utf-8").digest("base64").replace(/=+$/, "");

  // Build the resolver once per session. The signed keyid remains an HTTPS
  // URL and is fetched through Nginx. Only the generated test certificate is
  // accepted by the Node-side verification helper.
  const keyResolvers = [directUrlResolver({ fetch: fetchTestKeyDocument })];

  await context.exposeFunction(
    "__htmltrustVerifyAndScore",
    async (input: { html: string; renderedHtml: string; origin: string; baseUrl: string; renderedBaseUrl: string; documentUrl: string }): Promise<VerifyAndScoreResult> => {
      const verify = await verifySignedSection(input.html, {
        keyResolvers,
        origin: input.origin,
        baseUrl: input.baseUrl,
        renderedBaseUrl: input.renderedBaseUrl,
        documentUrl: input.documentUrl,
        renderedSection: input.renderedHtml,
        hash: nodeHash,
        debug: process.env.HTMLTRUST_DEBUG === "1",
      });

      const authorId = verify.keyid ? authorIdFromKeyid(verify.keyid, authors) : null;

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
        const response = await page.goto(article.url, { waitUntil: "networkidle", timeout: 15_000 });
        // This snapshot is recreated for every navigation. A failed response
        // read therefore cannot leave the previous page's signed bytes live.
        const sourceSnapshot = await captureSourceSnapshot(response, article.url);

        // Preflight the same source/live identity contract in Node. The page
        // walker repeats this check in its own DOM context as a defense in
        // depth, but this keeps the session path itself fail-closed too.
        const identities = await page.evaluate((html) => {
          const names = ["profile", "signature-scope", "signature", "keyid", "algorithm", "content-hash"];
          const identity = (section: Element) => names.map((name) => name + "=" + (section.getAttribute(name) || "")).join("\u001f");
          const sourceDocument = new DOMParser().parseFromString(html || "", "text/html");
          return {
            source: Array.from(sourceDocument.querySelectorAll("signed-section")).map(identity),
            live: Array.from(document.querySelectorAll("signed-section")).map(identity),
          };
        }, sourceSnapshot.html);
        const mapping = mapSourceSnapshot(
          sourceSnapshot.html,
          sourceSnapshot.sections,
          identities.source,
          identities.live,
        );
        const snapshotForPage = mapping.complete
          ? sourceSnapshot
          : { ...sourceSnapshot, sections: [] };

        // Run the DOM walker. It calls __htmltrustVerifyAndScore per
        // signed-section, using only a complete original source snapshot and
        // comparing it to the rendered DOM. Missing source fails closed.
        await page.evaluate((snapshot) => {
          (window as unknown as {
            __htmltrustSourceSnapshot?: { html: string; url: string; sections: string[] };
          }).__htmltrustSourceSnapshot = snapshot;
        }, snapshotForPage);
        const asyncExpression = `(async () => { ${DOM_SCRIPT_BODY} })()`;
        const results = (await page.evaluate(asyncExpression)) as Array<{
          authorId: string | null;
          signatureValid: boolean;
          contentHashValid: boolean;
          trustScore: number;
          indicator: string;
          reports: number;
          verificationInputState: "source-only" | "stale" | "rendered-match";
          verificationReason?: string;
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
          verificationInputState: result?.verificationInputState ?? "source-only",
          verificationReason: result?.verificationReason,
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
              headers: { "Content-Type": "application/json", "X-API-KEY": opts.generalApiKey },
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
          verificationInputState: "source-only",
          verificationReason: err instanceof Error ? err.message : String(err),
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
