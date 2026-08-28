import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type {
  ScenarioConfig,
  AuthorProfile,
  ConsumerProfile,
  CmsType,
  TrustDirectoryConfig,
} from "../types.js";

function directoryEnvPrefix(id: string): string {
  return `HTMLTRUST_DIRECTORY_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

function parseUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`scenario-invalid: ${field} must be an absolute URL`);
  }
}

function validateDirectoryUrl(value: string, field: string, requireHttps: boolean): URL {
  const url = parseUrl(value, field);
  const allowedProtocol = requireHttps ? url.protocol === "https:" : url.protocol === "http:" || url.protocol === "https:";
  if (!allowedProtocol) {
    throw new Error(`scenario-invalid: ${field} must use ${requireHttps ? "HTTPS" : "HTTP or HTTPS"}`);
  }
  if (url.username || url.password) {
    throw new Error(`scenario-invalid: ${field} must not contain credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`scenario-invalid: ${field} must be an origin without a path, query, or fragment`);
  }
  return url;
}

export function validateScenario(config: ScenarioConfig): ScenarioConfig {
  if (!Array.isArray(config.trust_directories) || config.trust_directories.length === 0) {
    throw new Error("scenario-invalid: trust_directories must contain at least one directory");
  }

  const ids = new Set<string>();
  const publicOrigins = new Set<string>();
  const hostOrigins = new Set<string>();
  const containerOrigins = new Set<string>();
  let publishers = 0;
  for (const directory of config.trust_directories) {
    if (!directory.id || !/^[a-z0-9][a-z0-9-]*$/.test(directory.id)) {
      throw new Error("scenario-invalid: every directory id must use lowercase letters, digits, and hyphens");
    }
    if (ids.has(directory.id)) {
      throw new Error(`scenario-invalid: duplicate directory id ${directory.id}`);
    }
    ids.add(directory.id);
    const hostUrl = validateDirectoryUrl(directory.url, `trust_directories.${directory.id}.url`, false);
    if (hostOrigins.has(hostUrl.origin)) {
      throw new Error(`scenario-invalid: duplicate directory host origin ${hostUrl.origin}`);
    }
    hostOrigins.add(hostUrl.origin);
    const containerUrl = validateDirectoryUrl(directory.container_url, `trust_directories.${directory.id}.container_url`, false);
    if (containerOrigins.has(containerUrl.origin)) {
      throw new Error(`scenario-invalid: duplicate directory container origin ${containerUrl.origin}`);
    }
    containerOrigins.add(containerUrl.origin);
    const publicUrl = validateDirectoryUrl(
      directory.public_url,
      `trust_directories.${directory.id}.public_url`,
      true,
    );
    if (publicOrigins.has(publicUrl.origin)) {
      throw new Error(`scenario-invalid: duplicate public directory origin ${publicUrl.origin}`);
    }
    publicOrigins.add(publicUrl.origin);
    if (!Number.isFinite(directory.weight) || directory.weight <= 0 || directory.weight > 1) {
      throw new Error(`scenario-invalid: trust_directories.${directory.id}.weight must be greater than 0 and at most 1`);
    }
    if (!directory.general_api_key || !directory.admin_api_key) {
      throw new Error(`scenario-invalid: trust_directories.${directory.id} requires API keys`);
    }
    if (!new Set(["support", "challenge", "neutral"]).has(directory.initial_opinion)) {
      throw new Error(`scenario-invalid: trust_directories.${directory.id}.initial_opinion is invalid`);
    }
    if (typeof directory.publisher !== "boolean" || typeof directory.reports !== "boolean") {
      throw new Error(`scenario-invalid: trust_directories.${directory.id} requires boolean publisher and reports fields`);
    }
    if (directory.publisher) publishers += 1;
  }
  if (publishers !== 1) {
    throw new Error("scenario-invalid: exactly one trust directory must have publisher: true");
  }
  return config;
}

export function publisherDirectory(config: ScenarioConfig): TrustDirectoryConfig {
  const directory = config.trust_directories.find((candidate) => candidate.publisher);
  if (!directory) throw new Error("scenario-invalid: publishing directory is missing");
  return directory;
}

