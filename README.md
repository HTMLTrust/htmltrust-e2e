# HTMLTrust end-to-end harness

Run the HTMLTrust simulation from a fresh checkout, or run its unit tests and
TypeScript build. This repository uses local packages from sibling checkouts.

Status: active integration harness
Primary readers: contributors and CI maintainers
Start here: use the pinned v0.2.2-compatible layout below

## Choose a path

- For a quick local check, prepare the sibling packages, then run `npm test`
  and `npm run build`.
- For the integration smoke test, install Docker, Hugo, and Ollama, then run
  `npm start -- scenario-small.yaml`.
- For the browser phase in a Playwright container, use the split flow below.

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

This harness and its CI currently use the v0.2.2-compatible stack. Pin the two
JavaScript dependencies to the revisions used by CI before installing:

```bash
git -C htmltrust-canonicalization checkout 79b0d52fecd958f8fc7ade713fe0799ca1e79626
git -C htmltrust-browser-client checkout 09e8c7552c8111a2cedd83fa45f4ffe3811bf5ca
```

The current canonicalization `main` contains the newer 0.3.x package, while
the browser client still declares a 0.2.2 peer dependency. Do not combine
those mains with this harness unless you have verified and updated the full
stack together.

## Prerequisites

For tests and the TypeScript build:

- Node.js 22 and npm
- the sibling canonicalization and browser-client checkouts above

For the full simulation, also install:

- Docker Engine with Compose v2
- Hugo on the host
- Ollama with the model named by the scenario

The extension-aware browser phase also needs the browser-reference checkout
and its Chromium build.

## Install and check the harness

Build both local package dependencies before installing this repository. The
browser client's `dist/` directory is ignored by Git, and npm needs it when it
installs the local `file:` dependency.

```bash
cd ../htmltrust-browser-client
npm ci
npm run build

cd ../htmltrust-e2e
npm ci
npm test
npm run build
```

These checks still need the two sibling directories. They do not start Docker,
Hugo, or Ollama. Install the browser-reference extension only for the browser
flow:

```bash
cd ../htmltrust-browser-reference
npm ci --ignore-scripts=false
npm run build:chromium
cd ../htmltrust-e2e
```

The explicit flag allows the pinned Git dependency to build its `dist/`
directory when npm is configured globally to skip lifecycle scripts.

## Run the small simulation

Start Ollama in another terminal and load the model configured in
`scenario-small.yaml`:

```bash
ollama serve
ollama pull llama3.2:3b
```

From `htmltrust-e2e`, run the complete host-side simulation:

```bash
npm start -- scenario-small.yaml
```

The orchestrator builds the Compose stack, publishes the test sites, runs the
consumer and researcher phases, validates the results, and writes ignored
output under `results/`, `hugo-sources/`, and `hugo-sites/`. It runs the Python
analysis when `uv` is installed; that optional analysis does not decide the
simulation exit status.

## Run the full simulation

The checked-in full scenario uses ten authors and 1,000 consumers. Copy it
before changing the Ollama endpoint or model:

```bash
cp scenario.yaml scenario-local.yaml
# Edit scenario-local.yaml, including ollama.host or ollama.model.
npm start -- scenario-local.yaml
```

For a host-side run, use `http://localhost:11434` as the Ollama host. The
checked-in full scenario uses `host.docker.internal` for Docker-oriented runs.

## Run browser phases in Docker

Use this flow when the host lacks a Playwright browser. Run it from this
repository after `npm ci` and the browser-reference Chromium build:

```bash
docker compose up -d --build --wait
npx tsx src/smoke-test.ts scenario-small.yaml
docker compose run --rm playwright npx tsx src/run-phases-3-5.ts scenario-small.yaml
```

The smoke test creates `results/ground-truth.json`. The second command runs
consumer browsing, researcher reports, post-report visits, and validation.

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
npm start -- scenario-small.yaml
```

Compose also accepts `HTMLTRUST_TRUST_PORT`, `HTMLTRUST_PROXY_PORT`,
`HTMLTRUST_DIRECTORY_BASE_URL`, `WP_DB_ROOT_PASSWORD`, `WP_DB_PASSWORD`,
`HTMLTRUST_GENERAL_API_KEY`, and `HTMLTRUST_ADMIN_API_KEY`. The checked-in
credentials are for local testing only.

## Troubleshooting

- `npm ci` cannot find a browser-client file: build
  `../htmltrust-browser-client` first, then rerun `npm ci` here.
- Docker cannot copy a sibling directory: check the layout and run Compose
  from `htmltrust-e2e`.
- Hugo publication fails: confirm that `hugo version` works on the host.
- Article generation fails: run `curl http://localhost:11434/api/tags`, pull
  `llama3.2:3b`, and check that the scenario's Ollama host is reachable.
- Browser phases cannot resolve author hosts: run them in the Playwright
  service with `docker compose run --rm playwright ...`.
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
