import type { TrackResult } from "../engine.js";
import type { StreakState } from "../streaks.js";
import type { LeagueOutcome } from "../leagues.js";
import type { LeaderboardEntry, LeaderboardQuery, Membership, Store, UserSnapshot, UserTx } from "./types.js";

/** Anything that can run a parameterized query: a pg client or pool, or PGlite. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SqlDriver extends Queryable {
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

interface PgPoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/** Adapt a `pg` Pool (node-postgres). */
export function fromPgPool(pool: PgPoolLike): SqlDriver {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

interface PgliteLike extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Adapt a PGlite instance (embedded Postgres, handy for tests and demos). */
export function fromPglite(db: PgliteLike): SqlDriver {
  return { query: (text, params) => db.query(text, params), transaction: (fn) => db.transaction(fn) };
}

export const SCHEMA = `
create table if not exists onstreak_users (
  id text primary key,
  created_at timestamptz not null default now()
);
create table if not exists onstreak_events (
  id uuid primary key,
  user_id text not null references onstreak_users(id),
  key text not null,
  value double precision not null,
  ts timestamptz not null,
  idempotency_key text,
  result jsonb,
  unique (user_id, idempotency_key)
);
create table if not exists onstreak_metrics (
  user_id text not null references onstreak_users(id),
  key text not null,
  total double precision not null default 0,
  primary key (user_id, key)
);
create table if not exists onstreak_balances (
  user_id text not null references onstreak_users(id),
  currency text not null,
  total double precision not null default 0,
  primary key (user_id, currency)
);
create table if not exists onstreak_ledger (
  id bigserial primary key,
  user_id text not null references onstreak_users(id),
  currency text not null,
  amount double precision not null,
  ts timestamptz not null,
  event_id uuid
);
create index if not exists onstreak_ledger_currency_ts on onstreak_ledger (currency, ts);
create table if not exists onstreak_streaks (
  user_id text not null references onstreak_users(id),
  streak_id text not null,
  current integer not null,
  longest integer not null,
  last_period text,
  freezes integer not null,
  primary key (user_id, streak_id)
);
create table if not exists onstreak_achievements (
  user_id text not null references onstreak_users(id),
  achievement_id text not null,
  unlocked_at timestamptz not null,
  primary key (user_id, achievement_id)
);
create table if not exists onstreak_league_members (
  league_id text not null,
  user_id text not null references onstreak_users(id),
  round_key text not null,
  tier text not null,
  group_no integer not null,
  joined_at timestamptz not null,
  outcome text,
  final_rank integer,
  next_tier text,
  primary key (league_id, user_id, round_key)
);
create index if not exists onstreak_league_groups on onstreak_league_members (league_id, round_key, tier, group_no);
`;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

function rowToStreak(r: Record<string, unknown>): StreakState {
  return {
    current: num(r.current),
    longest: num(r.longest),
    lastPeriod: (r.last_period as string | null) ?? null,
    freezes: num(r.freezes),
  };
}

/** Postgres-backed store. Works with any Postgres 13+, including Supabase and Neon. */
export class PostgresStore implements Store {
  constructor(private readonly db: SqlDriver) {}

  async migrate(): Promise<void> {
    await this.db.transaction(async (q) => {
      for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
        await q.query(statement);
      }
    });
  }

  async withUser<T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (q) => {
      await q.query("insert into onstreak_users (id) values ($1) on conflict (id) do nothing", [userId]);
      await q.query("select id from onstreak_users where id = $1 for update", [userId]);
      return fn(this.tx(q, userId));
    });
  }

  private tx(q: Queryable, userId: string): UserTx {
    return {
      async findByIdempotencyKey(key) {
        const { rows } = await q.query("select result from onstreak_events where user_id = $1 and idempotency_key = $2", [userId, key]);
        const result = rows[0]?.result;
        if (!result) return null;
        return (typeof result === "string" ? JSON.parse(result) : result) as TrackResult;
      },
      async insertEvent(e) {
        await q.query(
          "insert into onstreak_events (id, user_id, key, value, ts, idempotency_key) values ($1, $2, $3, $4, $5, $6)",
          [e.id, userId, e.key, e.value, new Date(e.ts).toISOString(), e.idempotencyKey],
        );
      },
      async setEventResult(eventId, result) {
        await q.query("update onstreak_events set result = $2 where id = $1", [eventId, JSON.stringify(result)]);
      },
      async addMetric(key, delta) {
        const { rows } = await q.query(
          `insert into onstreak_metrics (user_id, key, total) values ($1, $2, $3)
           on conflict (user_id, key) do update set total = onstreak_metrics.total + excluded.total
           returning total`,
          [userId, key, delta],
        );
        return num(rows[0]?.total);
      },
      async getMetric(key) {
        const { rows } = await q.query("select total from onstreak_metrics where user_id = $1 and key = $2", [userId, key]);
        return rows[0] ? num(rows[0].total) : 0;
      },
      async addPoints(currency, amount, ts, eventId) {
        await q.query("insert into onstreak_ledger (user_id, currency, amount, ts, event_id) values ($1, $2, $3, $4, $5)", [
          userId,
          currency,
          amount,
          new Date(ts).toISOString(),
          eventId,
        ]);
        const { rows } = await q.query(
          `insert into onstreak_balances (user_id, currency, total) values ($1, $2, $3)
           on conflict (user_id, currency) do update set total = onstreak_balances.total + excluded.total
           returning total`,
          [userId, currency, amount],
        );
        return num(rows[0]?.total);
      },
      async getBalance(currency) {
        const { rows } = await q.query("select total from onstreak_balances where user_id = $1 and currency = $2", [userId, currency]);
        return rows[0] ? num(rows[0].total) : 0;
      },
      async getStreak(id) {
        const { rows } = await q.query("select * from onstreak_streaks where user_id = $1 and streak_id = $2", [userId, id]);
        return rows[0] ? rowToStreak(rows[0]) : null;
      },
      async setStreak(id, s) {
        await q.query(
          `insert into onstreak_streaks (user_id, streak_id, current, longest, last_period, freezes) values ($1, $2, $3, $4, $5, $6)
           on conflict (user_id, streak_id) do update set current = $3, longest = $4, last_period = $5, freezes = $6`,
          [userId, id, s.current, s.longest, s.lastPeriod, s.freezes],
        );
      },
      async unlockedAchievements() {
        const { rows } = await q.query("select achievement_id from onstreak_achievements where user_id = $1", [userId]);
        return new Set(rows.map((r) => String(r.achievement_id)));
      },
      async unlock(id, ts) {
        await q.query(
          "insert into onstreak_achievements (user_id, achievement_id, unlocked_at) values ($1, $2, $3) on conflict do nothing",
          [userId, id, new Date(ts).toISOString()],
        );
      },
      async getMemberships(leagueId, limit) {
        const { rows } = await q.query(
          "select * from onstreak_league_members where user_id = $1 and league_id = $2 order by round_key desc limit $3",
          [userId, leagueId, limit],
        );
        return rows.map(
          (r): Membership => ({
            leagueId: String(r.league_id),
            roundKey: String(r.round_key),
            tier: String(r.tier),
            group: num(r.group_no),
            joinedAt: new Date(iso(r.joined_at)).getTime(),
            outcome: (r.outcome as LeagueOutcome | null) ?? null,
            finalRank: r.final_rank === null || r.final_rank === undefined ? null : num(r.final_rank),
            nextTier: (r.next_tier as string | null) ?? null,
          }),
        );
      },
      async joinLeague(leagueId, roundKey, tier, groupSize, joinedAt) {
        // Serialize joins per (league, round, tier) so groups never overfill.
        await q.query("select pg_advisory_xact_lock(hashtext($1))", [`onstreak:${leagueId}:${roundKey}:${tier}`]);
        const { rows } = await q.query(
          `select group_no, count(*) as size from onstreak_league_members
           where league_id = $1 and round_key = $2 and tier = $3 group by group_no order by group_no`,
          [leagueId, roundKey, tier],
        );
        const sizes = new Map(rows.map((r) => [num(r.group_no), num(r.size)]));
        let group = 1;
        while ((sizes.get(group) ?? 0) >= groupSize) group++;
        await q.query(
          `insert into onstreak_league_members (league_id, user_id, round_key, tier, group_no, joined_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [leagueId, userId, roundKey, tier, group, new Date(joinedAt).toISOString()],
        );
        return group;
      },
      async settleMembership(leagueId, roundKey, result) {
        await q.query(
          `update onstreak_league_members set outcome = $4, final_rank = $5, next_tier = $6
           where league_id = $1 and user_id = $2 and round_key = $3`,
          [leagueId, userId, roundKey, result.outcome, result.finalRank, result.nextTier],
        );
      },
      async groupStandings(g) {
        const { rows } = await q.query(
          `select m.user_id, m.joined_at, coalesce(sum(l.amount), 0) as score
           from onstreak_league_members m
           left join onstreak_ledger l
             on l.user_id = m.user_id and l.currency = $5 and l.ts >= $6::timestamptz and l.ts < $7::timestamptz
           where m.league_id = $1 and m.round_key = $2 and m.tier = $3 and m.group_no = $4
           group by m.user_id, m.joined_at
           order by score desc, m.joined_at asc, m.user_id`,
          [g.leagueId, g.roundKey, g.tier, g.group, g.currency, new Date(g.from).toISOString(), new Date(g.to).toISOString()],
        );
        return rows.map((r) => ({ userId: String(r.user_id), score: num(r.score), joinedAt: new Date(iso(r.joined_at)).getTime() }));
      },
    };
  }

  async snapshot(userId: string): Promise<UserSnapshot> {
    const [metrics, balances, streaks, achievements] = await Promise.all([
      this.db.query("select key, total from onstreak_metrics where user_id = $1", [userId]),
      this.db.query("select currency, total from onstreak_balances where user_id = $1", [userId]),
      this.db.query("select * from onstreak_streaks where user_id = $1", [userId]),
      this.db.query("select achievement_id, unlocked_at from onstreak_achievements where user_id = $1 order by unlocked_at", [userId]),
    ]);
    return {
      metrics: Object.fromEntries(metrics.rows.map((r) => [String(r.key), num(r.total)])),
      balances: Object.fromEntries(balances.rows.map((r) => [String(r.currency), num(r.total)])),
      streaks: Object.fromEntries(streaks.rows.map((r) => [String(r.streak_id), rowToStreak(r)])),
      achievements: achievements.rows.map((r) => ({ id: String(r.achievement_id), unlockedAt: iso(r.unlocked_at) })),
    };
  }

  async leaderboard(q: LeaderboardQuery): Promise<{ entries: LeaderboardEntry[]; user: LeaderboardEntry | null }> {
    const { rows } = await this.db.query(
      `with scores as (
         select user_id, sum(amount) as score
         from onstreak_ledger
         where currency = $1
           and ($2::timestamptz is null or ts >= $2::timestamptz)
           and ($3::timestamptz is null or ts < $3::timestamptz)
         group by user_id
       ), ranked as (
         select user_id, score, rank() over (order by score desc) as rank
         from scores
       ), ordered as (
         select user_id, score, rank, row_number() over (order by score desc, user_id) as pos
         from ranked
       )
       select user_id, score, rank, pos from ordered
       where pos <= $4 or user_id = $5
       order by pos`,
      [
        q.currency,
        q.from === null ? null : new Date(q.from).toISOString(),
        q.to === null ? null : new Date(q.to).toISOString(),
        q.limit,
        q.userId ?? null,
      ],
    );
    const toEntry = (r: Record<string, unknown>): LeaderboardEntry => ({ rank: num(r.rank), userId: String(r.user_id), score: num(r.score) });
    const entries = rows.filter((r) => num(r.pos) <= q.limit).map(toEntry);
    const userRow = q.userId ? rows.find((r) => r.user_id === q.userId) : undefined;
    return { entries, user: userRow ? toEntry(userRow) : null };
  }
}
