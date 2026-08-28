import { describe, expect, it } from "vitest";
import { captureSourceSnapshot, mapSourceSnapshot } from "../../src/lib/playwright-session.js";

describe("browser lifecycle evidence", () => {
  it("fails closed when response source capture or identity mapping is incomplete", () => {
    expect(mapSourceSnapshot("", ["<signed-section />"], ["id"], ["id"])).toEqual({
      complete: false,
      sourceByLiveIndex: [null],
    });
    expect(mapSourceSnapshot("<signed-section />", ["<signed-section />"], ["source"], ["live"])).toEqual({
      complete: false,
      sourceByLiveIndex: [null],
    });
    expect(mapSourceSnapshot(
      "<signed-section />",
      ["source-one", "source-two"],
      ["duplicate", "duplicate"],
      ["duplicate", "duplicate"],
    )).toEqual({ complete: true, sourceByLiveIndex: ["source-one", "source-two"] });
  });

  it("resets the frozen source snapshot on reload and fails closed on a read error", async () => {
    const first = await captureSourceSnapshot(
      { text: async () => '<signed-section profile="one"></signed-section>', url: () => "https://example.test/one" },
      "https://example.test/requested-one",
    );
    const second = await captureSourceSnapshot(
      { text: async () => '<signed-section profile="two"></signed-section>', url: () => "https://example.test/two" },
      "https://example.test/requested-two",
    );
    const failed = await captureSourceSnapshot(
      { text: async () => { throw new Error("body unavailable"); }, url: () => "https://example.test/failed" },
      "https://example.test/requested-failed",
    );

    expect(first.html).toContain('profile="one"');
    expect(second.html).toContain('profile="two"');
    expect(second.html).not.toContain('profile="one"');
    expect(failed).toEqual({ html: "", url: "https://example.test/requested-failed", sections: [] });
  });
});
