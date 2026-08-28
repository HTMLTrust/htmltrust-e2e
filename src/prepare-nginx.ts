import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateNginxConfig } from "./lib/nginx-config.js";
import { generateAuthorProfiles, loadScenario } from "./lib/scenario.js";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenario = path.resolve(directory, process.argv[2] || "scenario-small.yaml");
const config = await loadScenario(scenario);
const authors = generateAuthorProfiles(config);
await Promise.all([
  mkdir(path.join(directory, "hugo-sites"), { recursive: true }),
  mkdir(path.join(directory, "hugo-sources"), { recursive: true }),
  mkdir(path.join(directory, "results"), { recursive: true }),
]);
const output = path.join(directory, ".runtime", "nginx.conf");

await generateNginxConfig(authors, config.trust_directories, output);
console.log(`Generated ${output} for ${authors.length} authors`);
