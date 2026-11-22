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
- `@onstreak/react`: StreakFlame, LevelBar, BadgeGrid, Leaderboard, LeagueTable, AchievementToast, FriendsList, RivalCard, RivalList, QuestList, RewardStore and RewardCalendar, accessible and themeable.
- `npm run demo`: a study app with simulated rivals and time travel, running in memory.
- Friends: mutual friendships with a configurable limit (`friends.max`, default 1000), safe under concurrent requests.
- Friends leaderboards: `scope=friends` ranks a user against their friends, including friends with no points yet.
- Multipliers: time-window boosts ("double XP weekend") and streak bonuses with steps (1.5x from 3 days, 2x from 7). They multiply together, apply to one currency or all, and are listed in track results.
- Quests: daily and weekly goals ("finish 3 lessons", "earn 50 XP") with point rewards paid once on completion. Track results report quest progress; `GET /v1/users/:id/quests` lists progress for the current period. Only events in the running period count.
- Rivalries: configurable head-to-head matchups (`rivalries`, daily or weekly rounds in any time zone). Each rival shows the live score, a win/loss/draw record, the current streak and the last result. Finished rounds are settled once, only count points recorded before the round ended, and rounds where neither side scored are skipped.
- Reward store: configure `items` with a price, an optional per-user limit and metadata. `POST /v1/users/:id/purchases` buys with points, refusing with 409 and a `code` (`insufficient_funds`, `limit_reached`); idempotency keys stop double charges. Users get a `wallet` (spendable balance) and an `inventory`; earned `points` never go down. Purchase history pages with a cursor. Schema migration 8.
- Refunds: `POST /v1/users/:id/purchases/:purchaseId/refund` gives the price back to the wallet and takes the items out of the inventory, in part or in full. Purchases show how many were `refunded`. Schema migration 13.
- Using items: `POST /v1/users/:id/inventory/:itemId/use` takes owned items from the inventory and applies their `effect`. A `streakFreeze` effect adds a freeze to a streak, up to its `freezes.max`, and is refused once the streak has lapsed. Retries with an idempotency key return the first result. Schema migration 9.
- Scoped API keys: `ONSTREAK_API_KEYS` adds keys with a `read`, `write` or `admin` scope (`ONSTREAK_API_KEY` is admin). Read keys only GET; admin-only routes (delete and export users, reverse events, revoke achievements, config preview, webhook log) answer 403 to other keys. Several keys at once allow rotation without downtime.
- Rate limiting and CORS: `ONSTREAK_RATE_LIMIT_PER_MINUTE` limits each client with a token bucket (429 and `retry-after`; health checks exempt; `ONSTREAK_TRUST_PROXY` to key on `x-forwarded-for`), and `ONSTREAK_CORS_ORIGINS` allows browser origins with proper preflight answers.
- GDPR tools: `GET /v1/users/:id/export` returns everything stored about a user, and `DELETE /v1/users/:id` erases them from every table (friendships, rivalries and referrals on both sides).
- Built-in scheduler: the server runs jobs every minute with no outside cron. Streaks with `remindBeforeHours` send a `streak.at_risk` webhook once per user per period, and seasons send `season.ended` once with their top 3. Several servers can run it together. Schema migration 23.
- Webhooks: `webhooks` config sends signed POSTs for level-ups, unlocks, streaks extended or broken, completed quests and settled league rounds. Deliveries are queued in the event's transaction (an outbox) and sent in the background with retries and backoff; concurrent servers never send one twice. `GET /v1/webhooks/deliveries` is the delivery log, and `verifyWebhookSignature` checks signatures on the receiving side. Schema migration 22.
- Config preview: `POST /v1/config/preview` checks a candidate config against every user without changing anything, reporting level moves (up, down, same) and, per achievement or tier, who would unlock it on their next event or no longer qualify.
- League finish rewards: `rewards: [{ top: 1, rewards }, { top: 3, rewards }]` on a league pays each member's best tier once, when their round settles. The rewards are dated in the finished round so they never count toward the next one, and `previous.rewards` shows what was paid.
- Corrections: `POST /v1/users/:id/events/:eventId/reverse` takes back the points an event awarded (rewards included), dated at the event's time so leaderboard windows and league rounds correct themselves, and undoes its metric count; event history shows `reversedAt`. `DELETE /v1/users/:id/achievements/:id` revokes an achievement or one tier. Schema migration 21.
- Translated names: achievements, tiers, quests, items and calendars take `translations` by locale, and the user, achievements, quests, store and calendar routes take `?locale=` (exact locale, then language, then the default).
- Prestige: with `levels.prestige`, a user at the top level can start over at level 1 with a higher prestige rank (`POST /v1/users/:id/prestige`), optionally for rewards. Earned points are kept; levels count from the prestige. Users show `level.prestige`. Schema migration 20.
- Streaks at risk: `GET /v1/streaks/:id/at-risk` lists users with a streak going who have not acted this period, with when their period ends (their own time zone), freezes left and whether missing it breaks the streak. Days off with `skipWeekends` are left out.
- Leaderboard views: `around=N` shows the places around a user, `segment=key:value` ranks only users whose profile metadata matches, and `GET /v1/leaderboards/:id/history` lists past windows' winners as they stood when each closed.
- Level curves and rewards: `levels.curve` generates thresholds (linear, or exponential with a growth factor) instead of listing them, and `levels.rewards` pays points on reaching a level. Track results list what new levels paid.
- Event properties: events can carry `properties` (up to 20 strings, numbers or booleans), stored and returned in event history. Point rules, streaks and quest event goals filter on them with `where` (equal, `in`, `gte`, `lte`), and point rules can `multiplyBy` a numeric property. Schema migration 19.
- Compound and time-window achievement conditions: `within: "day" | "week" | "month"` counts only the current period in the user's time zone, and `all` / `any` combine conditions (nested up to 3 levels). Progress counts the parts met.
- `BadgeGrid` takes `achievements` (from `sdk.achievements`) to show each badge's tier, a progress bar toward the next level, and secret placeholders. With `unlocked`, a tiered badge shows once at its highest tier.
- Achievement upgrades: tiered badges (`tiers: [{ name, gte, rewards? }]`, unlocked one tier at a time), hidden achievements, and rewards paid on unlock. `GET /v1/users/:id/achievements` lists every achievement with progress toward the next level. Track results and users show which tier unlocked.
- League season resets: `seasonReset: true` on a league moves everyone back to the first tier when a configured season starts; `{ dropTiers: n }` is a soft reset.
- Team goals: `teamGoals` config sets daily or weekly goals a team reaches together, from current members' events or points since they joined. `GET /v1/teams/:id/goals` shows progress and contributions; contributors are paid once per period, the first time they look after it is reached. Schema migration 18.
- Teams: create teams and add members through the API (one team per user, `teams.maxMembers` per team, safe under concurrent joins). Teams rank on any leaderboard by their members' points, each counted from when they joined, so switching teams does not carry points over. Schema migration 17.
- Monthly streaks (`period: "monthly"`, calendar months in the user's zone) and `weekStartsOn` for weekly streaks. Freezes, minimums and repair work the same way.
- Missions: a quest can list `goals` (2 to 10) instead of one `goal`; it completes when all are reached in the same period. Track results and the quest list show each goal's progress, and `QuestList` lists them.
- One-off quests and quest chains: `period: "once"` quests never reset, and `after` keeps a quest locked until a one-off quest is completed. The event that completes a link does not count toward the next one.
- Seasons: `seasons` config defines named date ranges with their own standings in one currency and rank-based reward tiers. `GET /v1/seasons/:id/standings` is live while a season runs and fixed once it ends; `GET /v1/seasons?userId=` shows a user's rank and pays their best tier once after the end. Schema migration 16.
- Richer streak rules: `minimum` (a period counts once the event's values reach it, with `progress` shown in track results and on users) and `skipWeekends` for daily streaks (weekends are never missed; weekend activity still counts). Schema migration 15.
- Streak repair: streaks with a `repair` rule can be repaired within `withinHours` of breaking, optionally for a price from the wallet (`POST /v1/users/:id/streaks/:streakId/repair`). Broken streaks show `repairableUntil` while the window is open.
- Limited-time quests: quests take optional `from` and `to` dates for seasonal challenges. Outside the window they are not listed and events do not count; listed quests show `until`.
- Community goals: `communityGoals` config sets a target everyone works toward in a time window, on an event total or points earned. `GET /v1/community-goals` shows progress; contributors above `minContribution` are paid the rewards once, the first time they look after it is reached (even after the window ends). Schema migration 14 (also indexes events by key and time).
- Referral rewards: `PUT /v1/users/:id/referred-by/:referrerId` records who brought a user in, and `referrals` config pays both sides once the new user qualifies (`qualify: { event, target }`, or at once). `max` caps rewarded referrals per user. The referrer is paid in their own transaction right after, and any payout a crash interrupted is made on the next `GET /v1/users/:id/referrals`. Track results show a `referral` when an event qualified one. Schema migration 12.
- Login reward calendars: configure `calendars` ("day 1: 5 coins ... day 7: 50 coins"). The first matching event each day claims the next day; missing a day resets unless `missed: "continue"`, and after the last day it repeats or stays. Track results report claims in `calendars`, and `GET /v1/users/:id/calendars` shows each day as claimed, today or upcoming. Days follow the user's time zone. Schema migration 11.
- Personal boosts: `POST /v1/users/:id/boosts` gives one user a multiplier for some minutes ("2x XP for an hour"), and items can carry a `boost` effect. Boosts apply to events that happen while they run, never reach back to earlier events, and show in track results' `multipliers` as `boost:<id>`. Granting the same factor and currency again queues it after the current one. Users list their running and queued `boosts`. Schema migration 10.
- Error bodies carry a stable `code` where there is one, and the SDK's `OnstreakError` exposes it.
- Docker image (non-root, with health check) and docker compose setup.

### Fixed

- Points backfilled after a league round ended no longer change that round's result.
