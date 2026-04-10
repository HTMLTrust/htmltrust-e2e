import path from "node:path";
import { mkdir } from "node:fs/promises";
import { generateArticle } from "../lib/ollama.js";
import { WordPressClient } from "../lib/wordpress-api.js";
import { HugoPublisher } from "../lib/hugo-publisher.js";
import { TrustApiClient } from "../lib/trust-api.js";
import { GroundTruthTracker } from "../lib/ground-truth.js";
import type { ScenarioConfig, AuthorProfile, AIAssistance, ArticleMetadata, PhaseResult } from "../types.js";

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

        if (author.cmsType === "wordpress") {
          const wp = new WordPressClient(`http://${author.domain}`, "admin", "admin");
          const post = await wp.createPost({ title, content: `<p>${content}</p>`, status: "publish" });
          url = post.link;
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

        for (const article of tracker.getArticlesForAuthor(author.id)) {
          const sig = await trustClient.signContent(author.authorApiKey, {
            contentHash: article.contentHash || `sha256:placeholder-${article.id}`,
            domain: author.domain, claims: article.declaredMetadata as unknown as Record<string, string>,
          });
          article.signature = sig.signature;
          article.contentHash = sig.contentHash;
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
