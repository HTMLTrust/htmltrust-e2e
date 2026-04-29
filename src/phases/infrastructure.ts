import { composeUp, composeExec } from "../lib/docker.js";
import { TrustApiClient } from "../lib/trust-api.js";
import type { ScenarioConfig, AuthorProfile, PhaseResult } from "../types.js";

export async function runPhase1(config: ScenarioConfig, authors: AuthorProfile[], e2eDir: string): Promise<PhaseResult> {
  const errors: string[] = [];
  const start = Date.now();

  console.log("[Phase 1] Bringing up Docker infrastructure...");
  await composeUp(e2eDir);

  const client = new TrustApiClient(config.trust_server.url, config.trust_server.general_api_key, config.trust_server.admin_api_key);

  // Seed claim types
  console.log("[Phase 1] Creating claim types...");
  for (const claim of [
    { name: "ContentType", description: "Type of content", possibleValues: ["Article", "Opinion", "News"] },
    { name: "License", description: "Content license", possibleValues: ["MIT", "CC-BY-4.0", "All Rights Reserved"] },
    { name: "AIAssistance", description: "AI involvement level", possibleValues: ["None", "Human+AI", "AI-only"] },
  ]) {
    await client.createClaimType(claim);
  }

  // Create authors on trust server
  console.log("[Phase 1] Creating authors...");
  for (const author of authors) {
    const result = await client.createAuthor({
      name: author.name, keyType: "HUMAN", keyAlgorithm: "ED25519",
      description: `${author.cmsType} author for E2E simulation`,
      url: `http://${author.domain}`,
    });
    author.id = result.author.id;
    author.authorApiKey = result.authorApiKey;
    const pubKey = await client.getAuthorPublicKey(author.id);
    author.keyId = pubKey.id;
    console.log(`  ${author.name} (${author.cmsType}, mal=${author.malicious_pct}) -> ${author.id}`);
  }

  // Create WordPress databases
  console.log("[Phase 1] Creating WordPress databases...");
  const wpAuthors = authors.filter((a) => a.cmsType === "wordpress");
  for (let i = 0; i < wpAuthors.length; i++) {
    await composeExec(e2eDir, "wp-db", ["mariadb", "-uroot", "-prootpass", "-e", `CREATE DATABASE IF NOT EXISTS wp${i + 1};`]);
  }

  // Wait for WordPress to be ready after DB creation
  console.log("[Phase 1] Waiting for WordPress containers...");
  for (const author of wpAuthors) {
    const c = author.wpContainerName!;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await composeExec(e2eDir, c, ["php", "-r", "echo 'ready';"]);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // Configure WordPress instances
  console.log("[Phase 1] Configuring WordPress...");
  for (const author of wpAuthors) {
    try {
      const c = author.wpContainerName!;
      await composeExec(e2eDir, c, ["wp", "core", "install",
        `--url=http://${author.domain}`, `--title=${author.name} Blog`,
        "--admin_user=admin", "--admin_password=admin", `--admin_email=admin@${author.domain}`,
        "--skip-email", "--allow-root"]);

      // Activate the content-signing plugin. The plugin source is mounted into
      // the container by docker-compose at wp-content/plugins/content-signing.
      // Previously skipped because of a DB init-order bug
      // (htmltrust-cms-reference fix/wp-plugin-init-and-audit) that crashed
      // activation by querying wp_content_signing_servers before the activator
      // had created it. That fix defers component init to the WP 'init' action
      // and adds a maybe_install_schema() guard, so activation now succeeds.
      await composeExec(e2eDir, c, ["wp", "plugin", "activate", "content-signing", "--allow-root"]);

      console.log(`  Installed ${c}`);
    } catch (err) {
      errors.push(`WP config failed for ${author.name}: ${err}`);
    }
  }

  // Validation: all authors have keys
  for (const author of authors) {
    try {
      const pk = await client.getAuthorPublicKey(author.id);
      if (!pk.key) errors.push(`${author.name}: no public key`);
    } catch (err) {
      errors.push(`${author.name}: key fetch failed: ${err}`);
    }
  }

  return { phase: "infrastructure", success: errors.length === 0, duration: Date.now() - start, errors };
}
