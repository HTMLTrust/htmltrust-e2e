import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildSigningPayloadV1,
  canonicalizeClaims,
  normalizeText,
} from "@htmltrust/canonicalization";
import { canonicalizeSignedContent } from "@htmltrust/browser-client";
import { generateArticle } from "../lib/ollama.js";
import { HugoPublisher } from "../lib/hugo-publisher.js";
import { TrustApiClient } from "../lib/trust-api.js";
import { GroundTruthTracker } from "../lib/ground-truth.js";
import { composeExec, writeFileToContainer } from "../lib/docker.js";
import type { ScenarioConfig, AuthorProfile, AIAssistance, ArticleMetadata, PhaseResult } from "../types.js";

/**
 * Compute a base64-encoded SHA-256 hash of already-canonicalized text.
 * Returns the prefixed form "sha256:<unpadded-base64>".
 */
export function hashCanonical(canonical: string): string {
  const digest = createHash("sha256").update(canonical, "utf-8").digest("base64").replace(/=+$/, "");
  return `sha256:${digest}`;
}

/**
 * Compute the content hash of plain text (not HTML). Applies normalizeText
 * then base64-sha256. Use this at publish time when the raw text is known.
 */
export function computeContentHashFromText(text: string): string {
  const canonical = normalizeText(text).trim().replace(/\s+/g, " ");
  return hashCanonical(canonical);
}

/**
 * Compute the content hash of an HTML fragment using the same signed-content
 * canonicalizer as browser verification. This includes the provisional signed
 * semantic attributes (`href`, `src`, `alt`, and `aria-label`) when present.
 */
export function computeContentHashFromHtml(html: string, baseUrl: string): string {
  const canonical = canonicalizeSignedContent(html, baseUrl);
  return hashCanonical(canonical);
}

/**
 * Compute the claims hash from the exact direct-child <meta> claim map.
 * The frozen v1 profile serializes every normalized claim as an escaped
 * `name:content\n` record, sorted by UTF-8 order, and hashes the result.
 */
export function computeClaimsHash(claims: Record<string, string>): string {
  return hashCanonical(canonicalizeClaims(claims));
}

/**
 * Construct the frozen v1 RFC 8785 signing payload used by browser clients.
 * Keeping this small wrapper in the harness gives publish fixtures one shared
 * entry point while the Docker signer migrates from the compatibility API.
 */
export function buildV1SigningPayload(parts: {
  contentHash: string;
  claimsHash: string;
  documentURL: string;
  scope: "url" | "origin";
  keyid: string;
  algorithm: string;
  signedAt: string;
}): string {
  return buildSigningPayloadV1(parts);
}

export function serializedOriginForDomain(domain: string): string {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(domain) ? domain : `https://${domain}`;
  return new URL(candidate).origin;
}

export function buildSignedClaims(author: string, signedAt: string, claims: ArticleMetadata): Record<string, string> {
  return {
    author,
    "signed-at": signedAt,
    ...Object.fromEntries(Object.entries(claims).map(([key, value]) => [`claim:${key}`, value])),
  };
}

export function claimRecords(claims: Record<string, string>): Array<{ name: string; content: string }> {
  return Object.entries(claims).map(([name, content]) => ({ name, content }));
}

export function v1Timestamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildSignedSectionHtml(opts: {
  profile: "htmltrust-signature-v1";
  scope: "url" | "origin";
  signature: string;
  keyId: string;
  contentHash: string;
  algorithm: string;
  author: string;
  signedAt: string;
  claims: ArticleMetadata;
  innerContentHtml?: string;
}): string {
  const metas = [
    `<meta name="author" content="${escapeAttribute(opts.author)}">`,
    `<meta name="signed-at" content="${escapeAttribute(opts.signedAt)}">`,
    ...Object.entries(opts.claims).map(([k, v]) => `<meta name="claim:${escapeAttribute(k)}" content="${escapeAttribute(v)}">`),
  ].join("\n  ");

  const inner = opts.innerContentHtml ? `\n  ${opts.innerContentHtml}\n` : "\n";

  return `<signed-section profile="${opts.profile}" signature-scope="${opts.scope}" signature="${escapeAttribute(opts.signature)}" keyid="${escapeAttribute(opts.keyId)}" algorithm="${escapeAttribute(opts.algorithm)}" content-hash="${escapeAttribute(opts.contentHash)}">
  ${metas}${inner}</signed-section>`;
}

