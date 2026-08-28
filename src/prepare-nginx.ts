import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateNginxConfig } from "./lib/nginx-config.js";
import { generateAuthorProfiles, loadScenario } from "./lib/scenario.js";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenario = path.resolve(directory, process.argv[2] || "scenario-small.yaml");
const config = await loadScenario(scenario);
const authors = generateAuthorProfiles(config);
const output = path.join(directory, ".runtime", "nginx.conf");

await generateNginxConfig(authors, output);
console.log(`Generated ${output} for ${authors.length} authors`);
