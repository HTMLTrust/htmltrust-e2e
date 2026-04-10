import { describe, it, expect, beforeEach } from "vitest";
import { GroundTruthTracker } from "../../src/lib/ground-truth.js";
import type { ArticleMetadata } from "../../src/types.js";

describe("GroundTruthTracker", () => {
  let tracker: GroundTruthTracker;
  beforeEach(() => { tracker = new GroundTruthTracker(42); });

  it("records articles and retrieves manifest", () => {
    tracker.addArticle({
      id: "a1", authorId: "auth1", title: "Test", content: "Hello",
      url: "http://author1.htmltrust.test/test",
      declaredMetadata: { ContentType: "Article", License: "MIT", AIAssistance: "None" },
      actualMetadata: { ContentType: "Article", License: "MIT", AIAssistance: "AI-only" },
      isMalicious: true, maliciousReason: "AIAssistance mismatch",
    });
    expect(tracker.getManifest().articles).toHaveLength(1);
    expect(tracker.getManifest().articles[0].isMalicious).toBe(true);
  });

  it("detects metadata mismatch as malicious", () => {
    const declared: ArticleMetadata = { ContentType: "Article", License: "MIT", AIAssistance: "None" };
    const actual: ArticleMetadata = { ContentType: "Article", License: "MIT", AIAssistance: "AI-only" };
    const result = tracker.checkMalicious(declared, actual);
    expect(result.isMalicious).toBe(true);
    expect(result.reason).toContain("AIAssistance");
  });

  it("marks matching metadata as not malicious", () => {
    const meta: ArticleMetadata = { ContentType: "Article", License: "MIT", AIAssistance: "None" };
    expect(tracker.checkMalicious(meta, meta).isMalicious).toBe(false);
  });

  it("returns all false for malicious_pct=0", () => {
    for (let i = 0; i < 20; i++) expect(tracker.shouldBeMalicious(0)).toBe(false);
  });

  it("returns all true for malicious_pct=1", () => {
    for (let i = 0; i < 20; i++) expect(tracker.shouldBeMalicious(1)).toBe(true);
  });

  it("returns a mix for malicious_pct=0.5", () => {
    const decisions = Array.from({ length: 20 }, () => tracker.shouldBeMalicious(0.5));
    expect(decisions.some((d) => d)).toBe(true);
    expect(decisions.some((d) => !d)).toBe(true);
  });
});
