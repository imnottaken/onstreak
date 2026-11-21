# onstreak

Open-source gamification engine. Add **points, levels, streaks, achievements and leaderboards** to any app with one API call, on your own Postgres. MIT licensed.

```ts
import { createClient } from "@onstreak/sdk";

const xp = createClient({ baseUrl: "http://localhost:8787", apiKey: process.env.ONSTREAK_API_KEY! });

const result = await xp.track({ userId: "asha", event: "lesson_completed", timezone: "Asia/Kolkata" });
// result.points       -> { xp: { awarded: 10, total: 110 } }
// result.streaks      -> { daily_lesson: { current: 7, extended: true, freezesUsed: 0, ... } }
// result.achievements -> [{ id: "streak_7", name: "Week warrior" }]
// result.level        -> { current: 4, previous: 3, leveledUp: true }
```

## Why

- **Streaks done right.** Days follow each user's own time zone, daylight saving included. Freezes cover missed days, and users can earn more. Late or replayed events never rewrite a streak.
- **Your database.** Runs on any Postgres (Supabase, Neon, RDS) or fully in memory for tests. No vendor holds your users' data.
- **Safe retries.** Send an `idempotencyKey` and a retried request returns the first result instead of awarding points twice. Events for one user are applied in order, even under concurrency.
- **MIT, not AGPL.** Use it in closed-source products without legal review.

## Quick start

```bash
npm install
npm run build
ONSTREAK_API_KEY=change-me-to-a-long-secret ONSTREAK_CONFIG=examples/onstreak.config.json npm start
```

Without `DATABASE_URL` the server uses an in-memory store. To use Postgres:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db ONSTREAK_API_KEY=... ONSTREAK_CONFIG=examples/onstreak.config.json npm start
```

Tables (prefixed `onstreak_`) are created on start. With Docker: `docker compose up`.

## Configure

Everything is declared in one JSON file. See [examples/onstreak.config.json](examples/onstreak.config.json).

| Section | What it does |
| --- | --- |
| `currencies` | Point types, e.g. `xp`, `coins` |
| `points` | Which event awards how much: `{ event, currency, amount, multiplyByValue? }` |
| `levels` | Level thresholds for one currency |
| `streaks` | `{ id, event, period: daily \| weekly, freezes?: { start, max, earnEvery } }` |
| `achievements` | Unlock when a metric, streak or point total reaches `gte` |
| `leaderboards` | `{ id, currency, period: daily \| weekly \| monthly \| all, timezone? }` |

Mistakes (unknown currency, duplicate ids, a typo in a time zone) fail at startup with a clear message.

## HTTP API

All routes except `/health` need `Authorization: Bearer <ONSTREAK_API_KEY>`.

| Route | |
| --- | --- |
| `POST /v1/events` | Track an event: `{ userId, event, value?, timestamp?, timezone?, idempotencyKey? }` |
| `GET /v1/users/:id?timezone=` | Points, level, metrics, streak status (`done`, `pending`, `broken`) and achievements |
| `GET /v1/leaderboards/:id?limit=&userId=` | Top entries for the current window, plus that user's own rank |
| `GET /health` | Liveness check |

## Use as a library

```ts
import { Engine, PostgresStore, fromPgPool } from "@onstreak/engine";
import pg from "pg";

const store = new PostgresStore(fromPgPool(new pg.Pool({ connectionString: process.env.DATABASE_URL })));
await store.migrate();
const engine = new Engine(config, store);
await engine.track({ userId: "asha", event: "lesson_completed" });
```

## Develop

```bash
npm test   # builds, then runs the suite against the memory store and real Postgres (PGlite)
```

## Roadmap

- Leagues with promotion and relegation, and friend rivalries
- Quests and time-limited challenges
- Webhooks for level-ups and unlocks
- Admin dashboard
- React components for streaks, badges and leaderboards
- Spending currencies (reward store)

## License

MIT
