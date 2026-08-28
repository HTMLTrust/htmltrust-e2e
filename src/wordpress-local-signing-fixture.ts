import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthorProfile } from "./types.js";
import { composeExec, writeFileToContainer } from "./lib/docker.js";

export interface WordPressLocalSigningFixture {
  postId: number;
  editUrl: string;
  publicUrl: string;
}

const FIXTURE_TITLE = "HTMLTrust browser-local signing fixture";
const FIXTURE_CONTENT = "<p>This post is signed by the WordPress browser-local signing fixture.</p>";
const CONTAINER_POST_FILE = "/tmp/htmltrust-browser-local-signing-fixture.html";

/**
 * Prepare an isolated WordPress post for the real browser signing check.
 *
 * The profile is deliberately local-only. It has no directory server and no
 * API credential. The plugin's own DB class is exercised by the browser flow;
 * this setup only inserts the minimum profile row needed by that class.
 */
export async function prepareWordPressLocalSigningFixture(
  e2eDir: string,
  author: AuthorProfile,
): Promise<WordPressLocalSigningFixture> {
  const container = author.wpContainerName;
  if (!container) throw new Error("wordpress-local-signing: author has no container");

  await composeExec(e2eDir, container, ["wp", "plugin", "activate", "content-signing", "--allow-root"]);
  for (const [option, value] of [
    ["content_signing_enable_signing", "1"],
    ["content_signing_embed_signature", "1"],
    // Publishing the fixture must leave the actual signing action to the UI.
    ["content_signing_sign_on_publish", "0"],
  ]) {
    await composeExec(e2eDir, container, ["wp", "option", "update", option, value, "--allow-root"]);
  }

  const profileScript = String.raw`
$user = get_user_by('login', 'admin');
if (!$user) { WP_CLI::error('admin user is missing'); }
global $wpdb;
$table = $wpdb->prefix . 'content_signing_authors';
$profile = array(
    'wp_user_id' => (int) $user->ID,
    'signing_author_id' => 'htmltrust-browser-local-fixture',
    'server_id' => 0,
    'author_api_key_encrypted' => '',
    'default_key_type' => 'HUMAN',
    'default_claims_json' => '{}',
    'is_site_endorser' => 0,
    'updated_at' => current_time('mysql'),
);
$existing = $wpdb->get_row($wpdb->prepare("SELECT author_profile_id FROM {$table} WHERE wp_user_id = %d LIMIT 1", $user->ID));
if (!$existing) {
    $now = current_time('mysql');
    $profile['created_at'] = $now;
    $ok = $wpdb->insert($table, $profile,
      array('%d', '%s', '%d', '%s', '%s', '%s', '%d', '%s', '%s'));
    if (!$ok) { WP_CLI::error('could not insert local-only author profile: ' . $wpdb->last_error); }
    $profileId = $wpdb->insert_id;
} else {
    $ok = $wpdb->update($table, $profile, array('author_profile_id' => (int) $existing->author_profile_id),
      array('%d', '%s', '%d', '%s', '%s', '%s', '%d', '%s'), array('%d'));
    if (false === $ok) { WP_CLI::error('could not reset admin profile to local-only: ' . $wpdb->last_error); }
    $profileId = (int) $existing->author_profile_id;
}
echo wp_json_encode(array('profileId' => (int) $profileId, 'userId' => (int) $user->ID));
`;
  const profileResultText = (await composeExec(e2eDir, container, ["wp", "eval", profileScript, "--allow-root"])).trim();
  let profileResult: { profileId?: unknown; userId?: unknown };
  try {
    profileResult = JSON.parse(profileResultText) as { profileId?: unknown; userId?: unknown };
  } catch {
    throw new Error(`wordpress-local-signing: invalid profile result ${profileResultText}`);
  }
  const profileId = Number(profileResult.profileId);
  const adminUserId = Number(profileResult.userId);
  if (!Number.isInteger(profileId) || profileId <= 0 || !Number.isInteger(adminUserId) || adminUserId <= 0) {
    throw new Error(`wordpress-local-signing: invalid profile result ${profileResultText}`);
  }

  await writeFileToContainer(e2eDir, container, CONTAINER_POST_FILE, FIXTURE_CONTENT);
  const postIdText = (await composeExec(e2eDir, container, [
    "wp", "post", "create", CONTAINER_POST_FILE,
    `--post_title=${FIXTURE_TITLE}`,
    "--post_status=publish",
    "--post_type=post",
    `--post_author=${adminUserId}`,
    "--porcelain",
    "--allow-root",
  ])).trim();
  await composeExec(e2eDir, container, ["rm", "-f", CONTAINER_POST_FILE]);
  if (!/^\d+$/.test(postIdText)) throw new Error(`wordpress-local-signing: invalid post id ${postIdText}`);
  const postId = Number(postIdText);

  const publicUrl = (await composeExec(e2eDir, container, ["wp", "post", "url", postIdText, "--allow-root"])).trim();
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== "https:" || parsed.host !== author.domain) {
    throw new Error(`wordpress-local-signing: unexpected fixture URL ${publicUrl}`);
  }

  const editUrl = new URL(`/wp-admin/post.php?post=${postId}&action=edit`, publicUrl).toString();
  const fixture: WordPressLocalSigningFixture = { postId, editUrl, publicUrl };
  const resultsDir = path.join(e2eDir, "results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, "wordpress-local-signing.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  return fixture;
}
