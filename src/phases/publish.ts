import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
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
 * The current draft serializes every normalized claim as `name:content\n`,
 * sorted by normalized claim name, and hashes the concatenated byte string.
 */
export function computeClaimsHash(claims: Record<string, string>): string {
  const encoder = new TextEncoder();
  const compareUtf8 = (a: string, b: string): number => {
    const aa = encoder.encode(a);
    const bb = encoder.encode(b);
    const len = Math.min(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
      if (aa[i] !== bb[i]) return aa[i] - bb[i];
    }
    return aa.length - bb.length;
  };
  const canonical = Object.entries(claims)
    .map(([name, content]) => [normalizeText(name), normalizeText(String(content))] as const)
    .sort(([a], [b]) => compareUtf8(a, b))
    .map(([name, content]) => `${name}:${content}\n`)
    .join("");
  return hashCanonical(canonical);
}

export function serializedOriginForDomain(domain: string): string {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(domain) ? domain : `http://${domain}`;
  return new URL(candidate).origin;
}

export function buildSignedClaims(author: string, signedAt: string, claims: ArticleMetadata): Record<string, string> {
  return {
    author,
    "signed-at": signedAt,
    ...Object.fromEntries(Object.entries(claims).map(([key, value]) => [`claim:${key}`, value])),
  };
}

function buildSignedSectionHtml(opts: {
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
    `<meta name="author" content="${opts.author}">`,
    `<meta name="signed-at" content="${opts.signedAt}">`,
    ...Object.entries(opts.claims).map(([k, v]) => `<meta name="claim:${k}" content="${v}">`),
  ].join("\n  ");

  const inner = opts.innerContentHtml ? `\n  ${opts.innerContentHtml}\n` : "\n";

  return `<signed-section signature="${opts.signature}" keyid="${opts.keyId}" algorithm="${opts.algorithm}" content-hash="${opts.contentHash}">
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

        // Compute the canonical binding fields per spec. The legacy `domain`
        // API field carries the serialized Web origin, not a host-only name.
        const signedAt = new Date().toISOString();
        const publicationOrigin = serializedOriginForDomain(author.domain);
        const signedClaims = buildSignedClaims(author.name, signedAt, declaredMeta);
        const innerContentHtml = `<article><p>${content}</p></article>`;
        const contentHash = computeContentHashFromHtml(innerContentHtml, publicationOrigin);
        const claimsHash = computeClaimsHash(signedClaims);

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
          const sigResult = await trustClient.signContent(author.authorApiKey, {
            contentHash, claimsHash, signedAt,
            domain: publicationOrigin,
            claims: signedClaims,
          });

          // Build the signed-section wrapper with the content nested inside.
          // Using the wrapped form (spec §2.1 example): the <signed-section>
          // contains the content, so the browser can extract text from within
          // it unambiguously.
          const keyId = sigResult.keyid;
          const signedSection = buildSignedSectionHtml({
            signature: sigResult.signature,
            keyId,
            contentHash,
            algorithm: sigResult.algorithm,
            author: author.name,
            signedAt,
            claims: declaredMeta,
            innerContentHtml,
          });

          const postBody = signedSection;

          // Write the post body to a temp file inside the WP container via spawn (stdin)
          const c = author.wpContainerName!;
          const tmpFile = `/tmp/post-${Date.now()}-${i}.html`;
          await writeFileToContainer(e2eDir, c, tmpFile, postBody);

          const postIdStr = (await composeExec(e2eDir, c, [
            "wp", "post", "create", tmpFile,
            `--post_title=${title}`,
            "--post_status=publish",
            "--post_type=post",
            "--porcelain",
            "--allow-root",
          ])).trim();

          await composeExec(e2eDir, c, ["rm", tmpFile]);

          url = `http://${author.domain}/?p=${postIdStr}`;

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
          url = `http://${author.domain}${artPath}`;
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

          const signedAt = new Date().toISOString();
          const publicationOrigin = serializedOriginForDomain(author.domain);
          const signedClaims = buildSignedClaims(author.name, signedAt, article.declaredMetadata);
          const innerContentHtml = `<article><p>${article.content}</p></article>`;
          const contentHash = computeContentHashFromHtml(innerContentHtml, publicationOrigin);
          const claimsHash = computeClaimsHash(signedClaims);

          // Sign the canonical binding via the trust server
          const sig = await trustClient.signContent(author.authorApiKey, {
            contentHash, claimsHash, signedAt,
            domain: publicationOrigin,
            claims: signedClaims,
          });

          const keyId = sig.keyid;

          // Build a new signed-section that wraps the article text inline.
          // We replace the Hugo-generated standalone signed-section with our
          // wrapped version.
          const newSignedSection = buildSignedSectionHtml({
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
