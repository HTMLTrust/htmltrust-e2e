import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { normalizeText } from "@htmltrust/canonicalization";
import { generateArticle } from "../lib/ollama.js";
import { HugoPublisher } from "../lib/hugo-publisher.js";
import { TrustApiClient } from "../lib/trust-api.js";
import { GroundTruthTracker } from "../lib/ground-truth.js";
import { composeExec, writeFileToContainer } from "../lib/docker.js";
import type { ScenarioConfig, AuthorProfile, AIAssistance, ArticleMetadata, PhaseResult } from "../types.js";

function computeContentHash(text: string): string {
  const canonical = normalizeText(text).trim().replace(/\s+/g, " ");
  const hash = createHash("sha256").update(canonical, "utf-8").digest("hex");
  return `sha256:${hash}`;
}

function buildSignedSectionHtml(opts: {
  signature: string;
  keyId: string;
  contentHash: string;
  author: string;
  signedAt: string;
  claims: ArticleMetadata;
}): string {
  const metas = [
    `<meta name="author" content="${opts.author}">`,
    `<meta name="signed-at" content="${opts.signedAt}">`,
    ...Object.entries(opts.claims).map(([k, v]) => `<meta name="claim:${k}" content="${v}">`),
  ].join("\n  ");
  return `<signed-section signature="${opts.signature}" keyid="${opts.keyId}" algorithm="ed25519" content-hash="${opts.contentHash}" style="display: block;">
  ${metas}
</signed-section>`;
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

        // Compute content hash for signing
        const contentHash = computeContentHash(content);

        if (author.cmsType === "wordpress") {
          // Sign content FIRST so we can embed the signed-section in the post body
          const sigResult = await trustClient.signContent(author.authorApiKey, {
            contentHash, domain: author.domain,
            claims: declaredMeta as unknown as Record<string, string>,
          });

          // Build the signed-section HTML to inject alongside the article content
          const signedSection = buildSignedSectionHtml({
            signature: sigResult.signature,
            keyId: `http://localhost:3000/api/authors/${author.id}/public-key`,
            contentHash,
            author: author.name,
            signedAt: new Date().toISOString(),
            claims: declaredMeta,
          });

          const postBody = `<p>${content}</p>\n${signedSection}`;

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

        // Post-build: for each rendered article, read the HTML, extract the Hugo-computed
        // content-hash, sign it via the trust server, and inject the signature attributes.
        // This ensures the signature matches the hash that's actually in the rendered page.
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

          // Extract the content-hash that Hugo wrote into the signed-section
          const hashMatch = html.match(/<signed-section[^>]*content-hash=["']?(sha256:[a-f0-9]{64})["']?/);
          if (!hashMatch) {
            errors.push(`No content-hash found in ${htmlPath}`);
            continue;
          }
          const renderedHash = hashMatch[1];

          // Sign that exact hash
          const sig = await trustClient.signContent(author.authorApiKey, {
            contentHash: renderedHash,
            domain: author.domain,
            claims: article.declaredMetadata as unknown as Record<string, string>,
          });

          // Rewrite the signed-section to include signature/keyid/algorithm
          const newTag = `<signed-section signature="${sig.signature}" keyid="http://trust-server:3000/api/authors/${author.id}/public-key" algorithm="ed25519" content-hash="${renderedHash}" style="display: block;">`;
          const newHtml = html.replace(/<signed-section[^>]*>/, newTag);
          await writeFile(htmlPath, newHtml);

          article.signature = sig.signature;
          article.contentHash = renderedHash;
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
