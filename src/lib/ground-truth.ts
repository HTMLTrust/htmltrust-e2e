import { writeFile, readFile } from "node:fs/promises";
import type { Article, ArticleMetadata, GroundTruthManifest, AuthorProfile } from "../types.js";

function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class GroundTruthTracker {
  private articles: Article[] = [];
  private authors: AuthorProfile[] = [];
  private rng: () => number;

  constructor(seed: number) {
    this.rng = createRng(seed + 2000);
  }

  setAuthors(authors: AuthorProfile[]): void { this.authors = authors; }

  shouldBeMalicious(maliciousPct: number): boolean {
    if (maliciousPct === 0) return false;
    if (maliciousPct === 1) return true;
    return this.rng() < maliciousPct;
  }

  checkMalicious(declared: ArticleMetadata, actual: ArticleMetadata): { isMalicious: boolean; reason?: string } {
    const mismatches: string[] = [];
    for (const key of Object.keys(declared) as (keyof ArticleMetadata)[]) {
      if (declared[key] !== actual[key]) mismatches.push(`${key}: declared ${declared[key]}, actually ${actual[key]}`);
    }
    return mismatches.length === 0 ? { isMalicious: false } : { isMalicious: true, reason: mismatches.join("; ") };
  }

  addArticle(article: Article): void { this.articles.push(article); }

  getManifest(): GroundTruthManifest {
    return { generatedAt: new Date().toISOString(), seed: 0, authors: this.authors, articles: this.articles };
  }

  getMaliciousArticles(): Article[] { return this.articles.filter((a) => a.isMalicious); }
  getArticlesForAuthor(authorId: string): Article[] { return this.articles.filter((a) => a.authorId === authorId); }

  async save(path: string): Promise<void> { await writeFile(path, JSON.stringify(this.getManifest(), null, 2)); }
  static async load(path: string): Promise<GroundTruthManifest> { return JSON.parse(await readFile(path, "utf-8")); }
}
