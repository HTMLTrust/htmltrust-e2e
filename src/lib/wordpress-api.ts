import * as http from "node:http";

interface HttpResponse {
  status: number;
  body: string;
}

/**
 * Raw HTTP request that allows overriding the Host header (which Node's fetch() doesn't).
 */
function rawRequest(opts: {
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: opts.hostname, port: opts.port, path: opts.path, method: opts.method, headers: opts.headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export class WordPressClient {
  private authHeader: string;
  private proxyHost: string;
  private proxyPort: number;
  private siteHost: string;

  /**
   * @param siteUrl - The logical site URL (e.g. http://author1.htmltrust.test)
   * @param username - WP admin username
   * @param password - WP admin password
   * @param proxyUrl - Optional proxy URL to route requests through (e.g. http://localhost:18080).
   *                   When set, requests go to the proxy with a Host header matching the site domain.
   */
  constructor(siteUrl: string, username: string, password: string, proxyUrl?: string) {
    this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    const siteParsed = new URL(siteUrl);
    this.siteHost = siteParsed.host;

    const actual = proxyUrl ? new URL(proxyUrl) : siteParsed;
    this.proxyHost = actual.hostname;
    this.proxyPort = parseInt(actual.port, 10) || 80;
  }

  async createPost(data: { title: string; content: string; status: "publish" | "draft" }): Promise<{ id: number; link: string; status: string }> {
    const body = JSON.stringify(data);
    const res = await rawRequest({
      hostname: this.proxyHost,
      port: this.proxyPort,
      path: "/wp-json/wp/v2/posts",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
        "Authorization": this.authHeader,
        "Host": this.siteHost,
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WP API failed: ${res.status} - ${res.body}`);
    }
    return JSON.parse(res.body);
  }

  async fetchRenderedPage(url: string): Promise<string> {
    const parsed = new URL(url);
    const res = await rawRequest({
      hostname: this.proxyHost,
      port: this.proxyPort,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "Host": this.siteHost },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Fetch ${url} failed: ${res.status}`);
    }
    return res.body;
  }
}
