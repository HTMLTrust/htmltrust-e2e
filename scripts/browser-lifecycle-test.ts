import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { DOM_SCRIPT_BODY } from "../src/lib/playwright-session.js";

const expression = `(async () => { ${DOM_SCRIPT_BODY} })()`;
const fixtureAttributes = (signature: string): string =>
  `profile="htmltrust-signature-v1" signature-scope="url" keyid="https://example.test/keys/alice" algorithm="ed25519" content-hash="sha256:${signature}" signature="${signature}"`;

type ScoreInput = { html: string; renderedHtml: string };

async function setSnapshot(page: Page, html: string, sections: string[], url = "https://example.test/article"): Promise<void> {
  await page.evaluate(({ html: snapshotHtml, sections: snapshotSections, url: snapshotUrl }) => {
    (window as unknown as { __htmltrustSourceSnapshot: unknown }).__htmltrustSourceSnapshot = {
      html: snapshotHtml,
      url: snapshotUrl,
      sections: snapshotSections,
    };
  }, { html, sections, url });
}

async function navigate(page: Page, html: string): Promise<void> {
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function runWalker(page: Page, html: string, sections: string[]): Promise<unknown[]> {
  await setSnapshot(page, html, sections);
  return await page.evaluate(expression) as unknown[];
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const calls: ScoreInput[] = [];
  await page.exposeFunction("__htmltrustVerifyAndScore", async (input: ScoreInput) => {
    calls.push(input);
    const sourceAvailable = input.html.length > 0;
    const renderedMatch = sourceAvailable && input.html === input.renderedHtml;
    return {
      verify: {
        valid: sourceAvailable,
        inputState: renderedMatch ? "rendered-match" : sourceAvailable ? "stale" : "source-only",
        reason: sourceAvailable ? undefined : "source snapshot unavailable",
      },
      trust: { score: 50, indicator: "yellow", inputs: [] },
      authorId: "alice",
      reports: 0,
    };
  });

  try {
    // Missing source must reach the verifier as an empty string. A live DOM
    // serialization must never be used as a replacement input.
    const missing = `<signed-section ${fixtureAttributes("live")}>live</signed-section>`;
    await navigate(page, missing);
    calls.length = 0;
    const missingResult = await runWalker(page, "", []);
    assert.equal(calls[0]?.html, "");
    assert.equal((missingResult[0] as { signatureValid: boolean }).signatureValid, false);
    assert.equal(await page.locator(".cs-validity-badge").textContent(), "✗ Signature INVALID");

    // Every nested section gets a sibling marker after the outermost section.
    // This keeps extension-owned UI outside all signed bytes.
    const nested = `<signed-section ${fixtureAttributes("outer")}>outer <signed-section ${fixtureAttributes("inner")}>inner</signed-section></signed-section>`;
    const nestedSections = [
      nested,
      `<signed-section ${fixtureAttributes("inner")}>inner</signed-section>`,
    ];
    await navigate(page, nested);
    calls.length = 0;
    const nestedResult = await runWalker(page, nested, nestedSections);
    assert.equal(nestedResult.length, 2);
    assert.equal(await page.locator(".cs-verification-badges").count(), 2);
    assert.equal(await page.locator("signed-section > .cs-verification-badges").count(), 0);
    assert.equal(await page.locator("body > .cs-verification-badges").count(), 2);

    // A mutation after a successful verification changes the badge without
    // rerunning the source verifier.
    const mutable = `<signed-section ${fixtureAttributes("mutable")}>before</signed-section>`;
    await navigate(page, mutable);
    calls.length = 0;
    await runWalker(page, mutable, [mutable]);
    await page.locator("signed-section").evaluate((section) => { section.textContent = "after"; });
    await page.waitForTimeout(0);
    assert.equal(await page.locator(".cs-verification-badges").getAttribute("data-verification-state"), "stale");
    assert.equal(await page.locator(".cs-validity-badge").textContent(), "⚠ Rendered content INVALID (source differs)");
    assert.equal(calls.length, 1);

    // A fresh document and snapshot use only the new source. This catches a
    // previous page's frozen bytes accidentally surviving a reload.
    const first = `<signed-section ${fixtureAttributes("first")}>first</signed-section>`;
    const second = `<signed-section ${fixtureAttributes("second")}>second</signed-section>`;
    await navigate(page, first);
    await runWalker(page, first, [first]);
    await navigate(page, second);
    calls.length = 0;
    const reloadResult = await runWalker(page, second, [second]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.html, second);
    assert.equal((reloadResult[0] as { signatureValid: boolean }).signatureValid, true);
    assert.equal(await page.locator(".cs-verification-badges").count(), 1);
    assert.equal(await page.locator("signed-section").textContent(), "second");
  } finally {
    await page.close();
    await browser.close();
  }
}

await main();
console.log("browser lifecycle checks passed");
