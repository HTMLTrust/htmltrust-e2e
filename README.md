# HTMLTrust end-to-end harness

- Maintainer: Jason Grey
- Updated: 2026-08-28
- Version: 0.1.0, frozen v1 profile
- Status: Active integration harness
- For: contributors and continuous integration maintainers
- Reading time: 8 minutes

This harness publishes v1 signed content through WordPress and Hugo, serves it over test HTTPS, verifies the original response source in Chromium, and records research output. Simulated authors generate Ed25519 keys locally. The alpha directory receives public keys only. Browser policy combines weighted opinions from independent alpha and beta directory databases.

## Choose a path

- Run `npm test && npm run build` when you are changing TypeScript helpers.
- Run `npm test -- tests/lib/playwright-session.test.ts && npm run build` for
  the browser lifecycle evidence checks (source mapping, nested markers,
  mutation invalidation, and reload snapshot recovery).
- Run `npm run test:browser` for the same lifecycle checks in the production
  DOM walker. This uses the checked-in Playwright Docker image and does not
  start the integration stack; `npm test` remains browser-download-free.
- Run `npm run test:wordpress-local-signing` after the smoke setup to exercise
  the CMS plugin's admin UI, local key document, and emitted signature.
- Run `npm run e2e:small` for the complete three-author simulation.
- Use the split commands below when you need to inspect the stack between publication and browser verification.

## Checkout layout and compatible revisions

The package manifest uses these local paths:

```
htmltrust/
├── htmltrust-canonicalization/
├── htmltrust-browser-client/
├── htmltrust-browser-reference/
├── htmltrust-cms-reference/
├── htmltrust-e2e/                 # this repository
└── htmltrust-server-reference/
```

Create or refresh that layout from its parent directory. The loop is safe to
rerun: existing checkouts are fetched, and missing checkouts are cloned.

```bash
mkdir -p htmltrust
cd htmltrust
for repository in \
  htmltrust-canonicalization \
  htmltrust-browser-client \
  htmltrust-browser-reference \
  htmltrust-cms-reference \
  htmltrust-e2e \
  htmltrust-server-reference; do
  if git -C "$repository" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$repository" fetch --all --tags
  elif [ -e "$repository" ]; then
    printf '%s\n' "$repository exists but is not a Git checkout" >&2
    exit 1
  else
    git clone "https://github.com/HTMLTrust/$repository.git" "$repository"
  fi
done
```

The frozen v1 integration uses these immutable revisions:

```bash
git -C htmltrust-canonicalization checkout 760593d4a02e9fffa56dc4d002eb52ab2ade1b49
git -C htmltrust-browser-client checkout 70c5ddb6ed23c06c0b1c46d5284618fb99a28aac
git -C htmltrust-browser-reference checkout b9ec8a2af7d495ece58b5027b4f4cb97c7e5f3ff
git -C htmltrust-cms-reference checkout 1b94416250b98123c125e60da92d6a6f2e16a9ce
git -C htmltrust-server-reference checkout 07a286dfd0a219e75286e983315d5a886e9e1a2d
```

The revisions in this block are the frozen set exercised by the small scenario.
The one-command runner checks each revision and requires clean sibling working
trees. When you are developing a sibling package, set
`HTMLTRUST_ALLOW_UNPINNED=1` for that run and record the actual revision and
working-tree state with the result.

## Prerequisites

For unit tests and the TypeScript build:

- Node.js 22 and npm
- the sibling canonicalization and browser-client checkouts above, because the
  harness manifest uses local `file:` dependencies

For browser lifecycle tests, also check out and build the sibling
`htmltrust-browser-reference`. The unit suite does not need a browser or that
extension checkout. For the full simulation, also install:

- Docker Engine with Compose v2
- Hugo on the host
- Ollama with the model named by the scenario

Verify Compose v2 before starting the stack:

```bash
docker compose version
```

Hugo 0.128.0 or newer is supported, matching the module requirement in the
Hugo integration repository. This harness writes its own temporary Hugo sites
and uses the Hugo partial bundled in `htmltrust-cms-reference`; it does not
consume the separate `htmltrust-hugo` repository.

The browser phase uses the sibling browser-reference checkout and its Chromium build. The one-command runner builds it before starting Docker.

## Install and check the harness

Install the canonicalizer's parser dependency and build the browser client
before installing this repository. The browser client's `dist/` directory is
ignored by Git, and npm needs it when it installs the local `file:` dependency.

```bash
cd ../htmltrust-canonicalization/javascript
npm install --package-lock=false --ignore-scripts --no-audit --no-fund

cd ../htmltrust-browser-client
npm ci
npm run build

cd ../htmltrust-e2e
npm ci
npm test
npm run build
```

These checks need the canonicalization and browser-client sibling directories.
They do not start Docker, Hugo, or Ollama. Install and build the
browser-reference extension only for the browser flow:

```bash
cd ../htmltrust-browser-reference
npm ci --ignore-scripts=false
npm run build:chromium
cd ../htmltrust-e2e
```

The explicit flag allows the pinned Git dependency to build its `dist/` directory when npm is configured globally to skip lifecycle scripts.

The WordPress services do not need a host PHP, Composer, or CMS checkout at run
time. `Dockerfile.wordpress` copies the sibling CMS plugin into the image and
runs Composer during the image build, so the plugin and its production
dependencies are bundled in each WordPress image.

## Run the small simulation

Start Ollama in another terminal and load the model configured in
`scenario-small.yaml`:

```bash
ollama serve
ollama pull llama3.2:1b
```

From `htmltrust-e2e`, run the complete simulation:

```bash
npm run e2e:small
```

The runner installs and builds the sibling browser packages, checks this repository, builds the Compose stack, publishes the test sites, and runs browser verification in the Playwright container. It writes ignored output under `results/`, `hugo-sources/`, and `hugo-sites/`. The stack stays up after the run so you can inspect logs.

