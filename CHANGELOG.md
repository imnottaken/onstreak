# Changelog

All notable changes to onstreak. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). `@onstreak/engine` and `@onstreak/sdk` are released together with the same version.

## [Unreleased]

### Added

- Engine: points in several currencies, levels, streaks in each user's time zone with freezes, achievements, leaderboards (daily, weekly, monthly, all-time).
- Duolingo-style leagues: tiers, groups, promotion and demotion, settled lazily without a cron job.
- Idempotency keys and ordered per-user writes.
- Postgres and in-memory stores; versioned schema migrations; table prefixes and schemas.
- User profiles (display name, avatar, metadata, time zone), shown on leaderboards and leagues. Time zones sent with events are remembered.
- Event history with cursor paging, and batch tracking of up to 100 events.
- HTTP server with API key auth, request IDs, structured JSON logs, database health check, and graceful shutdown.
- `onstreak check` and `onstreak migrate` commands.
- TypeScript SDK covering every route.
- OpenAPI 3.1 description at `GET /openapi.json`, checked against real responses in tests.
- Docker image (non-root, with health check) and docker compose setup.

### Fixed

- Points backfilled after a league round ended no longer change that round's result.
