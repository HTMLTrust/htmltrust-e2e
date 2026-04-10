export class WordPressClient {
  private authHeader: string;
  constructor(private baseUrl: string, username: string, password: string) {
    this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  async createPost(data: { title: string; content: string; status: "publish" | "draft" }): Promise<{ id: number; link: string; status: string }> {
    const res = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authHeader },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`WP API failed: ${res.status} - ${await res.text()}`);
    return res.json() as Promise<{ id: number; link: string; status: string }>;
  }

  async fetchRenderedPage(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
    return res.text();
  }
}