## Run the full simulation

The checked-in full scenario uses ten authors and 1,000 consumers. Copy it before changing the Ollama endpoint or model:

```bash
cp scenario.yaml scenario-local.yaml
# Edit scenario-local.yaml, including ollama.host or ollama.model.
./scripts/run-e2e.sh scenario-local.yaml
```

Publication runs on the host, so use `http://localhost:11434` as the Ollama host. Browser verification runs inside Docker. The generated article URLs remain `https://authorN.htmltrust.test/...` on the Docker network.

## Run browser phases in Docker

Use this split flow when you want to inspect publication output before browser verification:

```bash
npm run config:nginx -- scenario-small.yaml
docker compose up -d --build --wait
npx tsx src/smoke-test.ts scenario-small.yaml
npm run test:wordpress-local-signing
docker compose run --rm --entrypoint npx playwright tsx src/run-phases-3-5.ts scenario-small.yaml
```

Nginx writes no tracked source file. The generated configuration lives at
`.runtime/nginx.conf`. It proxies article hosts plus
`https://trust-a.htmltrust.test` and `https://trust-b.htmltrust.test`. This lets
the browser exercise HTTPS-only key retrieval and weighted directory queries.

The smoke test creates `results/ground-truth.json` and an isolated
`results/wordpress-local-signing.json` fixture record. The local signing check
logs into the first WordPress site, signs that fixture through the plugin's
Sign Now control, fetches its public key document, and verifies the published
section. The final command runs consumer browsing, researcher reports,
post-report visits, and validation. Chromium accepts the test-only wildcard
certificate generated by `Dockerfile.nginx`.

The one-command runner maps Playwright to the host user, so generated results
remain removable without root access. Direct Compose commands default to UID
and GID 1000. Set `HTMLTRUST_HOST_UID=$(id -u)` and
`HTMLTRUST_HOST_GID=$(id -g)` first when your account uses different values.

## Run individual checks and services

Run the local checks again at any time:

```bash
npm test
npm run build
```

Start both isolated trust directories and MongoDB while working on the server image:

```bash
docker compose up -d --build mongodb trust-directory-alpha trust-directory-beta
docker compose logs -f trust-directory-alpha trust-directory-beta
```

Start the WordPress database and one site while working on the CMS mount:

```bash
docker compose up -d --build wp-db wp-1
```

Analyze results after a simulation has produced the three input files:

```bash
npm run analyze
```

The analyzer uses Python 3.11 or newer and has no third-party dependencies.
Run its regression test with `npm run test:analysis`.

## Configuration

Both scenarios are YAML files. Directory-specific variables follow the
`HTMLTRUST_DIRECTORY_<ID>_<FIELD>` pattern. Override alpha for one run like
this:

```bash
HTMLTRUST_DIRECTORY_ALPHA_URL=http://localhost:3000 \
HTMLTRUST_DIRECTORY_ALPHA_GENERAL_API_KEY=my-general-key \
HTMLTRUST_DIRECTORY_ALPHA_ADMIN_API_KEY=my-admin-key \
npm run e2e:small
```

Use the same names with `BETA` for the second directory. Compose accepts
`HTMLTRUST_DIRECTORY_ALPHA_PORT`, `HTMLTRUST_DIRECTORY_BETA_PORT`,
`HTMLTRUST_DIRECTORY_ALPHA_PUBLIC_URL`,
`HTMLTRUST_DIRECTORY_BETA_PUBLIC_URL`, `HTMLTRUST_PROXY_PORT`,
`HTMLTRUST_TLS_PROXY_PORT`, `WP_DB_ROOT_PASSWORD`, and `WP_DB_PASSWORD`.
The checked-in credentials are for local testing only.

`URL` is the host-side API origin. `CONTAINER_URL` is the matching origin on
the Compose network. `PUBLIC_URL` is the HTTPS origin written into browser
subscriptions and key documents. The bundled Compose network resolves
`trust-a.htmltrust.test` and `trust-b.htmltrust.test`; another public hostname
needs a matching network alias or external DNS that the Playwright container
can resolve.

## Troubleshooting

- `npm ci` cannot find a browser-client file: build
  `../htmltrust-browser-client` first, then rerun `npm ci` here.
- Docker cannot copy a sibling directory: check the layout and run Compose
  from `htmltrust-e2e`.
- Hugo publication fails: confirm that `hugo version` works on the host.
- Article generation fails: run `curl http://localhost:11434/api/tags`, pull
  `llama3.2:1b`, and check that the scenario's Ollama host is reachable.
- Browser phases cannot resolve author hosts: run them in the Playwright
  service with `docker compose run --rm playwright ...`.
- HTTPS publication fails: confirm that port `18443` is free and inspect `docker compose logs nginx`.
- A previous run left stale databases: use the cleanup command below.

Inspect service state and logs:

```bash
docker compose ps
docker compose logs trust-directory-alpha trust-directory-beta nginx wp-1 wp-2 wp-3
```

## Cleanup

Remove this Compose project's containers, network, and named volumes:

```bash
docker compose down -v
```

The command does not remove source checkouts. The next run rebuilds the stack
with `docker compose up -d --build --wait`.

## Related files

- [`scenario-small.yaml`](scenario-small.yaml) defines the integration smoke
  test.
- [`scenario.yaml`](scenario.yaml) defines the larger simulation.
- [`analysis/analyze.py`](analysis/analyze.py) analyzes simulation output.
- [CI workflow](.github/workflows/ci.yml) records the currently tested package
  revisions.

Open an issue with the failing phase, command output, scenario file, and `results/ground-truth.json`. Do not include API keys from a non-test deployment.
