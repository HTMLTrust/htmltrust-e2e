// === Scenario Config Types ===

export interface ScenarioConfig {
  seed: number;
  screenshot_sample_pct: number;
  authors: AuthorConfig;
  consumers: ConsumerConfig;
  researcher: ResearcherConfig;
  post_report_consumers: number;
  /**
   * Trust directory configuration (formerly `trust_server`). For now this
   * carries the single-directory shape used by every existing scenario YAML;
   * downstream code (playwright-session) accepts a list of directory URLs
   * via `trustDirectoryUrls` and treats this as one entry of that list.
   *
   * TODO(scenario-yaml): scenario.yaml / scenario-small.yaml still use the
   * old `trust_server:` key. Migrate them to a `trust_directories:` array
   * once the multi-directory simulation work lands. Until then we accept
   * both keys here.
   */
  trust_server: TrustDirectoryConfig;
  ollama: OllamaConfig;
  nginx_proxy_url?: string; // e.g. "http://localhost:8080" when running from host
}

export interface AuthorConfig {
  count: number;
  cms_split: { wordpress: number; hugo: number };
  articles_per_author: [number, number];
  ai_metadata_distribution: Record<AIAssistance, number>;
  malicious_profiles: MaliciousProfile[];
}

export interface MaliciousProfile {
  malicious_pct: number;
  weight: number;
}

export interface ConsumerConfig {
  count: number;
  trusted_authors: [number, number];
  visit_pct: [number, number];
  vote_probability: number;
  batch_size: number;
}

export interface ResearcherConfig {
  enabled: boolean;
  detection_method: "ground_truth";
  report_threshold: number;
}

/**
 * Configuration for a single trust directory (formerly "trust server").
 *
 * Renamed to align with the spec terminology — the prototype's "trust
 * server" is a special case of a generalized trust directory. See
 * src/lib/trust-api.ts for the API shape.
 */
export interface TrustDirectoryConfig {
  url: string;
  general_api_key: string;
  admin_api_key: string;
}

/** @deprecated Use TrustDirectoryConfig. Retained for legacy scenario YAML. */
export type TrustServerConfig = TrustDirectoryConfig;

export interface OllamaConfig {
  model: string;
  host: string;
}

// === Domain Types ===

export type AIAssistance = "None" | "Human+AI" | "AI-only";
export type CmsType = "wordpress" | "hugo";
export type VoteType = "TRUST" | "DISTRUST";
export type TrustIndicator = "trusted" | "verified-unknown" | "warning";

export interface AuthorProfile {
  id: string;
  name: string;
  authorApiKey: string;
  keyId: string;
  cmsType: CmsType;
  domain: string;
  malicious_pct: number;
  wpContainerName?: string;
  wpAppPassword?: string; // WordPress Application Password for REST API
}

export interface Article {
  id: string;
  authorId: string;
  title: string;
  content: string;
  url: string;
  declaredMetadata: ArticleMetadata;
  actualMetadata: ArticleMetadata;
  isMalicious: boolean;
  maliciousReason?: string;
  contentHash?: string;
  signature?: string;
}

export interface ArticleMetadata {
  ContentType: string;
  License: string;
  AIAssistance: AIAssistance;
}

export interface ConsumerProfile {
  id: string;
  trustedAuthors: string[];
  visitAuthors: string[];
  willVote: boolean;
  captureScreenshots: boolean;
}

export interface SessionLog {
  consumerId: string;
  trustedAuthors: string[];
  pagesVisited: PageVisit[];
  votesCast: VoteCast[];
  screenshots: string[];
}

export interface PageVisit {
  url: string;
  authorId: string;
  timestamp: number;
  signatureValid: boolean;
  contentHashValid: boolean;
  trustIndicator: TrustIndicator;
  verificationInputState: "source-only" | "stale" | "rendered-match";
  verificationReason?: string;
}

export interface VoteCast {
  authorId: string;
  vote: VoteType;
  timestamp: number;
}

// === API Response Types ===

export interface CreateAuthorResponse {
  author: {
    id: string;
    name: string;
    description: string;
    url: string;
    keyType: string;
    createdAt: string;
    updatedAt: string;
  };
  authorApiKey: string;
}

export interface SignContentResponse {
  contentHash: string;
  claimsHash: string;
  signedAt: string;
  domain: string;
  authorId: string;
  signature: string;
  algorithm: string;
  keyid: string;
  claims: Record<string, string>;
  createdAt: string;
}

export interface KeyReputationResponse {
  keyId: string;
  trustScore: number;
  verifiedSignatures: number;
  reports: number;
  lastUpdated: string;
}

// === Ground Truth ===

export interface GroundTruthManifest {
  generatedAt: string;
  seed: number;
  authors: AuthorProfile[];
  articles: Article[];
}

// === Phase Results ===

export interface PhaseResult {
  phase: string;
  success: boolean;
  duration: number;
  errors: string[];
}
