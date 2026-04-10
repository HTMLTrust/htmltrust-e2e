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

  // Configure WordPress instances
  console.log("[Phase 1] Configuring WordPress...");
  for (const author of authors.filter((a) => a.cmsType === "wordpress")) {
    try {
      const c = author.wpContainerName!;
      await composeExec(e2eDir, c, ["wp", "core", "install",
        `--url=http://${author.domain}`, `--title=${author.name} Blog`,
        "--admin_user=admin", "--admin_password=admin", `--admin_email=admin@${author.domain}`,
        "--skip-email", "--allow-root"]);
      await composeExec(e2eDir, c, ["wp", "plugin", "activate", "content-signing", "--allow-root"]);
      await composeExec(e2eDir, c, ["wp", "option", "update", "content_signing_enable_signing", "1", "--allow-root"]);
      await composeExec(e2eDir, c, ["wp", "option", "update", "content_signing_sign_on_publish", "1", "--allow-root"]);

      const evalScript = [
        "global $wpdb;",
        `$wpdb->insert($wpdb->prefix.'content_signing_servers', ['name'=>'Trust Server','api_url'=>'${config.trust_server.url}','api_key_encrypted'=>'${config.trust_server.general_api_key}','is_default_server'=>1]);`,
        "$sid=$wpdb->insert_id;",
        `$wpdb->insert($wpdb->prefix.'content_signing_authors', ['wp_user_id'=>1,'signing_author_id'=>'${author.id}','server_id'=>$sid,'author_api_key_encrypted'=>'${author.authorApiKey}','default_key_type'=>'HUMAN','default_claims_json'=>'{}','is_site_endorser'=>0]);`,
      ].join(" ");
      await composeExec(e2eDir, c, ["wp", "eval", evalScript, "--allow-root"]);
      console.log(`  Configured ${c}`);
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
