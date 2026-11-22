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
- `level.startsAt` on user profiles, so progress bars know where the current level began.
- `@onstreak/react`: StreakFlame, LevelBar, BadgeGrid, Leaderboard, LeagueTable, AchievementToast, FriendsList, RivalCard, RivalList, QuestList and RewardStore, accessible and themeable.
- `npm run demo`: a study app with simulated rivals and time travel, running in memory.
- Friends: mutual friendships with a configurable limit (`friends.max`, default 1000), safe under concurrent requests.
- Friends leaderboards: `scope=friends` ranks a user against their friends, including friends with no points yet.
- Multipliers: time-window boosts ("double XP weekend") and streak bonuses with steps (1.5x from 3 days, 2x from 7). They multiply together, apply to one currency or all, and are listed in track results.
- Quests: daily and weekly goals ("finish 3 lessons", "earn 50 XP") with point rewards paid once on completion. Track results report quest progress; `GET /v1/users/:id/quests` lists progress for the current period. Only events in the running period count.
- Rivalries: configurable head-to-head matchups (`rivalries`, daily or weekly rounds in any time zone). Each rival shows the live score, a win/loss/draw record, the current streak and the last result. Finished rounds are settled once, only count points recorded before the round ended, and rounds where neither side scored are skipped.
- Reward store: configure `items` with a price, an optional per-user limit and metadata. `POST /v1/users/:id/purchases` buys with points, refusing with 409 and a `code` (`insufficient_funds`, `limit_reached`); idempotency keys stop double charges. Users get a `wallet` (spendable balance) and an `inventory`; earned `points` never go down. Purchase history pages with a cursor. Schema migration 8.
- Error bodies carry a stable `code` where there is one, and the SDK's `OnstreakError` exposes it.
- Docker image (non-root, with health check) and docker compose setup.

### Fixed

- Points backfilled after a league round ended no longer change that round's result.
