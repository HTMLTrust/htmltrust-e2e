import type { CreateAuthorResponse, SignContentResponse, KeyReputationResponse, VoteType } from "../types.js";

export class TrustApiClient {
  constructor(private baseUrl: string, private generalApiKey: string, private adminApiKey: string) {}

  private async request<T>(path: string, opts: { method: string; headers?: Record<string, string>; body?: unknown }): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method,
      headers: { "Content-Type": "application/json", ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${opts.method} ${path}: ${res.status} ${res.statusText} - ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async createAuthor(data: { name: string; keyType: string; description?: string; url?: string; keyAlgorithm?: string }): Promise<CreateAuthorResponse> {
    return this.request("/api/authors", { method: "POST", headers: { "X-API-KEY": this.generalApiKey }, body: data });
  }

  async getAuthorPublicKey(authorId: string): Promise<{ id: string; authorId: string; key: string; algorithm: string }> {
    return this.request(`/api/authors/${authorId}/public-key`, { method: "GET" });
  }

  async signContent(authorApiKey: string, data: { contentHash: string; domain: string; claims: Record<string, string> }): Promise<SignContentResponse> {
    return this.request("/api/content/sign", { method: "POST", headers: { "X-AUTHOR-API-KEY": authorApiKey }, body: data });
  }

  async verifyContent(data: { contentHash: string; domain: string; authorId: string; signature: string }): Promise<{ valid: boolean }> {
    return this.request("/api/content/verify", { method: "POST", body: data });
  }

  async createClaimType(data: { name: string; description: string; possibleValues?: string[] }): Promise<unknown> {
    return this.request("/api/claims", { method: "POST", headers: { "X-ADMIN-API-KEY": this.adminApiKey }, body: data });
  }

  async vote(data: { userId: string; targetType: "AUTHOR" | "CONTENT"; targetId: string; voteType: VoteType; reason?: string }): Promise<unknown> {
    return this.request("/api/votes", { method: "POST", headers: { "X-API-KEY": this.generalApiKey }, body: data });
  }

  async getKeyReputation(keyId: string): Promise<KeyReputationResponse> {
    return this.request(`/api/directory/keys/${keyId}/reputation`, { method: "GET" });
  }

  async reportKey(keyId: string, data: { reason: string; details: string; evidence: string }): Promise<{ reportId: string; status: string }> {
    return this.request(`/api/directory/keys/${keyId}/report`, { method: "POST", headers: { "X-API-KEY": this.generalApiKey }, body: data });
  }

  async reportContent(data: { contentHash: string; sourceUrl: string; targetUrl: string; reason: string; details?: string }): Promise<{ reportId: string; status: string }> {
    return this.request("/api/directory/content/report", { method: "POST", headers: { "X-API-KEY": this.generalApiKey }, body: data });
  }
}
