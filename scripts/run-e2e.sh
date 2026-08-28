#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scenario="${1:-scenario-small.yaml}"
cd "$repo_dir"

for command_name in git node npm docker hugo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 2
  fi
done

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "Node.js 22 or newer is required; found $(node --version)" >&2
  exit 2
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required; 'docker compose' is unavailable" >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo "The Docker daemon is unavailable for the current user" >&2
  exit 2
fi

case "$scenario" in
  /*|*..*)
    echo "Scenario must be a path inside htmltrust-e2e" >&2
    exit 2
    ;;
esac

required_siblings=(
  htmltrust-browser-client
  htmltrust-browser-reference
  htmltrust-canonicalization
  htmltrust-cms-reference
  htmltrust-server-reference
)

declare -A expected_revisions=(
  [htmltrust-canonicalization]=760593d4a02e9fffa56dc4d002eb52ab2ade1b49
  [htmltrust-browser-client]=70c5ddb6ed23c06c0b1c46d5284618fb99a28aac
  [htmltrust-browser-reference]=a048b192f022b19d8d868b521aaf7091a550c217
  [htmltrust-cms-reference]=1b94416250b98123c125e60da92d6a6f2e16a9ce
  [htmltrust-server-reference]=07a286dfd0a219e75286e983315d5a886e9e1a2d
)

for repository in "${required_siblings[@]}"; do
  if [[ ! -d "$repo_dir/../$repository" ]]; then
    echo "Missing sibling checkout: $repo_dir/../$repository" >&2
    exit 2
  fi

  actual_revision="$(git -C "$repo_dir/../$repository" rev-parse HEAD)"
  dirty_state="$(git -C "$repo_dir/../$repository" status --porcelain)"
  if [[ "$actual_revision" != "${expected_revisions[$repository]}" || -n "$dirty_state" ]]; then
    if [[ "${HTMLTRUST_ALLOW_UNPINNED:-0}" != "1" ]]; then
      echo "Sibling checkout does not match the clean frozen revision: $repository" >&2
      echo "  expected: ${expected_revisions[$repository]}" >&2
      echo "  actual:   $actual_revision" >&2
      [[ -z "$dirty_state" ]] || echo "  working tree has local changes" >&2
      echo "Set HTMLTRUST_ALLOW_UNPINNED=1 only when intentionally testing local dependency work." >&2
      exit 2
    fi
    echo "Warning: testing an unpinned or dirty $repository checkout" >&2
  fi
done

if [[ ! -f "$repo_dir/$scenario" ]]; then
  echo "Scenario does not exist: $repo_dir/$scenario" >&2
  exit 2
fi

export HTMLTRUST_HOST_UID="${HTMLTRUST_HOST_UID:-$(id -u)}"
export HTMLTRUST_HOST_GID="${HTMLTRUST_HOST_GID:-$(id -g)}"

echo "Building the pinned browser packages"
npm --prefix "$repo_dir/../htmltrust-canonicalization" ci --ignore-scripts --no-audit --no-fund
npm --prefix "$repo_dir/../htmltrust-browser-client" ci
npm --prefix "$repo_dir/../htmltrust-browser-client" run build
npm --prefix "$repo_dir/../htmltrust-browser-reference" ci --ignore-scripts=false
npm --prefix "$repo_dir/../htmltrust-browser-reference" run build:chromium

echo "Installing and checking the harness"
npm --prefix "$repo_dir" ci
npm --prefix "$repo_dir" test
npm --prefix "$repo_dir" run build
npm --prefix "$repo_dir" run config:nginx -- "$scenario"

echo "Starting the integration stack"
docker compose --project-directory "$repo_dir" up -d --build --wait

echo "Publishing signed content"
node --import tsx "$repo_dir/src/smoke-test.ts" "$repo_dir/$scenario"

echo "Checking the built Chromium extension"
npm --prefix "$repo_dir" run test:browser:extension

echo "Checking WordPress browser-local signing"
docker compose --project-directory "$repo_dir" run --rm --entrypoint npx playwright \
  tsx scripts/wordpress-local-signing-test.ts

echo "Running browser, reporting, and validation phases"
docker compose --project-directory "$repo_dir" run --rm --entrypoint npx playwright \
  tsx src/run-phases-3-5.ts "$scenario"

echo "Results: $repo_dir/results"
echo "Cleanup: docker compose --project-directory $repo_dir down -v"
