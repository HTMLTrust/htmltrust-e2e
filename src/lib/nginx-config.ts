import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthorProfile, TrustDirectoryConfig } from "../types.js";

/**
 * Generate nginx.conf based on the author list.
 * WordPress authors get reverse-proxied to their wp-N container.
 * Hugo authors serve static files from /var/www/hugo/<domain-slug>.
 */
export async function generateNginxConfig(
  authors: AuthorProfile[],
  directories: TrustDirectoryConfig[],
  outputPath: string,
): Promise<void> {
  const blocks: string[] = [];
  const listeners = "listen 80; listen 443 ssl;";
  const tls = "ssl_certificate /etc/nginx/certs/htmltrust.test.crt; ssl_certificate_key /etc/nginx/certs/htmltrust.test.key;";

  for (const author of authors) {
    const domain = author.domain;
    if (author.cmsType === "wordpress") {
      const container = author.wpContainerName!;
      blocks.push(
        `    server { ${listeners} ${tls} server_name ${domain}; location / { proxy_pass http://${container}:80; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; } }`
      );
    } else {
      // Hugo: static files, use domain slug (e.g. author3) as directory name
      const slug = domain.replace(".htmltrust.test", "");
      blocks.push(
        `    server { ${listeners} ${tls} server_name ${domain}; root /var/www/hugo/${slug}; index index.html; location / { try_files $uri $uri/ =404; } }`
      );
    }
  }

  for (const directory of directories) {
    const publicUrl = new URL(directory.public_url);
    const containerUrl = new URL(directory.container_url);
    blocks.push(
      `    server { ${listeners} ${tls} server_name ${publicUrl.hostname}; location / { proxy_pass ${containerUrl.origin}; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; } }`
    );
  }

  const config = `events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

${blocks.join("\n")}

    server { listen 80 default_server; listen 443 ssl default_server; ${tls} location = /healthz { return 200 'ok'; } location / { return 404; } }
}
`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, config);
}
