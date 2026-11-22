/**
 * Versioned schema migrations for the Postgres store.
 *
 * Rules for adding one:
 * - Append it with the next version number. Never edit or reorder a shipped migration.
 * - Use `t.<table>` names so table prefixes keep working.
 * - Each migration runs in the same transaction as its version record, so a
 *   failure leaves the database exactly as it was.
 *
 * Migration 1 uses `if not exists` so databases created before migrations
 * existed (onstreak 0.1) are adopted without changes.
 */

export interface Tables {
  prefix: string;
  migrations: string;
  users: string;
  events: string;
  metrics: string;
  balances: string;
  ledger: string;
  streaks: string;
  achievements: string;
  leagueMembers: string;
  friends: string;
  rivalries: string;
  rivalryRounds: string;
  quests: string;
  inventory: string;
  purchases: string;
  itemUses: string;
  boosts: string;
  calendars: string;
  referrals: string;
  communityRewards: string;
  seasonAwards: string;
  teams: string;
  teamMembers: string;
  teamGoalRewards: string;
}

export function tableNames(prefix: string): Tables {
  return {
    prefix,
    migrations: `${prefix}schema_migrations`,
    users: `${prefix}users`,
    events: `${prefix}events`,
    metrics: `${prefix}metrics`,
    balances: `${prefix}balances`,
    ledger: `${prefix}ledger`,
    streaks: `${prefix}streaks`,
    achievements: `${prefix}achievements`,
    leagueMembers: `${prefix}league_members`,
    friends: `${prefix}friends`,
    rivalries: `${prefix}rivalries`,
    rivalryRounds: `${prefix}rivalry_rounds`,
    quests: `${prefix}quest_progress`,
    inventory: `${prefix}inventory`,
    purchases: `${prefix}purchases`,
    itemUses: `${prefix}item_uses`,
    boosts: `${prefix}boosts`,
    calendars: `${prefix}calendar_progress`,
    referrals: `${prefix}referrals`,
    communityRewards: `${prefix}community_rewards`,
    seasonAwards: `${prefix}season_awards`,
    teams: `${prefix}teams`,
    teamMembers: `${prefix}team_members`,
    teamGoalRewards: `${prefix}team_goal_rewards`,
  };
}

