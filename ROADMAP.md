# onstreak roadmap

The long list. Sizes are rough: **S** = an evening or two, **M** = about a week, **L** = several weeks.
Phases are an order to work in, not a promise. Tick things off as they ship.

## Done

- [x] Points with multiple currencies, levels
- [x] Streaks in each user's time zone, with freezes and earning freezes back
- [x] Achievements on totals, streaks and point balances
- [x] Leaderboards: daily, weekly, monthly, all-time, with the caller's own rank
- [x] Duolingo-style leagues: tiers, groups, promotion and demotion, settled lazily
- [x] Idempotency keys, ordered per-user writes
- [x] Postgres and in-memory stores, HTTP server, TypeScript SDK
- [x] CI on Node 20 and 22 against real Postgres 16; `npm run test:pg` locally
- [x] **Phase 1 complete** (all items below)

---

## Phase 1: Foundation (before telling anyone)

Things that would hurt early users if they were missing.

- [x] **Versioned schema migrations** (M). Today tables are only created if missing, so any schema change breaks existing installs. Needs numbered migrations and a migrations table.
- [x] **Docker verified in CI** (S). Build the image, start the compose stack, send a real event.
- [x] **Health check that checks the database** (S). `/health` returns OK even when Postgres is down.
- [x] **Graceful shutdown** (S). Finish in-flight requests and close the pool on SIGTERM.
- [x] **Structured logs with request IDs** (S).
- [x] **`onstreak check` command** (S). Validate a config file without starting the server.
- [x] **Configurable table prefix or schema** (S). Lets onstreak share a database cleanly.
- [x] **Fix backdated events changing past league rounds** (S). Late points can shift standings for people whose round is not settled yet.
- [x] **User profiles: display name, avatar, metadata** (S). Leaderboards return only user IDs today, so every app has to join names itself.
- [x] **Store each user's time zone** (S). So clients do not have to send it on every event.
- [x] **Event history endpoint** (S). A user's recent events and what each one awarded.
- [x] **Batch events endpoint** (S). Send many events in one request.
- [x] **Release basics** (S). Version tags, a CHANGELOG, npm publish from CI with provenance.

## Phase 2: Launch kit (what gets stars)

- [x] **Live demo app** (M). `npm run demo`: a study app with simulated rivals and a next-day button, in memory.
- [ ] **Demo GIF** (S). Record the demo for the README and Twitter; host the demo publicly.
- [x] **React components** (L). `StreakFlame`, `LevelBar`, `BadgeGrid`, `Leaderboard`, `LeagueTable`, `AchievementToast`, unstyled and themeable.
- [ ] **React hooks** (M). `useUser`, `useStreak`, `useLeague`, with optimistic updates after `track()`.
- [ ] **Docs site** (M). Concepts, config reference, API reference, recipes.
- [x] **OpenAPI spec** (M). Generated from the routes, so other languages can generate clients.
- [ ] **Next.js + Supabase starter** (M). Clone, add keys, have a gamified app running.
- [ ] **One-click deploys** (S each). Railway, Render, Fly.io, Vercel with Neon.
- [ ] **Comparison page** (S). Honest comparison with Trophy, Gami.Fied, building it yourself.
- [x] **Contributing guide, issue templates, security policy** (S).
- [ ] **Good-first-issues** (S). Open a handful of labelled starter issues.
- [ ] **Benchmarks** (S). Events per second and leaderboard latency on a known machine.

## Phase 3: Signature features (what makes it different)

- [ ] **Friend rivalries** (L). Pick a rival, weekly head-to-head on points, win/loss record, rematch. The leet-rivals mechanic.
- [ ] **Friends and follows** (M). A social graph inside onstreak, needed for friend leaderboards and rivalries.
- [ ] **Friends-only leaderboards** (M).
- [ ] **Teams, guilds and clubs** (L). Members, team points, team leaderboards, team leagues.
- [ ] **Quests and missions** (L). Daily and weekly quests ("finish 3 lessons today"), multi-step quests, rewards on completion.
- [ ] **Time-limited events** (M). "Double XP weekend", seasonal challenges, global community goals ("everyone together: 1M minutes").
- [ ] **Seasons** (M). Reset or soft-reset points and leagues each season, keep an archive and award season badges.
- [ ] **Multipliers and boosts** (M). Streak-based XP multiplier, event-wide boosts, personal boosts with an expiry.
- [ ] **Spendable currencies and a reward store** (L). Spend coins on items, inventory, purchase history, balance checks.
- [ ] **Streak shields and streak repair** (M). Buy a freeze with coins, repair a broken streak within N hours.
- [ ] **Richer streak rules** (M). "At least 3 lessons a day" to count, weekends off, custom week start, monthly streaks.
- [ ] **Daily login rewards and reward calendars** (S).
- [ ] **Referral rewards** (S).

