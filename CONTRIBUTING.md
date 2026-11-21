# Contributing to onstreak

Thanks for helping. Bug reports, docs fixes and features are all welcome.

## Set up

```bash
git clone https://github.com/imnottaken/onstreak && cd onstreak
npm install
npm test          # builds everything, runs every test (real-Postgres tests skip)
npm run demo      # http://localhost:3000
```

Node 20 or newer. The repo is an npm workspace:

| Folder | What |
| --- | --- |
| `packages/engine` | Engine, stores, HTTP server, CLI (`@onstreak/engine`) |
| `packages/sdk` | HTTP client (`@onstreak/sdk`) |
| `packages/react` | React components (`@onstreak/react`) |
| `examples/demo` | The demo app |
| `scripts` | Local Postgres helper, Docker smoke test, release check |

## Tests

Every change needs tests. Run the full suite against a real Postgres before opening a pull request when you touch the stores, SQL or migrations:

```bash
brew install postgresql@16   # once, on macOS
npm run test:pg              # starts Postgres if needed, runs everything, stops it
```

Or point at any Postgres: `TEST_DATABASE_URL=postgres://... npm test`. CI runs both on Node 20 and 22, plus a Docker smoke test.

Behaviour suites run against every store (memory, PGlite, real Postgres) through `storeFactories` in `packages/engine/test/helpers.mjs`, so new store features get tested everywhere for free.

## Changing the database schema

Add a migration to the end of `packages/engine/src/store/migrations.ts` with the next version number. Never edit or reorder a shipped migration, and use the `t.<table>` names so table prefixes keep working. The migration tests check fresh databases, upgrades from 0.1 and concurrent starts.

## Changing the HTTP API

Update `packages/engine/src/openapi.ts` and the SDK in `packages/sdk`. The contract test drives every documented operation and checks real responses against the spec, so it fails if the two disagree.

## Pull requests

- One change per pull request, with tests.
- Add a line under `[Unreleased]` in `CHANGELOG.md` for anything users will notice.
- Keep messages and docs in plain words.

## Security

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
