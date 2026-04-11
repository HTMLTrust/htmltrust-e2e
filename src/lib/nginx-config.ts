import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthorProfile } from "../types.js";

/**
 * Generate nginx.conf based on the author list.
 * WordPress authors get reverse-proxied to their wp-N container.
 * Hugo authors serve static files from /var/www/hugo/<domain-slug>.
 */
export async function generateNginxConfig(authors: AuthorProfile[], outputPath: string): Promise<void> {
  const blocks: string[] = [];

  for (const author of authors) {
    const domain = author.domain;
    if (author.cmsType === "wordpress") {
      const container = author.wpContainerName!;
      blocks.push(
        `    server { listen 80; server_name ${domain}; location / { proxy_pass http://${container}:80; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; } }`
      );
    } else {
      // Hugo: static files, use domain slug (e.g. author3) as directory name
      const slug = domain.replace(".htmltrust.test", "");
      blocks.push(
        `    server { listen 80; server_name ${domain}; root /var/www/hugo/${slug}; index index.html; location / { try_files $uri $uri/ =404; } }`
      );
    }
  }

  const config = `events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

${blocks.join("\n")}

    server { listen 80 default_server; return 404; }
}
`;

  await writeFile(outputPath, config);
}
