import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Worker } from "playwright";
import type { GroundTruthManifest } from "../src/types.js";

const e2eDir = process.env.E2E_DIR || process.cwd();
const configuredExtensionPath = process.env.EXTENSION_PATH;
const extensionPath = configuredExtensionPath ? path.resolve(configuredExtensionPath) : undefined;
const runtimeDir = path.resolve(e2eDir, ".runtime");
const groundTruthPath = path.join(e2eDir, "results", "ground-truth.json");

interface PageVerification {
  cryptoValid?: unknown;
  sourceVerified?: unknown;
}

interface PageVerificationResponse {
  url?: unknown;
  results?: unknown;
}

interface ExtensionManifestIdentity {
  manifest_version: number;
  name: string;
  version: string;
}

function assertSafeProfilePath(profilePath: string, runtimeRoot: string): void {
  assert.equal(path.dirname(profilePath), runtimeRoot, "extension profile must be directly inside .runtime");
  assert.match(path.basename(profilePath), /^chromium-extension-[A-Za-z0-9]+$/, "unexpected extension profile name");
}

async function findExtensionWorker(context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>): Promise<Worker> {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) return existing;
  const worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  assert.equal(worker.url().startsWith("chrome-extension://"), true, `unexpected service worker: ${worker.url()}`);
  return worker;
}

async function queryPageVerifications(
  worker: Worker,
  expectedUrl: string,
): Promise<{ tabUrl: string; response: PageVerificationResponse }> {
  return await worker.evaluate(async (targetUrl) => {
    const chromeApi = (globalThis as unknown as {
      chrome: {
        tabs: {
          query(query: { active: boolean; currentWindow: boolean }, callback: (tabs: Array<{ id?: number; url?: string }>) => void): void;
          sendMessage(tabId: number, message: { type: string }, callback: (response: unknown) => void): void;
        };
        runtime: { lastError?: { message?: string } };
      };
    }).chrome;

    const tabs = await new Promise<Array<{ id?: number; url?: string }>>((resolve, reject) => {
      chromeApi.tabs.query({ active: true, currentWindow: true }, (result) => {
        const error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message || "chrome.tabs.query failed"));
        else resolve(result);
      });
    });
    const normalizedTarget = new URL(targetUrl).href;
    const tab = tabs.find((candidate) => {
      if (!candidate.url) return false;
      try {
        return new URL(candidate.url).href === normalizedTarget;
      } catch {
        return false;
      }
    });
    if (typeof tab?.id !== "number" || !tab.url) {
      throw new Error(`active article tab unavailable for extension query: ${normalizedTarget}`);
    }

    const response = await new Promise<PageVerificationResponse>((resolve, reject) => {
      chromeApi.tabs.sendMessage(tab.id as number, { type: "GET_PAGE_VERIFICATIONS" }, (value) => {
        const error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message || "chrome.tabs.sendMessage failed"));
        else resolve(value as PageVerificationResponse);
      });
    });
    return { tabUrl: tab.url, response };
  }, expectedUrl);
}

async function main(): Promise<void> {
  assert.ok(extensionPath, "EXTENSION_PATH is required for the Chromium extension smoke test");
  let groundTruthText: string;
  try {
    groundTruthText = await readFile(groundTruthPath, "utf8");
  } catch (error) {
    throw new Error(`ground truth is unavailable at ${groundTruthPath}; run the integration publisher first`, { cause: error });
  }
  const groundTruth = JSON.parse(groundTruthText) as GroundTruthManifest;
  const article = groundTruth.articles[0];
  assert.ok(article?.url, `ground truth has no published article: ${groundTruthPath}`);
  const builtManifest = JSON.parse(
    await readFile(path.join(extensionPath, "manifest.json"), "utf8"),
  ) as Partial<ExtensionManifestIdentity>;
  if (builtManifest.manifest_version !== 3) throw new Error("Chromium smoke requires an MV3 extension build");
  if (builtManifest.name !== "Content Signing") throw new Error("unexpected extension build name");
  if (typeof builtManifest.version !== "string") throw new Error("extension build has no version");
  const expectedManifest: ExtensionManifestIdentity = {
    manifest_version: builtManifest.manifest_version,
    name: builtManifest.name,
    version: builtManifest.version,
  };

  await mkdir(runtimeDir, { recursive: true });
  const runtimeStat = await lstat(runtimeDir);
  assert.equal(runtimeStat.isSymbolicLink(), false, ".runtime must not be a symbolic link");
  assert.equal(runtimeStat.isDirectory(), true, ".runtime must be a directory");
  const runtimeRoot = await realpath(runtimeDir);
  const profilePath = await mkdtemp(path.join(runtimeRoot, "chromium-extension-"));
  assertSafeProfilePath(profilePath, runtimeRoot);

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(article.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.bringToFront();
    await page.locator(".cs-auto-verification-badges").first().waitFor({ state: "attached", timeout: 30_000 });

    const worker = await findExtensionWorker(context);
    const extensionId = new URL(worker.url()).hostname;
    assert.match(extensionId, /^[a-p]{32}$/, `invalid MV3 extension id: ${extensionId}`);
    const loadedManifest = await worker.evaluate(() => {
      const runtime = (globalThis as unknown as {
        chrome: { runtime: { getManifest(): ExtensionManifestIdentity } };
      }).chrome.runtime;
      const manifest = runtime.getManifest();
      return {
        manifest_version: manifest.manifest_version,
        name: manifest.name,
        version: manifest.version,
      };
    });
    assert.deepEqual(loadedManifest, expectedManifest, "loaded extension does not match the built manifest");
    const navigatedUrl = new URL(page.url()).href;
    const { tabUrl, response } = await queryPageVerifications(worker, navigatedUrl);
    assert.equal(new URL(tabUrl).href, navigatedUrl, "extension query used a different active tab");
    assert.equal(response.url, navigatedUrl, "content script reported a different page URL");
    const resultsValue = response && typeof response === "object" ? response.results : undefined;
    assert.ok(Array.isArray(resultsValue), "GET_PAGE_VERIFICATIONS returned no results array");
    const results = resultsValue as unknown[];
    assert.ok(results.length > 0, "GET_PAGE_VERIFICATIONS returned no signed-section results");
    const sourceVerified = results.filter((result): result is PageVerification =>
      result !== null && typeof result === "object" &&
      (result as PageVerification).cryptoValid === true &&
      (result as PageVerification).sourceVerified === true,
    ).length;
    assert.ok(sourceVerified > 0, "no signed-section result was crypto-valid and source-verified");

    console.log(`Chromium extension smoke passed: extension ${extensionId}, article ${article.id}, source-verified ${sourceVerified}/${results.length}`);
  } finally {
    try {
      await context?.close();
    } finally {
      const profileStat = await lstat(profilePath);
      assert.equal(profileStat.isSymbolicLink(), false, "refusing to remove a symbolic-link profile");
      assert.equal(profileStat.isDirectory(), true, "extension profile path is no longer a directory");
      const realProfilePath = await realpath(profilePath);
      assertSafeProfilePath(realProfilePath, runtimeRoot);
      await rm(realProfilePath, { recursive: true, force: true });
    }
  }
}

await main();
