import { describe, expect, it } from "vitest";
import { expectedTrustIndicator } from "../../src/phases/consumers.js";

describe("consumer trust indicator validation", () => {
  it("uses the policy score thresholds", () => {
    expect(expectedTrustIndicator({ trustScore: 19.9, directoryResults: [] })).toBe("warning");
    expect(expectedTrustIndicator({ trustScore: 20, directoryResults: [] })).toBe("verified-unknown");
    expect(expectedTrustIndicator({ trustScore: 69.9, directoryResults: [] })).toBe("verified-unknown");
    expect(expectedTrustIndicator({ trustScore: 70, directoryResults: [] })).toBe("trusted");
  });

  it("applies the report override at any score", () => {
    expect(expectedTrustIndicator({
      trustScore: 90,
      directoryResults: [{
        directoryId: "beta",
        url: "https://trust-b.htmltrust.test",
        weight: 0.75,
        status: "ok",
        score: 0.5,
        reports: 1,
        latencyMs: 1,
      }],
    })).toBe("warning");
  });
});
