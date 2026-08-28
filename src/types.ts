// === Scenario Config Types ===

export interface ScenarioConfig {
  seed: number;
  screenshot_sample_pct: number;
  authors: AuthorConfig;
  consumers: ConsumerConfig;
  researcher: ResearcherConfig;
  post_report_consumers: number;
  trust_directories: TrustDirectoryConfig[];
  ollama: OllamaConfig;
  nginx_proxy_url?: string; // e.g. "https://localhost:18443" when running from host
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
  personal_trust_keys: [number, number];
  visit_pct: [number, number];
  vote_probability: number;
  batch_size: number;
}

export interface ResearcherConfig {
  enabled: boolean;
  detection_method: "ground_truth";
  report_threshold: number;
}

export interface TrustDirectoryConfig {
  /** Stable scenario identifier used in evidence and environment overrides. */
  id: string;
  /** API URL used by the host-side orchestrator. */
  url: string;
  /** API URL used from containers on the Compose network. */
  container_url: string;
  /** HTTPS origin exposed to browser policy and embedded key identifiers. */
  public_url: string;
  /** Contribution multiplier applied by consumer trust policy. */
  weight: number;
  /** Exactly one directory owns the publishing identity in a scenario. */
  publisher: boolean;
  /** Whether researcher reports are submitted to this directory. */
  reports: boolean;
  /** Deterministic initial opinion used by the federation conflict scenario. */
  initial_opinion: "support" | "challenge" | "neutral";
  general_api_key: string;
  admin_api_key: string;
}

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
  /** Full key identifier used by signed content and personal trust policy. */
  keyId: string;
  directoryIdentities: Record<string, AuthorDirectoryIdentity>;
  cmsType: CmsType;
  domain: string;
  malicious_pct: number;
  wpContainerName?: string;
}

export interface AuthorDirectoryIdentity {
  signerId: string;
  authorId?: string;
  keyRecordId?: string;
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
  personalTrustList: string[];
  directorySubscriptions: Array<{
    id: string;
    url: string;
    weight: number;
  }>;
  visitAuthors: string[];
  willVote: boolean;
  captureScreenshots: boolean;
}

export interface SessionLog {
  consumerId: string;
  personalTrustList: string[];
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
  trustScore: number;
  trustIndicator: TrustIndicator;
  verificationInputState: "source-only" | "stale" | "rendered-match";
  verificationReason?: string;
  directoryResults: DirectoryQueryResult[];
}

export interface DirectoryQueryResult {
  directoryId: string;
  url: string;
  weight: number;
  status: "ok" | "unavailable" | "malformed";
  score?: number;
  reports?: number;
  contribution?: number;
  latencyMs: number;
}

export interface VoteCast {
  authorId: string;
  directoryId: string;
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
  profile: "htmltrust-signature-v1";
  context: "https://htmltrust.org/protocol/signed-section";
  canonicalizationProfile: "htmltrust-c14n-v1";
  attributeProfile: "htmltrust-attrs-v1";
  urlProfile: "htmltrust-safe-url-v1";
  contentHash: string;
  claimsHash: string;
  signedAt: string;
  scope: "url" | "origin";
  location: string;
  sourceURL: string;
  domain: string;
  authorId: string;
  signature: string;
  algorithm: string;
  keyid: string;
  claims: Array<{ name: string; content: string }>;
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