export interface Migration {
  version: number;
  name: string;
  statements: (t: Tables) => string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    statements: (t) => [
      `create table if not exists ${t.users} (
         id text primary key,
         created_at timestamptz not null default now()
       )`,
      `create table if not exists ${t.events} (
         id uuid primary key,
         user_id text not null references ${t.users}(id),
         key text not null,
         value double precision not null,
         ts timestamptz not null,
         idempotency_key text,
         result jsonb,
         unique (user_id, idempotency_key)
       )`,
      `create table if not exists ${t.metrics} (
         user_id text not null references ${t.users}(id),
         key text not null,
         total double precision not null default 0,
         primary key (user_id, key)
       )`,
      `create table if not exists ${t.balances} (
         user_id text not null references ${t.users}(id),
         currency text not null,
         total double precision not null default 0,
         primary key (user_id, currency)
       )`,
      `create table if not exists ${t.ledger} (
         id bigserial primary key,
         user_id text not null references ${t.users}(id),
         currency text not null,
         amount double precision not null,
         ts timestamptz not null,
         event_id uuid
       )`,
      `create index if not exists ${t.prefix}ledger_currency_ts on ${t.ledger} (currency, ts)`,
      `create table if not exists ${t.streaks} (
         user_id text not null references ${t.users}(id),
         streak_id text not null,
         current integer not null,
         longest integer not null,
         last_period text,
         freezes integer not null,
         primary key (user_id, streak_id)
       )`,
      `create table if not exists ${t.achievements} (
         user_id text not null references ${t.users}(id),
         achievement_id text not null,
         unlocked_at timestamptz not null,
         primary key (user_id, achievement_id)
       )`,
      `create table if not exists ${t.leagueMembers} (
         league_id text not null,
         user_id text not null references ${t.users}(id),
         round_key text not null,
         tier text not null,
         group_no integer not null,
         joined_at timestamptz not null,
         outcome text,
         final_rank integer,
         next_tier text,
         primary key (league_id, user_id, round_key)
       )`,
      `create index if not exists ${t.prefix}league_groups on ${t.leagueMembers} (league_id, round_key, tier, group_no)`,
    ],
  },
  {
    version: 2,
    name: "user profiles and time zones",
    statements: (t) => [
      `alter table ${t.users} add column if not exists display_name text`,
      `alter table ${t.users} add column if not exists avatar_url text`,
      `alter table ${t.users} add column if not exists metadata jsonb not null default '{}'::jsonb`,
      `alter table ${t.users} add column if not exists timezone text`,
      `alter table ${t.users} add column if not exists updated_at timestamptz`,
    ],
  },
  {
    version: 3,
    name: "record when events and points arrived",
    statements: (t) => [
      // Existing rows are assumed to have arrived when they happened.
      `alter table ${t.events} add column if not exists recorded_at timestamptz`,
      `update ${t.events} set recorded_at = ts where recorded_at is null`,
      `alter table ${t.events} alter column recorded_at set not null`,
      `alter table ${t.events} alter column recorded_at set default now()`,
      `alter table ${t.ledger} add column if not exists recorded_at timestamptz`,
      `update ${t.ledger} set recorded_at = ts where recorded_at is null`,
      `alter table ${t.ledger} alter column recorded_at set not null`,
      `alter table ${t.ledger} alter column recorded_at set default now()`,
    ],
  },
  {
    version: 4,
    name: "index for event history",
    statements: (t) => [`create index if not exists ${t.prefix}events_user_ts on ${t.events} (user_id, ts desc, id desc)`],
  },
  {
    version: 5,
    name: "friends",
    statements: (t) => [
      // Friendship is mutual: each one is stored in both directions.
      `create table if not exists ${t.friends} (
         user_id text not null references ${t.users}(id),
         friend_id text not null references ${t.users}(id),
         created_at timestamptz not null default now(),
         primary key (user_id, friend_id),
         check (user_id <> friend_id)
       )`,
    ],
  },
  {
    version: 6,
    name: "rivalries",
    statements: (t) => [
      // One row per pair, stored once with user_a < user_b.
      `create table if not exists ${t.rivalries} (
         rivalry_id text not null,
         user_a text not null references ${t.users}(id),
         user_b text not null references ${t.users}(id),
         started_round text not null,
         created_at timestamptz not null default now(),
         primary key (rivalry_id, user_a, user_b),
         check (user_a < user_b)
       )`,
      `create index if not exists ${t.prefix}rivalries_b on ${t.rivalries} (rivalry_id, user_b)`,
      // Finished rounds, written once when first settled.
      `create table if not exists ${t.rivalryRounds} (
         rivalry_id text not null,
         user_a text not null,
         user_b text not null,
         round_key text not null,
         score_a double precision not null,
         score_b double precision not null,
         primary key (rivalry_id, user_a, user_b, round_key),
         foreign key (rivalry_id, user_a, user_b) references ${t.rivalries} (rivalry_id, user_a, user_b) on delete cascade
       )`,
    ],
  },
  {
    version: 7,
    name: "quests",
    statements: (t) => [
      // One row per user, quest and period. Old periods stay as history.
      `create table if not exists ${t.quests} (
         user_id text not null references ${t.users}(id),
         quest_id text not null,
         period_key text not null,
         progress double precision not null,
         completed_at timestamptz,
         primary key (user_id, quest_id, period_key)
       )`,
    ],
  },
  {
    version: 8,
    name: "reward store",
    statements: (t) => [
      // Earned totals stay as they are (levels, achievements and boards use them); spending is tracked beside them.
      `alter table ${t.balances} add column if not exists spent double precision not null default 0`,
      `create table if not exists ${t.inventory} (
         user_id text not null references ${t.users}(id),
         item_id text not null,
         quantity integer not null check (quantity >= 0),
         primary key (user_id, item_id)
       )`,
      `create table if not exists ${t.purchases} (
         id uuid primary key,
         user_id text not null references ${t.users}(id),
         item_id text not null,
         quantity integer not null,
         currency text not null,
         cost double precision not null,
         purchased_at timestamptz not null,
         idempotency_key text,
         unique (user_id, idempotency_key)
       )`,
      `create index if not exists ${t.prefix}purchases_user on ${t.purchases} (user_id, purchased_at desc, id desc)`,
    ],
  },
  {
    version: 9,
    name: "item uses",
    statements: (t) => [
      `create table if not exists ${t.itemUses} (
         id uuid primary key,
         user_id text not null references ${t.users}(id),
         item_id text not null,
         quantity integer not null,
         used_at timestamptz not null,
         idempotency_key text,
         result jsonb not null,
         unique (user_id, idempotency_key)
       )`,
    ],
  },
  {
    version: 10,
    name: "personal boosts",
    statements: (t) => [
      `create table if not exists ${t.boosts} (
         id uuid primary key,
         user_id text not null references ${t.users}(id),
         currency text,
         factor double precision not null,
         starts_at timestamptz not null,
         ends_at timestamptz not null,
         reason text not null,
         idempotency_key text,
         unique (user_id, idempotency_key)
       )`,
      `create index if not exists ${t.prefix}boosts_user_end on ${t.boosts} (user_id, ends_at)`,
    ],
  },
  {
    version: 11,
    name: "reward calendars",
    statements: (t) => [
      `create table if not exists ${t.calendars} (
         user_id text not null references ${t.users}(id),
         calendar_id text not null,
         day integer not null,
         last_period text not null,
         primary key (user_id, calendar_id)
       )`,
    ],
  },
  {
    version: 12,
    name: "referrals",
    statements: (t) => [
      // One row per referred user. The referrer is paid once settled_at is set.
      `create table if not exists ${t.referrals} (
         referred_id text primary key references ${t.users}(id),
         referrer_id text not null references ${t.users}(id),
         id uuid not null,
         created_at timestamptz not null,
         qualified_at timestamptz,
         settled_at timestamptz,
         rewarded boolean not null default false,
         check (referred_id <> referrer_id)
       )`,
      `create index if not exists ${t.prefix}referrals_referrer on ${t.referrals} (referrer_id, created_at desc)`,
    ],
  },
  {
    version: 13,
    name: "refunds",
    statements: (t) => [`alter table ${t.purchases} add column if not exists refunded integer not null default 0`],
  },
  {
    version: 14,
    name: "community goals",
    statements: (t) => [
      // Summing an event across everyone in a window.
      `create index if not exists ${t.prefix}events_key_ts on ${t.events} (key, ts)`,
      `create table if not exists ${t.communityRewards} (
         user_id text not null references ${t.users}(id),
         goal_id text not null,
         claimed_at timestamptz not null,
         primary key (user_id, goal_id)
       )`,
    ],
  },
  {
    version: 15,
    name: "streak minimums",
    statements: (t) => [
      `alter table ${t.streaks} add column if not exists progress_period text`,
      `alter table ${t.streaks} add column if not exists progress double precision not null default 0`,
    ],
  },
  {
    version: 16,
    name: "seasons",
    statements: (t) => [
      `create table if not exists ${t.seasonAwards} (
         user_id text not null references ${t.users}(id),
         season_id text not null,
         rank integer not null,
         claimed_at timestamptz not null,
         primary key (user_id, season_id)
       )`,
    ],
  },
  {
    version: 17,
    name: "teams",
    statements: (t) => [
      `create table if not exists ${t.teams} (
         id text primary key,
         name text not null,
         created_at timestamptz not null
       )`,
      // A user is in at most one team.
      `create table if not exists ${t.teamMembers} (
         user_id text primary key references ${t.users}(id),
         team_id text not null references ${t.teams}(id),
         joined_at timestamptz not null
       )`,
      `create index if not exists ${t.prefix}team_members_team on ${t.teamMembers} (team_id, joined_at)`,
    ],
  },
  {
    version: 18,
    name: "team goals",
    statements: (t) => [
      `create table if not exists ${t.teamGoalRewards} (
         user_id text not null references ${t.users}(id),
         goal_id text not null,
         period_key text not null,
         team_id text not null,
         claimed_at timestamptz not null,
         primary key (user_id, goal_id, period_key)
       )`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
