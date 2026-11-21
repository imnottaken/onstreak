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
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
