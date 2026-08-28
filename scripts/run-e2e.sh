#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scenario="${1:-scenario-small.yaml}"
cd "$repo_dir"

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
  [htmltrust-canonicalization]=5e51040dcaaf50935e245702bdefbc18a1d542ce
  [htmltrust-browser-client]=f21504e170c6b29e91eda3bb491bf4580e5f5a86
  [htmltrust-browser-reference]=407bace3ad792384ba623b5db795f3f32acd16ca
  [htmltrust-cms-reference]=69aafdfad2c81766f2717b88525f2569370f96cd
  [htmltrust-server-reference]=56ab5c06e901f8f48753e3a511dd9dda755b9bac
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

echo "Building the pinned browser packages"
npm --prefix "$repo_dir/../htmltrust-canonicalization/javascript" install \
  --package-lock=false --ignore-scripts --no-audit --no-fund
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

echo "Running browser, reporting, and validation phases"
docker compose --project-directory "$repo_dir" run --rm --entrypoint npx playwright \
  tsx src/run-phases-3-5.ts "$scenario"

echo "Results: $repo_dir/results"
echo "Cleanup: docker compose --project-directory $repo_dir down -v"
