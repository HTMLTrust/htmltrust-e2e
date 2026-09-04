import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { extractSignedSections, verifySignedSection, type KeyResolver } from "@htmltrust/browser-client";
import type { WordPressLocalSigningFixture } from "../src/wordpress-local-signing-fixture.js";

const e2eDir = process.env.E2E_DIR || process.cwd();
const fixturePath = path.join(e2eDir, "results", "wordpress-local-signing.json");

function sectionAttribute(source: string, name: string): string {
  const openTag = source.match(/^<signed-section\b[^>]*>/i)?.[0];
  if (!openTag) throw new Error("wordpress-local-signing: signed-section opening tag is missing");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = openTag.match(new RegExp(`\\b${escaped}\\s*=\\s*([\"'])(.*?)\\1`, "i"));
  if (!match) throw new Error(`wordpress-local-signing: signed-section is missing ${name}`);
  return match[2];
}

function assertCanonicalUnpaddedBase64(value: string, label: string): void {
  assert.notEqual(value, "", `${label} must be nonempty`);
  assert.match(value, /^[A-Za-z0-9+/]+$/, `${label} must use unpadded standard Base64`);
  assert.equal(Buffer.from(value, "base64").toString("base64").replace(/=+$/g, ""), value, `${label} must be canonical Base64`);
}

async function main(): Promise<void> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as WordPressLocalSigningFixture;
  assert.equal(fixture.publicUrl.startsWith("https://"), true);
  assert.equal(fixture.editUrl.startsWith("https://"), true);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let confirmationSeen = false;
  const dialogMessages: string[] = [];
  const browserErrors: string[] = [];
  page.on("dialog", (dialog) => {
    dialogMessages.push(`${dialog.type()}: ${dialog.message()}`);
    if (dialog.type() === "confirm") confirmationSeen = true;
    void dialog.accept();
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(fixture.editUrl, { waitUntil: "domcontentloaded" });
    if (page.url().includes("wp-login.php")) {
      await page.locator("#user_login").fill("admin");
      await page.locator("#user_pass").fill("admin");
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.locator("#wp-submit").click(),
      ]);
    }
    assert.match(page.url(), /\/wp-admin\/post\.php\?/);

    const editorModal = page.locator(".components-modal__screen-overlay");
    if (await editorModal.isVisible()) {
      await page.keyboard.press("Escape");
      await editorModal.waitFor({ state: "hidden", timeout: 5_000 });
    }

    const signButton = page.locator(".content-signing-meta-box .sign-post");
    await signButton.waitFor({ state: "visible", timeout: 30_000 });
    try {
      await page.waitForFunction(() => {
        const button = document.querySelector(".content-signing-meta-box .sign-post");
        const jquery = (window as typeof window & {
          jQuery?: { _data?: (element: Element, key: string) => { click?: unknown[] } };
        }).jQuery;
        const events = button && jquery?._data ? jquery._data(button, "events") : undefined;
        return Boolean(events?.click?.length);
      }, undefined, { timeout: 10_000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        readyState: document.readyState,
        localizedConfig: typeof (window as typeof window & { content_signing_post_meta_box?: unknown }).content_signing_post_meta_box,
        jquery: typeof (window as typeof window & { jQuery?: unknown }).jQuery,
        scripts: Array.from(document.scripts, (script) => script.src).filter((source) => source.includes("content-signing")),
      }));
      throw new Error(
        `WordPress signing controls did not initialize: ${JSON.stringify(diagnostics)}. Browser errors: ${browserErrors.join(" | ") || "none"}`,
        { cause: error },
      );
    }
    await signButton.click();
    assert.equal(confirmationSeen, true, "Sign Now must require confirmation");
    try {
      await page.locator(".content-signing-meta-box .signature-status-signed").waitFor({ timeout: 30_000 });
    } catch (error) {
      throw new Error(
        `WordPress did not display a signed status. Dialogs: ${dialogMessages.join(" | ") || "none"}. Browser errors: ${browserErrors.join(" | ") || "none"}`,
        { cause: error },
      );
    }

    const response = await context.request.get(fixture.publicUrl);
    assert.equal(response.status(), 200, "fixture page must be published");
    const finalUrl = response.url();
    assert.equal(finalUrl, fixture.publicUrl, "fixture page must not redirect to a different URL");
    const html = await response.text();
    const sections = extractSignedSections(html);
    assert.equal(sections.length, 1, "fixture page must have one signed section");
    const section = sections[0];

    assert.equal(sectionAttribute(section, "profile"), "htmltrust-signature-v1");
    assert.equal(sectionAttribute(section, "signature-scope"), "url");
    const keyid = sectionAttribute(section, "keyid");
    assert.equal(new URL(keyid).protocol, "https:");
    assert.equal(sectionAttribute(section, "algorithm"), "ed25519");
    const signature = sectionAttribute(section, "signature");
    assertCanonicalUnpaddedBase64(signature, "signature");
    const contentHash = sectionAttribute(section, "content-hash");
    assert.match(contentHash, /^sha256:[A-Za-z0-9+/]+$/);
    assertCanonicalUnpaddedBase64(contentHash.slice("sha256:".length), "content hash");

    const keyResponse = await context.request.get(keyid);
    assert.equal(keyResponse.status(), 200, "the keyid document must be public");
    const keyDocument = await keyResponse.json() as {
      id?: unknown;
      keyid?: unknown;
      algorithm?: unknown;
      publicKey?: unknown;
      publicKeyEncoding?: unknown;
    };
    assert.equal(keyDocument.algorithm, "ed25519");
    assert.equal(keyDocument.publicKeyEncoding, "spki-der");
    assert.equal(keyDocument.keyid, keyid);
    assert.equal(typeof keyDocument.publicKey, "string");
    assertCanonicalUnpaddedBase64(keyDocument.publicKey as string, "SPKI public key");
    const publicKeyPem = createPublicKey({
      key: Buffer.from(keyDocument.publicKey as string, "base64"),
      format: "der",
      type: "spki",
    }).export({ type: "spki", format: "pem" }).toString();

    const resolver: KeyResolver = {
      async resolve(candidate) {
        return candidate === keyid ? { keyid, publicKeyPem, algorithm: "ed25519" } : null;
      },
    };
    const verification = await verifySignedSection(section, {
      keyResolvers: [resolver],
      documentUrl: finalUrl,
      baseUrl: finalUrl,
    });
    assert.equal(verification.valid, true, `plugin signature must verify: ${verification.reason || "unknown failure"}`);
    console.log(`WordPress browser-local signing passed: post ${fixture.postId}, key ${keyid}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