export async function loadScenario(path: string): Promise<ScenarioConfig> {
  const raw = await readFile(path, "utf-8");
  const config = parse(raw) as ScenarioConfig;

  if ((config as ScenarioConfig & { trust_server?: unknown }).trust_server) {
    throw new Error("scenario-invalid: trust_server was replaced by trust_directories");
  }
  if (Array.isArray(config.trust_directories)) {
    config.trust_directories = config.trust_directories.map((directory) => {
      const prefix = directoryEnvPrefix(directory.id);
      return {
        ...directory,
        url: process.env[`${prefix}_URL`] || directory.url,
        container_url: process.env[`${prefix}_CONTAINER_URL`] || directory.container_url,
        public_url: process.env[`${prefix}_PUBLIC_URL`] || directory.public_url,
        general_api_key: process.env[`${prefix}_GENERAL_API_KEY`] || directory.general_api_key,
        admin_api_key: process.env[`${prefix}_ADMIN_API_KEY`] || directory.admin_api_key,
      };
    });
  }
  config.nginx_proxy_url = process.env.HTMLTRUST_NGINX_PROXY_URL || config.nginx_proxy_url;

  return validateScenario(config);
}

function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedChoice<T>(rng: () => number, items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function generateAuthorProfiles(config: ScenarioConfig): AuthorProfile[] {
  const rng = createRng(config.seed);
  const authors: AuthorProfile[] = [];
  const { wordpress, hugo: _hugo } = config.authors.cms_split;

  // Guarantee at least one author per malicious profile bucket, then fill
  // the remainder with weighted-random draws. Shuffle the combined list so
  // guaranteed slots are not always at the front.
  const guaranteed = config.authors.malicious_profiles.map((p) => p.malicious_pct);
  const remaining = config.authors.count - guaranteed.length;
  const randomPcts: number[] = [];
  for (let i = 0; i < remaining; i++) {
    randomPcts.push(
      weightedChoice(
        rng,
        config.authors.malicious_profiles.map((p) => p.malicious_pct),
        config.authors.malicious_profiles.map((p) => p.weight)
      )
    );
  }
  const maliciousPcts = shuffle(rng, [...guaranteed, ...randomPcts]);

  for (let i = 0; i < config.authors.count; i++) {
    const cmsType: CmsType = i < wordpress ? "wordpress" : "hugo";

    authors.push({
      id: `author-${i + 1}`,
      name: `Author ${i + 1}`,
      keyId: "",
      directoryIdentities: {},
      cmsType,
      domain: `author${i + 1}.htmltrust.test`,
      malicious_pct: maliciousPcts[i],
      wpContainerName: cmsType === "wordpress" ? `wp-${i + 1}` : undefined,
    });
  }

  return authors;
}

export function generateConsumerProfiles(
  config: ScenarioConfig,
  authors: AuthorProfile[]
): ConsumerProfile[] {
  const rng = createRng(config.seed + 1000);
  const consumers: ConsumerProfile[] = [];
  const authorIds = authors.map((a) => a.id);
  const keyIds = authors.map((a) => a.keyId || a.id);

  for (let i = 0; i < config.consumers.count; i++) {
    const [minTrust, maxTrust] = config.consumers.personal_trust_keys;
    const trustCount = randInt(rng, minTrust, maxTrust);
    const personalTrustList = shuffle(rng, keyIds).slice(0, trustCount);

    const [minVisit, maxVisit] = config.consumers.visit_pct;
    const visitPct = minVisit + rng() * (maxVisit - minVisit);
    const visitCount = Math.max(1, Math.round(visitPct * authors.length));
    const visitAuthors = shuffle(rng, authorIds).slice(0, visitCount);

    consumers.push({
      id: `consumer-${i + 1}`,
      personalTrustList,
      directorySubscriptions: config.trust_directories.map((directory) => ({
        id: directory.id,
        url: directory.public_url,
        weight: directory.weight,
      })),
      visitAuthors,
      willVote: rng() < config.consumers.vote_probability,
      captureScreenshots: rng() < config.screenshot_sample_pct / 100,
    });
  }

  return consumers;
}
