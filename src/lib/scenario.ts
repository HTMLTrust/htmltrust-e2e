import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { ScenarioConfig, AuthorProfile, ConsumerProfile, CmsType } from "../types.js";

export async function loadScenario(path: string): Promise<ScenarioConfig> {
  const raw = await readFile(path, "utf-8");
  return parse(raw) as ScenarioConfig;
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
      id: "",
      name: `Author ${i + 1}`,
      authorApiKey: "",
      keyId: "",
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
  const authorIds = authors.map((a) => a.id || a.name);

  for (let i = 0; i < config.consumers.count; i++) {
    const [minTrust, maxTrust] = config.consumers.trusted_authors;
    const trustCount = randInt(rng, minTrust, maxTrust);
    const trustedAuthors = shuffle(rng, authorIds).slice(0, trustCount);

    const [minVisit, maxVisit] = config.consumers.visit_pct;
    const visitPct = minVisit + rng() * (maxVisit - minVisit);
    const visitCount = Math.max(1, Math.round(visitPct * authors.length));
    const visitAuthors = shuffle(rng, authorIds).slice(0, visitCount);

    consumers.push({
      id: `consumer-${i + 1}`,
      trustedAuthors,
      visitAuthors,
      willVote: rng() < config.consumers.vote_probability,
      captureScreenshots: rng() < config.screenshot_sample_pct / 100,
    });
  }

  return consumers;
}
