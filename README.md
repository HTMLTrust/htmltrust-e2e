# HTMLTrust end-to-end harness

This repository runs a Docker-backed HTMLTrust simulation. It creates trust-directory records, publishes signed WordPress and Hugo pages, verifies them with Playwright, records votes and reports, and writes a report under `results/`.

The harness is private and expects sibling repositories. Install and run it from the layout below.

## Required checkout layout

Clone these repositories into one parent directory:

```
htmltrust/
├── htmltrust-canonicalization/
├── htmltrust-browser-client/
├── htmltrust-browser-reference/
├── htmltrust-cms-reference/
├── htmltrust-e2e/                 # this repository
└── htmltrust-server-reference/
```

The Docker build reads the canonicalization and server directories from the parent. Compose mounts the WordPress plugin from `htmltrust-cms-reference`. The browser phase mounts `htmltrust-browser-reference/build/chromium`.

## Prerequisites

- Docker Engine with Compose v2
- Node.js 22 and npm
- Hugo on the host, because the publish phase builds generated Hugo sites
- Chromium installed for host-side Playwright runs, or the Playwright image for the split flow below
- Ollama with the configured model for a full simulation

The unit tests, TypeScript build, and browser-extension build do not need Docker, Hugo, or Ollama.

## Setup

Build the local browser-client dependency before installing this repository. Its `dist/` directory is ignored by Git and is needed by the file dependency:

```bash
cd ../htmltrust-browser-client
npm ci
npm run build

cd ../htmltrust-browser-reference
npm ci
npm run build:chromium

cd ../htmltrust-e2e
npm ci
npm test
npm run build
```

The browser-reference build is needed only when running the extension-aware Playwright phase. The E2E package installs canonicalization from `../htmltrust-canonicalization/javascript` and browser-client from `../htmltrust-browser-client`, so keep those paths unchanged.

## Small simulation

The small scenario is the integration smoke test. It uses three authors, five consumers, and a short article set. Start Ollama in another terminal and load the model named by the scenario:

```bash
ollama serve
ollama pull llama3.2:3b
```

Run the complete host-side simulation:

```bash
cd ../htmltrust-e2e
npm start -- scenario-small.yaml
```

The orchestrator builds and starts the Compose stack, runs all five phases, and invokes the optional Python analysis when `uv` is installed. A missing `uv` analysis does not fail the simulation; phase failures do.

## Full simulation

The full scenario uses ten authors and 1,000 consumers. Copy it if you need to change the Ollama endpoint or model:

```bash
cp scenario.yaml scenario-local.yaml
# Edit scenario-local.yaml, including ollama.host or ollama.model.
npm start -- scenario-local.yaml
```

When the orchestrator runs on the host, use `http://localhost:11434` for a host Ollama service. The checked-in full scenario uses `host.docker.internal` for Docker-oriented runs.

## Split Docker and browser run

Use this flow when the host does not have a Playwright browser. It runs setup and publishing from the host, then runs browser phases in the pinned Playwright image.

```bash
docker compose up -d --build --wait
npx tsx src/smoke-test.ts scenario-small.yaml
docker compose run --rm playwright npx tsx src/run-phases-3-5.ts scenario-small.yaml
```

The smoke test creates `results/ground-truth.json`. The second command reads it, runs consumer browsing, researcher reports, post-report visits, and validation. Keep `npm ci` completed first so the mounted `/workspace/node_modules` contains `tsx`, `yaml`, and the E2E dependencies.

## Individual services and checks

Start only the trust directory and MongoDB when working on the API image:

```bash
docker compose up -d --build mongodb trust-server
docker compose logs -f trust-server
```

Start the WordPress database and one site when working on the plugin mount. The harness still needs to run its infrastructure phase to create the author and install the site:

```bash
docker compose up -d --build wp-db wp-1
```

Run the TypeScript checks without any services:

```bash
npm test
npm run build
```

Run the Python result analyzer after a simulation has produced `results/data.json`, `results/session-logs.json`, and `results/ground-truth.json`:

```bash
uv run python analysis/analyze.py results
```

## Configuration

Both scenarios are YAML files. The harness accepts these environment overrides:

```bash
HTMLTRUST_TRUST_SERVER_URL=http://localhost:3000 \
HTMLTRUST_GENERAL_API_KEY=my-general-key \
HTMLTRUST_ADMIN_API_KEY=my-admin-key \
npm start -- scenario-small.yaml
```

Compose also accepts `HTMLTRUST_TRUST_PORT`, `HTMLTRUST_PROXY_PORT`, `HTMLTRUST_DIRECTORY_BASE_URL`, `WP_DB_ROOT_PASSWORD`, `WP_DB_PASSWORD`, and the two API-key variables. The checked-in simulation keys are for local testing only.

## Troubleshooting

- `npm ci` reports a missing browser-client `dist` file: build `../htmltrust-browser-client` first, then rerun `npm ci` here.
- Docker cannot copy a sibling directory: check the layout above and run Compose from this directory.
- Hugo publication fails: install Hugo on the host and confirm `hugo version` works from this shell.
- Article generation fails: check `curl http://localhost:11434/api/tags`, pull the model, and use a scenario whose `ollama.host` is reachable from the process running `npm start`.
- Browser phases fail to resolve author hosts: run them through `docker compose run --rm playwright ...`; Docker DNS provides the `*.htmltrust.test` aliases.
- A previous run left stale databases: remove the simulation volumes with the cleanup command below, then rerun from a clean stack.

Inspect service state and logs with:

```bash
docker compose ps
docker compose logs trust-server nginx wp-1 wp-2 wp-3
```

## Cleanup

The simulation writes ignored output to `results/`, `hugo-sources/`, and `hugo-sites/`. Remove services and their databases after a run:

```bash
docker compose down -v
```

The command removes only this Compose project's containers, network, and named volumes. Rebuild the stack with `docker compose up -d --build --wait` for the next run.
