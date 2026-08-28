import { describe, expect, it } from "vitest";
import {
  DOM_SCRIPT_BODY,
  captureSourceSnapshot,
  displayVerificationState,
  mapSourceSnapshot,
  outermostSectionIndex,
} from "../../src/lib/playwright-session.js";

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

  it("places nested markers after the outermost signed section", () => {
    // Parent indexes model the DOM tree: section 2 is nested in section 1,
    // which is nested in section 0.
    expect(outermostSectionIndex([-1, 0, 1], 2)).toBe(0);
    expect(outermostSectionIndex([-1, 0, 1], 1)).toBe(0);
    expect(outermostSectionIndex([-1, 0, 1], 0)).toBe(0);
  });

  it("renders stale and source-only states as warnings, never as valid", () => {
    expect(displayVerificationState(true, "rendered-match")).toEqual({
      valid: true,
      className: "verified",
      text: "✓ Signature valid",
    });
    expect(displayVerificationState(true, "stale")).toEqual({
      valid: false,
      className: "warning",
      text: "⚠ Rendered content INVALID (source differs)",
    });
    expect(displayVerificationState(true, "source-only").valid).toBe(false);
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

  it("keeps the production walker fail-closed and lifecycle-aware", () => {
    expect(DOM_SCRIPT_BODY).not.toContain("sourceHtml || renderedHtml");
    expect(DOM_SCRIPT_BODY).toContain("const html = sourceHtml;");
    expect(DOM_SCRIPT_BODY).toContain("sourceMappingComplete");
    expect(DOM_SCRIPT_BODY).toContain("new MutationObserver");
    expect(DOM_SCRIPT_BODY).toContain("Rendered content INVALID (source differs)");
    expect(DOM_SCRIPT_BODY).toContain("while (anchor.parentElement && anchor.parentElement.matches(\"signed-section\"))");
  });
});
