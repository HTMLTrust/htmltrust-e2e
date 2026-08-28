# HTMLTrust end-to-end harness

- Maintainer: Jason Grey
- Updated: 2026-08-28
- Version: 0.1.0, frozen v1 profile
- Status: Active integration harness
- For: contributors and continuous integration maintainers
- Reading time: 8 minutes

This harness publishes v1 signed content through WordPress and Hugo, serves it over test HTTPS, verifies the original response source in Chromium, applies trust policy, and records research output. It uses local packages from sibling checkouts.

## Choose a path

- Run `npm test && npm run build` when you are changing TypeScript helpers.
- Run `npm test -- tests/lib/playwright-session.test.ts && npm run build` for
  the browser lifecycle evidence checks (source mapping, nested markers,
  mutation invalidation, and reload snapshot recovery).
- Run `npm run test:browser` for the same lifecycle checks in the production
  DOM walker. This uses the checked-in Playwright Docker image and does not
  start the integration stack; `npm test` remains browser-download-free.
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

Create that layout from an empty parent directory:

```bash
mkdir htmltrust && cd htmltrust
git clone https://github.com/HTMLTrust/htmltrust-canonicalization.git
git clone https://github.com/HTMLTrust/htmltrust-browser-client.git
git clone https://github.com/HTMLTrust/htmltrust-browser-reference.git
git clone https://github.com/HTMLTrust/htmltrust-cms-reference.git
git clone https://github.com/HTMLTrust/htmltrust-e2e.git
git clone https://github.com/HTMLTrust/htmltrust-server-reference.git
```

The frozen v1 integration uses these immutable revisions:

```bash
git -C htmltrust-canonicalization checkout b0c8f305425de190a7f209ac117d34f88c2b1946
git -C htmltrust-browser-client checkout d25c6d3c2d0f4d67483da20853f22e94a11b89cc
git -C htmltrust-browser-reference checkout 5237f07098da8b6542f0fd8f1c613ae8dbf4e6dd
git -C htmltrust-cms-reference checkout 69aafdfad2c81766f2717b88525f2569370f96cd
git -C htmltrust-server-reference checkout f84f51482ba2a925d9b5ff148185adf6dedef566
```

The one-command runner checks these revisions and requires clean sibling working
trees. This keeps a recorded run tied to the source versions above. When you are
developing a sibling package, set `HTMLTRUST_ALLOW_UNPINNED=1` for that run and
record the actual revision and working-tree state with the result.

## Prerequisites

For tests and the TypeScript build:

- Node.js 22 and npm
- the sibling canonicalization and browser-client checkouts above

For the full simulation, also install:

- Docker Engine with Compose v2
- Hugo on the host
- Ollama with the model named by the scenario

The browser phase uses the sibling browser-reference checkout and its Chromium build. The one-command runner builds it before starting Docker.

## Install and check the harness

Install the canonicalizer's parser dependency and build the browser client
before installing this repository. The browser client's `dist/` directory is
ignored by Git, and npm needs it when it installs the local `file:` dependency.

```bash
cd ../htmltrust-canonicalization/javascript
npm install --package-lock=false

cd ../htmltrust-browser-client
npm ci
npm run build

cd ../htmltrust-e2e
npm ci
npm test
npm run build
```

These checks need the two sibling directories. They do not start Docker, Hugo, or Ollama. Install the browser-reference extension only for the browser flow:

```bash
cd ../htmltrust-browser-reference
npm ci --ignore-scripts=false
npm run build:chromium
cd ../htmltrust-e2e
```

The explicit flag allows the pinned Git dependency to build its `dist/` directory when npm is configured globally to skip lifecycle scripts.

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
docker compose run --rm --entrypoint npx playwright tsx src/run-phases-3-5.ts scenario-small.yaml
```

Nginx writes no tracked source file. The generated configuration lives at
`.runtime/nginx.conf`. It proxies article hosts and the test directory hostname
`https://trust.htmltrust.test`, which lets the browser exercise the verifier's
HTTPS-only key retrieval policy.

The smoke test creates `results/ground-truth.json`. The second command runs consumer browsing, researcher reports, post-report visits, and validation. Chromium accepts the test-only wildcard certificate generated by `Dockerfile.nginx`.

## Run individual checks and services

Run the local checks again at any time:

```bash
npm test
npm run build
```

Start only the trust directory and MongoDB while working on the server image:

```bash
docker compose up -d --build mongodb trust-server
docker compose logs -f trust-server
```

Start the WordPress database and one site while working on the CMS mount:

```bash
docker compose up -d --build wp-db wp-1
```

Analyze results after a simulation has produced the three input files:

```bash
uv run python analysis/analyze.py results
```

## Configuration

Both scenarios are YAML files. Override local service settings for one run:

```bash
HTMLTRUST_TRUST_SERVER_URL=http://localhost:3000 \
HTMLTRUST_GENERAL_API_KEY=my-general-key \
HTMLTRUST_ADMIN_API_KEY=my-admin-key \
npm run e2e:small
```

Compose also accepts `HTMLTRUST_TRUST_PORT`, `HTMLTRUST_PROXY_PORT`,
`HTMLTRUST_TLS_PROXY_PORT`, `HTMLTRUST_DIRECTORY_BASE_URL`, `WP_DB_ROOT_PASSWORD`, `WP_DB_PASSWORD`,
`HTMLTRUST_GENERAL_API_KEY`, and `HTMLTRUST_ADMIN_API_KEY`. The checked-in
credentials are for local testing only.

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
docker compose logs trust-server nginx wp-1 wp-2 wp-3
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
