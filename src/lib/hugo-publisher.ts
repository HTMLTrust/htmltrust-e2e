import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class HugoPublisher {
  constructor(private siteDir: string, private authorName: string, private domain: string) {}

  async scaffold(): Promise<void> {
    await mkdir(path.join(this.siteDir, "content/posts"), { recursive: true });
    await mkdir(path.join(this.siteDir, "layouts/partials"), { recursive: true });
    await mkdir(path.join(this.siteDir, "layouts/_default"), { recursive: true });

    await writeFile(path.join(this.siteDir, "hugo.toml"),
      `baseURL = "http://${this.domain}/"\ntitle = "${this.authorName} Blog"\ntheme = []\n\n[params]\n  author = "${this.authorName}"\n`);

    await writeFile(path.join(this.siteDir, "layouts/_default/single.html"),
      `<!DOCTYPE html>\n<html><head><title>{{ .Title }}</title></head>\n<body>\n<article><h1>{{ .Title }}</h1>\n{{ .Content }}\n</article>\n{{ partial "htmltrust-signed-section.html" . }}\n</body></html>`);

    await writeFile(path.join(this.siteDir, "layouts/_default/list.html"),
      `<!DOCTYPE html>\n<html><head><title>{{ .Title }}</title></head>\n<body><h1>{{ .Title }}</h1>\n{{ range .Pages }}<a href="{{ .Permalink }}">{{ .Title }}</a>\n{{ end }}</body></html>`);

    await writeFile(path.join(this.siteDir, "layouts/partials/htmltrust-signed-section.html"),
      `{{ if .Params.htmltrust }}{{ if .Params.htmltrust.sign }}\n{{ $plain := .Plain }}\n{{ $canon := $plain | replaceRE "\\\\s+" " " | strings.TrimSpace }}\n{{ $hash := sha256 $canon }}\n<signed-section content-hash="sha256:{{ $hash }}" style="display: block;">\n  <meta name="author" content="{{ .Params.author | default .Site.Params.author }}">\n  <meta name="signed-at" content="{{ now.Format "2006-01-02T15:04:05Z07:00" }}">\n  {{ range $key, $value := .Params.htmltrust.claims }}\n  <meta name="claim:{{ $key }}" content="{{ $value }}">\n  {{ end }}\n</signed-section>\n{{ end }}{{ end }}`);

    await writeFile(path.join(this.siteDir, "content/_index.md"),
      `---\ntitle: "${this.authorName} Blog"\n---\nWelcome to ${this.authorName}'s blog.`);
  }

  async addArticle(data: { slug: string; title: string; content: string; claims: Record<string, string> }): Promise<string> {
    const claimsYaml = Object.entries(data.claims).map(([k, v]) => `    ${k}: "${v}"`).join("\n");
    await writeFile(path.join(this.siteDir, "content/posts", `${data.slug}.md`),
      `---\ntitle: "${data.title}"\ndate: ${new Date().toISOString()}\ndraft: false\nauthor: "${this.authorName}"\nhtmltrust:\n  sign: true\n  claims:\n${claimsYaml}\n---\n\n${data.content}`);
    return `/posts/${data.slug}/`;
  }

  async build(outputDir: string): Promise<void> {
    await execFileAsync("hugo", ["--minify", "-d", outputDir], { cwd: this.siteDir, timeout: 30_000 });
  }
}
