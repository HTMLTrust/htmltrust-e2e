import path from "node:path";
import { composeUp, composeExec } from "../lib/docker.js";
import { generateNginxConfig } from "../lib/nginx-config.js";
import { createLocalSigner } from "../lib/local-signing.js";
import { publisherDirectory } from "../lib/scenario.js";
import { TrustApiClient } from "../lib/trust-api.js";
import type { ScenarioConfig, AuthorProfile, PhaseResult } from "../types.js";

export async function runPhase1(config: ScenarioConfig, authors: AuthorProfile[], e2eDir: string): Promise<PhaseResult> {
  const errors: string[] = [];
  const start = Date.now();

  console.log("[Phase 1] Bringing up Docker infrastructure...");
  await generateNginxConfig(authors, config.trust_directories, path.join(e2eDir, ".runtime", "nginx.conf"));
  await composeUp(e2eDir);
  // composeUp is also valid against an existing stack. Reload so a changed
  // scenario cannot leave nginx serving the previous author set.
  await composeExec(e2eDir, "nginx", ["nginx", "-s", "reload"]);

  const directories = config.trust_directories;
  const publisher = publisherDirectory(config);
  const clients = new Map(directories.map((directory) => [
    directory.id,
    new TrustApiClient(directory.url, directory.general_api_key, directory.admin_api_key),
  ]));

  // Seed claim types
  console.log("[Phase 1] Creating claim types...");
  for (const client of clients.values()) {
    for (const claim of [
      { name: "ContentType", description: "Type of content", possibleValues: ["Article", "Opinion", "News"] },
      { name: "License", description: "Content license", possibleValues: ["MIT", "CC-BY-4.0", "All Rights Reserved"] },
      { name: "AIAssistance", description: "AI involvement level", possibleValues: ["None", "Human+AI", "AI-only"] },
    ]) {
      await client.createClaimType(claim);
    }
  }

  // Create each publisher identity once. Other directories store opinions
  // under the exact signed keyid without receiving public or private key
  // material from the publishing directory.
  console.log("[Phase 1] Registering authors across directories...");
  for (const author of authors) {
    const publisherClient = clients.get(publisher.id)!;
    const publicKey = createLocalSigner(author.id);
    const result = await publisherClient.createAuthor({
      name: author.name, keyType: "HUMAN", keyAlgorithm: "ED25519",
      description: `${author.cmsType} author for E2E simulation`,
      url: `https://${author.domain}`,
      publicKey,
    });
    const pubKey = await publisherClient.getAuthorPublicKey(result.author.id);
    author.keyId = `${publisher.public_url.replace(/\/$/, "")}/keys/${encodeURIComponent(pubKey.id)}`;
    author.directoryIdentities[publisher.id] = {
      signerId: author.keyId,
      authorId: result.author.id,
      keyRecordId: pubKey.id,
    };

    // Prove the publisher received only the public half. Its convenience
    // signing endpoint must reject this author before any content is built.
    try {
      await publisherClient.signContent(result.authorApiKey, {
        contentHash: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        sourceURL: `https://${author.domain}/custody-check`,
        scope: "url",
        signedAt: "2026-08-28T12:00:00Z",
        claims: [],
      });
      errors.push(`${author.name}: publishing directory unexpectedly signed with a local private key`);
    } catch (error) {
      if (!String(error).includes("400")) {
        errors.push(`${author.name}: public-key custody check returned an unexpected error: ${error}`);
      }
    }

    for (const directory of directories) {
      if (directory.id === publisher.id) continue;
      author.directoryIdentities[directory.id] = {
        signerId: author.keyId,
      };
    }

    console.log(`  ${author.name} (${author.cmsType}, mal=${author.malicious_pct}) -> ${author.keyId}`);
  }

  // Seed opposite directory opinions. This produces a deterministic conflict
  // before consumer visits and gives the policy layer a real federation case.
  for (const directory of directories) {
    if (directory.initial_opinion === "neutral") continue;
    const client = clients.get(directory.id)!;
    for (const [authorIndex, author] of authors.entries()) {
      const identity = author.directoryIdentities[directory.id];
      if (identity.authorId) {
        const voteType = directory.initial_opinion === "support" ? "TRUST" : "DISTRUST";
        await client.vote({
          userId: `scenario-seed-${directory.id}`,
          targetType: "AUTHOR",
          targetId: identity.authorId,
          voteType,
          reason: `federation-${directory.initial_opinion}`,
        });
      } else if (authorIndex === 0) {
        const voteType = directory.initial_opinion === "support" ? "TRUST" : "DISTRUST";
        await client.voteSigner({
          signerId: author.keyId,
          voteType,
          reason: `federation-${directory.initial_opinion}`,
        });
        if (directory.initial_opinion === "challenge") {
          await client.reportSigner(author.keyId, {
            reason: "OTHER",
            details: "Deterministic conflicting opinion for the federation scenario",
            evidence: `https://${author.domain}/`,
          });
        }
      }
    }
  }

  // Create WordPress databases
  console.log("[Phase 1] Creating WordPress databases...");
  const wpAuthors = authors.filter((a) => a.cmsType === "wordpress");
  const rootPassword = process.env.WP_DB_ROOT_PASSWORD || "rootpass";
  for (let i = 0; i < wpAuthors.length; i++) {
    await composeExec(e2eDir, "wp-db", ["mariadb", "-uroot", `-p${rootPassword}`, "-e", `CREATE DATABASE IF NOT EXISTS wp${i + 1};`]);
  }

  // Wait for WordPress to be ready after DB creation
  console.log("[Phase 1] Waiting for WordPress containers...");
  const readyContainers = new Set<string>();
  for (const author of wpAuthors) {
    const c = author.wpContainerName!;
    let ready = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await composeExec(e2eDir, c, ["php", "-r", "echo 'ready';"]);
        ready = true;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!ready) {
      errors.push(`WordPress container ${c} did not become ready within 60 seconds: ${lastError}`);
    } else {
      readyContainers.add(c);
    }
  }

  // Configure WordPress instances
  console.log("[Phase 1] Configuring WordPress...");
  for (const author of wpAuthors) {
    try {
      const c = author.wpContainerName!;
      if (!readyContainers.has(c)) continue;
      await composeExec(e2eDir, c, ["wp", "core", "install",
        `--url=https://${author.domain}`, `--title=${author.name} Blog`,
        "--admin_user=admin", "--admin_password=admin", `--admin_email=admin@${author.domain}`,
        "--skip-email", "--allow-root"]);
      await composeExec(e2eDir, c, ["wp", "option", "update", "permalink_structure", "", "--allow-root"]);

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

  // Validation: every directory can state an opinion about the same signed
  // key identifier, even though only the publisher generated the key pair.
  for (const author of authors) {
    for (const directory of directories) {
      try {
        const identity = author.directoryIdentities[directory.id];
        if (identity.authorId) {
          const pk = await clients.get(directory.id)!.getAuthorPublicKey(identity.authorId);
          if (!pk.key) errors.push(`${author.name}: no public key in ${directory.id}`);
        }
        const isConflictSample = directory.initial_opinion === "challenge" && author === authors[0];
        if (identity.authorId || isConflictSample) {
          await clients.get(directory.id)!.getSignerReputation(author.keyId);
        }
      } catch (err) {
        errors.push(`${author.name}: federation registration failed in ${directory.id}: ${err}`);
      }
    }
  }

  return { phase: "infrastructure", success: errors.length === 0, duration: Date.now() - start, errors };
}