function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function runPhase2(
  config: ScenarioConfig, authors: AuthorProfile[], tracker: GroundTruthTracker, e2eDir: string
): Promise<PhaseResult> {
  const errors: string[] = [];
  const start = Date.now();
  const rng = createRng(config.seed + 3000);
  const trustClient = new TrustApiClient(config.trust_server.url, config.trust_server.general_api_key, config.trust_server.admin_api_key);
  const [minArt, maxArt] = config.authors.articles_per_author;

  for (const author of authors) {
    const count = minArt + Math.floor(rng() * (maxArt - minArt + 1));
    console.log(`[Phase 2] ${author.name}: generating ${count} articles (${author.cmsType})...`);

    let hugoPub: HugoPublisher | undefined;
    if (author.cmsType === "hugo") {
      hugoPub = new HugoPublisher(path.join(e2eDir, "hugo-sources", author.domain), author.name, author.domain);
      await hugoPub.scaffold();
    }

    for (let i = 0; i < count; i++) {
      try {
        const { title, content } = await generateArticle(config.ollama.host, config.ollama.model, { authorName: author.name, index: i });
        const actualMeta: ArticleMetadata = { ContentType: "Article", License: "MIT", AIAssistance: "AI-only" };

        const isMal = tracker.shouldBeMalicious(author.malicious_pct);
        const declaredAI: AIAssistance = isMal ? (["None", "Human+AI"] as const)[Math.floor(rng() * 2)] : "AI-only";
        const declaredMeta: ArticleMetadata = { ContentType: "Article", License: "MIT", AIAssistance: declaredAI };

        const slug = `article-${i + 1}`;
        let url: string;

        const signedAt = v1Timestamp();
        const signedClaims = buildSignedClaims(author.name, signedAt, declaredMeta);
        const signedClaimRecords = claimRecords(signedClaims);
        const innerContentHtml = `<article><p>${escapeText(content)}</p></article>`;

        if (author.cmsType === "wordpress") {
          // Ask the trust server to sign the binding.
          // NOTE: per spec §3.1 cryptographic verification SHOULD be local; the
          // trust server's /content/sign endpoint is a convenience for holding
          // author private keys on the author's behalf in the "signup" use case.
          //
          // TODO(wp-plugin-handoff): Once the content-signing plugin's
          // publish-time wrapper hook is verified end-to-end, drop the manual
          // <signed-section> injection below and let the plugin do it. The
          // plugin is now activated in infrastructure.ts, but its hook path
          // has not been validated against this harness, so we keep the manual
          // injection as a fallback. Remove this block (and the
          // buildSignedSectionHtml helper, if no other caller uses it) once a
          // full sim run confirms the plugin emits an equivalent
          // <signed-section>.
          // Create a draft first so the signature can bind the final WordPress
          // response URL. The draft body is replaced before publication.
          const c = author.wpContainerName!;
          const draftFile = `/tmp/post-${Date.now()}-${i}.html`;
          await writeFileToContainer(e2eDir, c, draftFile, innerContentHtml);
          const postIdStr = (await composeExec(e2eDir, c, [
            "wp", "post", "create", draftFile,
            `--post_title=${title}`,
            "--post_status=draft",
            "--post_type=post",
            "--porcelain",
            "--allow-root",
          ])).trim();
          await composeExec(e2eDir, c, ["rm", draftFile]);

          const sourceURL = (await composeExec(e2eDir, c, [
            "wp", "post", "url", postIdStr, "--allow-root",
          ])).trim();
          const parsedSourceURL = new URL(sourceURL);
          if (parsedSourceURL.protocol !== "https:" || parsedSourceURL.host !== author.domain) {
            throw new Error(`WordPress returned an unexpected final URL for post ${postIdStr}: ${sourceURL}`);
          }
          const contentHash = computeContentHashFromHtml(innerContentHtml, sourceURL);
          const expectedClaimsHash = computeClaimsHash(signedClaims);
          const sigResult = await trustClient.signContent(author.authorApiKey, {
            contentHash,
            sourceURL,
            scope: "url",
            signedAt,
            claims: signedClaimRecords,
          });
          if (sigResult.claimsHash !== expectedClaimsHash) {
            throw new Error(`claims hash mismatch for ${sourceURL}: local=${expectedClaimsHash} directory=${sigResult.claimsHash}`);
          }

          // Build the signed-section wrapper with the content nested inside.
          // Using the wrapped form (spec §2.1 example): the <signed-section>
          // contains the content, so the browser can extract text from within
          // it unambiguously.
          const keyId = sigResult.keyid;
          const signedSection = buildSignedSectionHtml({
            profile: sigResult.profile,
            scope: sigResult.scope,
            signature: sigResult.signature,
            keyId,
            contentHash,
            algorithm: sigResult.algorithm,
            author: author.name,
            signedAt,
            claims: declaredMeta,
            innerContentHtml,
          });
          await composeExec(e2eDir, c, [
            "wp", "post", "update", postIdStr,
            `--post_content=${signedSection}`,
            "--post_status=publish",
            "--allow-root",
          ]);
          const publishedURL = (await composeExec(e2eDir, c, [
            "wp", "post", "url", postIdStr, "--allow-root",
          ])).trim();
          if (publishedURL !== sourceURL) {
            throw new Error(`WordPress changed the signed URL after publication: signed=${sourceURL} published=${publishedURL}`);
          }

          url = sourceURL;

          const malCheck = tracker.checkMalicious(declaredMeta, actualMeta);
          tracker.addArticle({
            id: `${author.id}-${slug}`, authorId: author.id, title, content, url,
            declaredMetadata: declaredMeta, actualMetadata: actualMeta,
            isMalicious: malCheck.isMalicious,
            maliciousReason: malCheck.reason,
            contentHash, signature: sigResult.signature,
          });
          console.log(`  ${title}${malCheck.isMalicious ? " [MALICIOUS]" : ""} -> ${url}`);
          continue;
        } else {
          const artPath = await hugoPub!.addArticle({ slug, title, content, claims: declaredMeta as unknown as Record<string, string> });
          url = `https://${author.domain}${artPath}`;
        }

        const { isMalicious, reason } = tracker.checkMalicious(declaredMeta, actualMeta);
        tracker.addArticle({ id: `${author.id}-${slug}`, authorId: author.id, title, content, url, declaredMetadata: declaredMeta, actualMetadata: actualMeta, isMalicious, maliciousReason: reason });
        console.log(`  ${title}${isMalicious ? " [MALICIOUS]" : ""}`);
      } catch (err) {
        errors.push(`Article gen failed for ${author.name}#${i}: ${err}`);
      }
    }

    // Build Hugo sites and sign content
    if (author.cmsType === "hugo" && hugoPub) {
      try {
        const outDir = path.join(e2eDir, "hugo-sites", author.domain.replace(".htmltrust.test", ""));
        await mkdir(outDir, { recursive: true });
        await hugoPub.build(outDir);

        // Post-build: for each rendered article, read the HTML, extract the
        // article text, compute our own canonical hash (NOT trusting the
        // Hugo-template-computed hash), compute claims hash, sign the new
        // binding, and rewrite the signed-section to include the signature
        // attributes AND embed the text content inside the signed-section.
        //
        // The current Hugo partial writes content-hash from its own template
        // hashing function. That produces a different result than our JS
        // canonicalization pipeline, so we overwrite it here.
        for (const article of tracker.getArticlesForAuthor(author.id)) {
          const slugMatch = article.id.match(/article-(\d+)$/);
          if (!slugMatch) continue;
          const htmlPath = path.join(outDir, "posts", `article-${slugMatch[1]}`, "index.html");
          let html: string;
          try {
            html = await readFile(htmlPath, "utf-8");
          } catch {
            errors.push(`Rendered HTML not found for ${article.id}: ${htmlPath}`);
            continue;
          }

          const signedAt = v1Timestamp();
          const signedClaims = buildSignedClaims(author.name, signedAt, article.declaredMetadata);
          const signedClaimRecords = claimRecords(signedClaims);
          const innerContentHtml = `<article><p>${escapeText(article.content)}</p></article>`;
          const contentHash = computeContentHashFromHtml(innerContentHtml, article.url);
          const expectedClaimsHash = computeClaimsHash(signedClaims);

          // Sign the canonical binding via the trust server
          const sig = await trustClient.signContent(author.authorApiKey, {
            contentHash,
            sourceURL: article.url,
            scope: "url",
            signedAt,
            claims: signedClaimRecords,
          });
          if (sig.claimsHash !== expectedClaimsHash) {
            throw new Error(`claims hash mismatch for ${article.url}: local=${expectedClaimsHash} directory=${sig.claimsHash}`);
          }

          const keyId = sig.keyid;

          // Build a new signed-section that wraps the article text inline.
          // We replace the Hugo-generated standalone signed-section with our
          // wrapped version.
          const newSignedSection = buildSignedSectionHtml({
            profile: sig.profile,
            scope: sig.scope,
            signature: sig.signature,
            keyId,
            contentHash,
            algorithm: sig.algorithm,
            author: author.name,
            signedAt,
            claims: article.declaredMetadata,
            innerContentHtml,
          });

          // Replace the entire old signed-section block (and the separate
          // article element Hugo emitted) with our new wrapped form.
          let newHtml = html.replace(
            /<article>[\s\S]*?<\/article>\s*<signed-section[\s\S]*?<\/signed-section>/,
            newSignedSection,
          );
          if (newHtml === html) {
            // Fallback: just replace the signed-section tag if the above
            // combined pattern didn't match (template variation).
            newHtml = html.replace(
              /<signed-section[\s\S]*?<\/signed-section>/,
              newSignedSection,
            );
          }
          await writeFile(htmlPath, newHtml);

          article.signature = sig.signature;
          article.contentHash = contentHash;
        }
      } catch (err) {
        errors.push(`Hugo build failed for ${author.name}: ${err}`);
      }
    }
  }

  await mkdir(path.join(e2eDir, "results"), { recursive: true });
  await tracker.save(path.join(e2eDir, "results/ground-truth.json"));
  console.log(`[Phase 2] ${tracker.getManifest().articles.length} articles published`);

  return { phase: "publish", success: errors.length === 0, duration: Date.now() - start, errors };
}
