# onstreak

[![ci](https://github.com/imnottaken/onstreak/actions/workflows/ci.yml/badge.svg)](https://github.com/imnottaken/onstreak/actions/workflows/ci.yml)

Open-source gamification engine. Add **points, levels, streaks, achievements, leaderboards and Duolingo-style leagues** to any app with one API call, on your own Postgres. MIT licensed.

```ts
import { createClient } from "@onstreak/sdk";

const xp = createClient({ baseUrl: "http://localhost:8787", apiKey: process.env.ONSTREAK_API_KEY! });

const result = await xp.track({ userId: "asha", event: "lesson_completed", timezone: "Asia/Kolkata" });
// result.points       -> { xp: { awarded: 10, total: 110 } }
// result.streaks      -> { daily_lesson: { current: 7, extended: true, freezesUsed: 0, ... } }
// result.achievements -> [{ id: "streak_7", name: "Week warrior" }]
// result.level        -> { current: 4, previous: 3, leveledUp: true }
// result.leagues      -> { weekly_league: { tier: "silver", group: 3, joined: false, previous: null } }
```

## Why

- **Streaks done right.** Days follow each user's own time zone, daylight saving included. Freezes cover missed days, and users can earn more. Late or replayed events never rewrite a streak.
- **Your database.** Runs on any Postgres (Supabase, Neon, RDS) or fully in memory for tests. No vendor holds your users' data.
- **Safe retries.** Send an `idempotencyKey` and a retried request returns the first result instead of awarding points twice. Events for one user are applied in order, even under concurrency.
- **Leagues, not just leaderboards.** Each round, players who earn points are seated in small groups within their tier. When the round ends the top of each group moves up and the bottom moves down. No cron job: a user's last round is settled the next time they show up.
- **MIT, not AGPL.** Use it in closed-source products without legal review.

## Try the demo

```bash
npm install && npm run build && npm run demo   # http://localhost:3000
```

A tiny study app with simulated players: finish lessons, press **Next day** to build a streak, **Skip a week** to see the league and your weekly duels settle, challenge friends to a duel, and complete daily quests, check in daily for rewards, and spend coins in the shop. Runs in memory, no database or keys. The source in [examples/demo](examples/demo/server.mjs) shows the engine and the React components working together.

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

## Command line

```bash
onstreak            # start the server (same as: onstreak serve)
onstreak check      # validate the config, and the database if DATABASE_URL is set
onstreak migrate    # bring the database schema up to date, then exit
```

The server migrates the schema on start. Set `ONSTREAK_AUTO_MIGRATE=false` to make it refuse to start with pending migrations instead, and run `onstreak migrate` as a separate deploy step.

| Setting | Default | |
| --- | --- | --- |
| `ONSTREAK_CONFIG` | `./onstreak.config.json` | Config file |
| `ONSTREAK_API_KEY` | (required) | Secret for `Authorization: Bearer`, at least 16 characters |
| `DATABASE_URL` | in-memory store | Postgres connection string |
| `ONSTREAK_DB_SCHEMA` | connection default | Postgres schema for onstreak's tables, created if missing |
| `ONSTREAK_TABLE_PREFIX` | `onstreak_` | Prefix for table names, to share a database |
| `ONSTREAK_AUTO_MIGRATE` | `true` | `false` to require `onstreak migrate` first |
| `PORT` | `8787` | HTTP port |
| `ONSTREAK_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ONSTREAK_LOG_FORMAT` | `json` | `pretty` for readable local logs |
| `ONSTREAK_SHUTDOWN_TIMEOUT_MS` | `10000` | How long requests may finish on SIGTERM |

## Configure

Everything is declared in one JSON file. See [examples/onstreak.config.json](examples/onstreak.config.json).

| Section | What it does |
| --- | --- |
| `currencies` | Point types, e.g. `xp`, `coins` |
| `points` | Which event awards how much: `{ event, currency, amount, multiplyByValue?, multiplyBy?, where? }`. `where` filters on event properties (`{ difficulty: "hard", score: { gte: 80 }, subject: { in: ["math"] } }`); `multiplyBy` multiplies by a numeric property. Streaks and quest event goals take `where` too |
| `levels` | `{ currency, thresholds \| curve, rewards? }`. `thresholds` lists the points for level 2, 3, ...; or `curve: { type: "linear", step }` / `{ type: "exponential", base, factor }` (with `maxLevel?`, default 100) generates them. `rewards: [{ level, rewards }]` pays on reaching a level. `prestige: { rewards? }` lets users at the top level start over with a prestige rank |
| `streaks` | `{ id, event, period: daily \| weekly \| monthly, weekStartsOn?, freezes?: { start, max, earnEvery }, repair?: { withinHours, cost?: { currency, amount } }, minimum?, skipWeekends? }`. `minimum` makes a period count only once the event's values add up to it ("3 lessons a day"); users see `progress`. `skipWeekends` (daily) never counts Saturday or Sunday as missed. Monthly streaks count calendar months; `weekStartsOn` (e.g. `"sunday"`) sets where weekly streaks' weeks begin. With `repair`, a broken streak can be repaired within `withinHours` of breaking (before a new one starts), paid from the wallet |
| `achievements` | `{ id, name, description?, when: { metric \| streak \| points, gte }, rewards?, hidden? }`: unlock when the value reaches `gte`. `tiers: [{ name, gte, rewards? }]` (instead of `gte`) makes a tiered badge (bronze, silver, gold) unlocked tier by tier. `hidden` keeps it secret until unlocked; `rewards` are paid on unlock. A metric or points value can take `within: day \| week \| month` ("5 lessons in one day", "100 XP this week", in the user's zone), and `when: { all: [...] }` or `{ any: [...] }` combines conditions |
| `leaderboards` | `{ id, currency, period: daily \| weekly \| monthly \| all, timezone? }` |
| `leagues` | `{ id, currency, tiers, groupSize?, promote?, demote?, period?, timezone? }` (defaults: 30 per group, 7 up, 5 down, weekly). `seasonReset: true` (or `{ dropTiers }`) moves everyone back to the first tier (or down that many) when a season starts |
| `rivalries` | `{ id, currency, period?, timezone?, max? }` (defaults: weekly, UTC, 10 rivals each) |
| `quests` | `{ id, name, description?, period: daily \| weekly \| once, after?, goal: { event, target } \| { points, target }, rewards?: [{ currency, amount }], timezone?, from?, to? }`. Days start in each user's zone unless the quest sets one. `from`/`to` (ISO dates) make it a limited-time quest. `goals: [...]` (instead of `goal`) makes a mission that needs every goal done in the same period. `once` quests never reset; `after: <once quest>` keeps a quest locked (and out of the list) until that one is done, for chains |
| `calendars` | `{ id, name?, event, days: [{ rewards: [{ currency, amount }] }], missed?: reset \| continue, afterLast?: repeat \| stay, timezone? }`: login rewards. The first `event` each day claims the next day's rewards; a missed day starts over unless `missed` is `continue` |
| `referrals` | `{ referrer?: [{ currency, amount }], referred?: [...], qualify?: { event, target }, max? }`. Both sides are paid once the new user has done `target` of `event` (at once without `qualify`); `max` caps how many referrals one user is rewarded for |
| `teams` | `{ maxMembers? }` (default 50). Teams are created through the API; a user is in one team at a time |
| `teamGoals` | `{ id, name, description?, period: daily \| weekly, goal: { event, target } \| { points, target }, rewards?, timezone? }`: goals a team reaches together, from current members' activity since they joined |
| `seasons` | `{ id, name, currency, from, to, rewards?: [{ top, title?, rewards: [{ currency, amount }] }] }`: named stretches with their own standings. When one ends its standings are fixed, and each user gets the best reward tier their rank reaches |
| `communityGoals` | `{ id, name, description?, goal: { event, target } \| { points, target }, from, to, rewards?, minContribution? }`: everyone together ("1M minutes this month"). Contributors who gave at least `minContribution` share the rewards once it is reached |
| `items` | `{ id, name, description?, price: { currency, amount }, limit?, metadata?, effect? }`: things users can buy with points. `limit` caps how many one user can own. `effect: { streakFreeze: <streak id> }` makes using one add a freeze to that streak, and `effect: { boost: { factor, minutes, currency? } }` gives a personal boost; items without an effect are just taken from the inventory when used |
| `multipliers` | `{ id, currency?, factor, from, to }` for a time window ("double XP weekend"), or `{ id, currency?, streak, steps: [{ gte, factor }] }` for a streak bonus. They scale points from point rules (not quest rewards) and multiply together; track results list the ones applied |
| `friends` | `{ max? }` (default 1000) |

Mistakes (unknown currency, duplicate ids, a typo in a time zone) fail at startup with a clear message.

## HTTP API

All `/v1` routes need `Authorization: Bearer <ONSTREAK_API_KEY>`. Every response carries an `x-request-id` header (send your own to correlate logs), and error bodies include it.

| Route | |
| --- | --- |
| `POST /v1/events` | Track an event: `{ userId, event, value?, timestamp?, timezone?, idempotencyKey?, properties? }`. `properties` are up to 20 strings, numbers or booleans that rules can filter on |
| `POST /v1/events/batch` | Track up to 100 events in order: `{ events: [...] }`. Bad items are reported in place |
| `GET /v1/users/:id?timezone=` | Profile, points, level, metrics, streak status (`done`, `pending`, `broken`) and achievements |
| `PATCH /v1/users/:id` | Set `displayName`, `avatarUrl`, `metadata` (JSON, max 8 KB) or `timezone`. `null` clears a field |
| `GET /v1/users/:id/events?limit=&cursor=` | The user's events, newest first, with what each one awarded |
| `GET /v1/users/:id/quests?timezone=` | Every quest for the current day or week with the user's progress, completion time and when it resets |
| `POST /v1/users/:id/streaks/:streakId/repair` | Repair a recently broken streak; it resumes as if yesterday was done. While repairable, the user's streak shows `repairableUntil`. 409 `not_broken`, `repair_expired` or `insufficient_funds` |
| `GET /v1/users/:id/store` | The reward store for this user: spendable balances, every item with its price, how many they own and whether they can buy one |
| `POST /v1/users/:id/purchases` | Buy an item: `{ item, quantity?, idempotencyKey? }`. 409 with `code: "insufficient_funds"` or `"limit_reached"` when refused |
| `GET /v1/users/:id/purchases?limit=&cursor=` | The user's purchases, newest first, with how many were refunded |
| `POST /v1/users/:id/purchases/:purchaseId/refund` | Refund some or all of a purchase: `{ quantity? }`. The price goes back to the wallet and the items leave the inventory. 409 `not_owned` if they were used, `already_refunded` when nothing is left |
| `POST /v1/users/:id/boosts` | Give one user a multiplier for a while: `{ factor, minutes, currency?, reason?, idempotencyKey? }`. The same factor and currency queue back to back instead of stacking; different ones multiply. Running and queued boosts show on the user |
| `POST /v1/users/:id/inventory/:itemId/use` | Use owned items: `{ quantity?, idempotencyKey? }`. Applies the item's effect. 409 with `code` `not_owned`, `limit_reached` (freezes at their max) or `streak_broken` (a freeze cannot revive a lapsed streak) |
| `GET /v1/users/:id/calendars?timezone=` | Each login reward calendar: which days are claimed, what today pays, and when the next day opens. Track the calendar's event to claim |
| `PUT /v1/users/:id/referred-by/:referrerId` | Record who referred a user, once (same referrer again is a no-op; another is 409 `already_referred`). Pays both sides when the user qualifies |
| `GET /v1/users/:id/referrals` | Who referred the user, everyone they referred, which qualified and which were rewarded |
| `PUT /v1/users/:id/friends/:friendId` | Make two users friends (mutual, safe to repeat). 409 past the friend limit |
| `DELETE /v1/users/:id/friends/:friendId` | End a friendship for both users |
| `GET /v1/users/:id/friends` | A user's friends, newest first, with names and avatars |
| `PUT /v1/rivalries/:id/users/:userId/rivals/:rivalId` | Start a head-to-head rivalry (mutual, safe to repeat). 409 past the rivalry's `max` |
| `DELETE /v1/rivalries/:id/users/:userId/rivals/:rivalId` | End a rivalry and drop its record |
| `GET /v1/rivalries/:id/users/:userId` | Each rival's live score this round, win/loss/draw record, current streak and last result |
| `GET /v1/leaderboards/:id?limit=&userId=&scope=` | Top entries for the current window with names and avatars, plus that user's own rank. `scope=friends` ranks only the user and their friends, zeros included. `around=N` (with `userId`) returns the places around the user instead of the top; `segment=country:IN` ranks only users whose profile metadata matches |
| `GET /v1/streaks/:id/at-risk?limit=&endingWithinHours=&cursor=` | Users whose streak is going but who have not done this period's activity yet, with when their period ends in their own time zone and whether it is their last chance. For reminders |
| `GET /v1/leaderboards/:id/history?periods=&top=` | Winners of past windows, newest first, fixed as they stood when each window closed |
| `PUT /v1/teams/:teamId` | Create a team or rename it: `{ name }` |
| `GET /v1/teams/:teamId?leaderboard=` | A team and its members; with a leaderboard id, each member's points for the team and the team's rank |
| `PUT /v1/teams/:teamId/members/:userId` | Put a user in a team. 409 `already_in_team` (one team at a time) or `team_full`. Points count for the team from when they join |
| `DELETE /v1/teams/:teamId/members/:userId` | Take a user out; their points stop counting for the team |
| `GET /v1/teams/:teamId/goals?userId=` | The team's goals this day or week with progress and each member's contribution. A member who contributed is paid the rewards the first time they look after a goal is reached |
| `POST /v1/users/:id/prestige` | At the top level: start levels over with the prestige rank one higher (earned points are kept). 409 `not_max_level` before then |
| `GET /v1/users/:id/achievements` | Every achievement with the user's progress toward the next level (`current`, `target`, `percent`) and each tier's unlock time. Hidden ones have no name or progress until unlocked |
| `GET /v1/users/:id/team` | The team a user is in, or null |
| `GET /v1/leaderboards/:id/teams?limit=&teamId=` | Teams ranked by their members' points in the leaderboard's window |
| `GET /v1/seasons?userId=` | Every season with its status; with `userId`, that user's score, rank and award. After a season ends, the award is paid the first time the user looks |
| `GET /v1/seasons/:id/standings?limit=&userId=` | A season's ranking with names: live while it runs, `final` and fixed once it ends (late backfilled points do not change it) |
| `GET /v1/community-goals?userId=` | Every community goal with everyone's progress and its status (upcoming, active, ended). With `userId`, that user's contribution; an eligible user is paid the rewards the first time they look after the goal is reached |
| `GET /v1/leagues/:id/users/:userId` | The user's tier, their group's live standings with promotion and demotion zones, and how last round ended |
| `GET /health` | Ready: the process and the database are up (503 otherwise). No key needed |
| `GET /health/live` | Alive: the process is up. No key needed |
| `GET /openapi.json` | OpenAPI 3.1 description of this API. No key needed |

Achievements (and their tiers), quests, items and calendars take `translations: { es: { name, description }, "pt-BR": { ... } }`. `GET` routes for users, achievements, quests, the store and calendars take `?locale=`, falling back from `pt-BR` to `pt` to the default text.

A time zone sent with an event is remembered for that user, so later events and `GET /v1/users/:id` use it when none is given.

Spending never lowers earned points. `points` on a user is what they earned (levels, achievements, leaderboards and leagues use it), and `wallet` is what is left to spend: earned minus spent. Purchases are checked and recorded inside the user's lock, so concurrent requests can never overspend.

The full machine-readable description is served at `GET /openapi.json` (OpenAPI 3.1, no key needed), so you can generate a client for any language. Tests check every response against it, so it stays accurate.

The SDK mirrors these: `track`, `trackBatch`, `getUser`, `updateUser`, `events`, `addFriend`, `removeFriend`, `friends`, `addRival`, `removeRival`, `rivals`, `quests`, `calendars`, `communityGoals`, `seasons`, `seasonStandings`, `achievements`, `prestige`, `saveTeam`, `team`, `addTeamMember`, `removeTeamMember`, `userTeam`, `teamLeaderboard`, `teamGoals`, `addReferral`, `referrals`, `store`, `purchase`, `purchases`, `useItem`, `refundPurchase`, `repairStreak`, `grantBoost`, `leaderboard`, `leaderboardHistory`, `streaksAtRisk`, `league` and `health`. Errors are `OnstreakError` with `status`, `requestId` and, when the server gives one, `code`.

## React components

`@onstreak/react` has ready-made, accessible components: `StreakFlame`, `LevelBar`, `BadgeGrid`, `Leaderboard`, `LeagueTable` (with a live countdown), `AchievementToast`, `FriendsList`, `RivalCard` / `RivalList` for head-to-head duels, `QuestList`, `RewardStore` with prices, owned counts and your own buy buttons, and `RewardCalendar` for daily check-ins. They take the SDK's data as props, so fetch on your server and pass it down. Never send the API key to a browser.

```tsx
// Next.js server component
import { createClient } from "@onstreak/sdk";
import { StreakFlame, LevelBar, Leaderboard } from "@onstreak/react";
import "@onstreak/react/styles.css"; // optional; theme with --os-* variables

const onstreak = createClient({ baseUrl: process.env.ONSTREAK_URL!, apiKey: process.env.ONSTREAK_API_KEY! });

export default async function Progress({ userId }: { userId: string }) {
  const [user, board] = await Promise.all([onstreak.getUser(userId), onstreak.leaderboard("xp_weekly", { userId })]);
  return (
    <>
      <StreakFlame streak={user.streaks.daily_lesson} />
      {user.level && <LevelBar level={user.level} />}
      <Leaderboard board={board} currentUserId={userId} title="This week" />
    </>
  );
}
```

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
npm test   # builds, then runs the suite against the memory store and embedded Postgres (PGlite)

# Also run against a real Postgres server, including parallel-connection and
# server-restart tests (each test gets its own schema and cleans up after itself).
# macOS with Homebrew: one-time `brew install postgresql@16`, then
npm run test:pg   # starts Postgres if needed, runs everything, stops it again

# Any other Postgres (Docker, remote):
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

CI runs both, against Postgres 16.

## Releasing

`@onstreak/engine`, `@onstreak/sdk` and `@onstreak/react` share one version.

1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new `## [x.y.z]` heading.
2. Set `"version": "x.y.z"` in both `packages/*/package.json`.
3. Commit, then `git tag vx.y.z && git push --tags`.

The release workflow runs every test against real Postgres, checks the packages (`npm run release:check`, which also runs in CI on every push), publishes both to npm with provenance, and creates a GitHub release from the changelog. It needs an `NPM_TOKEN` repository secret. Run the workflow by hand for a dry run that publishes nothing.

## Roadmap

- Time-limited events and seasons
- Webhooks for level-ups and unlocks
- Admin dashboard
- Spending currencies (reward store)

## License

MIT