## Phase 4: Deeper engine

- [ ] **Achievement upgrades** (M). Tiered badges (bronze, silver, gold of one badge), hidden achievements, progress percentage, achievements that award points.
- [ ] **Compound and time-window conditions** (M). AND/OR conditions, "5 lessons within one day", "100 xp in a week".
- [ ] **Event properties in rules** (M). Award points only when `difficulty = "hard"`, sum a property instead of counting.
- [ ] **A rules language** (L). Expression-based conditions (JSONLogic or similar) for anything the built-in rules cannot say.
- [ ] **Level curves** (S). Formula-based thresholds (linear, exponential), level-up rewards, prestige.
- [ ] **Leaderboard views** (M). Around-me (my rank plus or minus N), by segment (country, school, company), past winners archive.
- [ ] **League upgrades** (M). Fill small groups with ghost players, skill-based grouping, rewards for finishing top 3.
- [ ] **Corrections** (M). Reverse an event, revoke points or an achievement, with everything recalculated.
- [ ] **Replay and backfill** (L). Rebuild every user's state from the event log after a config change, with a dry run showing what would change.
- [ ] **Config preview and simulation** (M). "If I change level thresholds, how many users change level?"
- [ ] **"Streak at risk" list** (M). Users who have not done today's activity yet, for reminders.
- [ ] **Translated names** (S). Achievement and tier names in several languages.

## Phase 5: Integrations

- [ ] **Webhooks** (L). Signed payloads for level-up, unlock, streak extended or broken, promotion, with retries and a delivery log.
- [ ] **Built-in scheduler** (M). Runs reminders, season ends and league round summaries without an outside cron.
- [ ] **Email and push nudges** (L). Streak reminders, "league ends in 3 hours", "you lost first place", through Resend, OneSignal or FCM.
- [ ] **Supabase-native mode** (M). Work with Supabase auth user IDs, row-level security, and database triggers as event sources.
- [ ] **Postgres-native tracking** (M). Track events with a SQL function or trigger, no HTTP call needed.
- [ ] **Analytics pipeline source** (M). Receive events from Segment, RudderStack or PostHog.
- [ ] **Discord bot** (M). Tier roles, streak announcements, league results posted to a channel. Slack and Telegram later.
- [ ] **GitHub integration** (M). Commits and merged PRs as events, for developer streaks. Good for dogfooding.
- [ ] **Coding platform adapters** (M). LeetCode and Codeforces activity as events, tying back to leet-rivals.
- [ ] **Zapier, Make and n8n** (M).

## Phase 6: Admin and insight

- [ ] **Admin dashboard** (L). Browse users and events, adjust points, edit config with validation, see webhook deliveries.
- [ ] **Engagement analytics** (L). Retention by streak length, achievement unlock funnel, league movement, points economy (inflation).
- [ ] **Experiments** (L). Test streak rules or freeze settings against retention, with holdout groups.
- [ ] **Audit log** (M). Who changed what, for every admin action.

## Phase 7: Security and scale

- [ ] **Multiple and scoped API keys** (M). Read-only keys, key rotation.
- [ ] **Signed user tokens for browsers and apps** (M). Short-lived tokens so a client can read only its own user, without exposing the API key.
- [ ] **Rate limiting** (S).
- [ ] **CORS settings** (S).
- [ ] **Anti-cheat** (M). Caps per event per day, minimum time between events, maximum values, flags for unusual activity.
- [ ] **GDPR tools** (S). Delete a user and everything about them, export a user's data.
- [ ] **Leaderboard rollups and caching** (M). Pre-summed totals so boards stay fast with millions of users.
- [ ] **Optional Redis** (M). Sorted sets for very hot leaderboards.
- [ ] **Ledger retention and compaction** (M). Roll old points rows into totals.
- [ ] **Metrics endpoint** (M). Prometheus counters for events, latency, errors.
- [ ] **Load tests** (M).
- [ ] **Helm chart** (M).

## Phase 8: Ecosystem

- [ ] **SDKs**: Python, Go, Ruby, PHP (M each); Swift and Kotlin for mobile (M each).
- [ ] **React Native / Expo components** (M).
- [ ] **Web components** (M). Framework-agnostic widgets.
- [ ] **Example gallery** (M). Fitness, language learning, developer streaks, habit tracker, classroom.
- [ ] **Multiple projects per server** (L). One onstreak instance serving several apps, each with its own config and keys.

## Phase 9: Hosted onstreak (optional business)

- [ ] **Hosted cloud** (L). Sign up, create a project, get keys, no servers to run.
- [ ] **Usage metering and billing** (M). Free tier, then pay per monthly active user.
- [ ] **Team accounts** (M).
- [ ] **Status page and uptime SLA** (S).
