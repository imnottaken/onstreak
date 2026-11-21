import type { TrackResult } from "../engine.js";
import type { StreakState } from "../streaks.js";
import type { LeagueOutcome } from "../leagues.js";
import { LATEST_VERSION, MIGRATIONS, tableNames, type Tables } from "./migrations.js";
import { FriendLimitError } from "./types.js";
import type {
  EventPageQuery,
  FriendRecord,
  EventRecord,
  LeaderboardEntry,
  LeaderboardQuery,
  Membership,
  MigrationReport,
  ProfileData,
  PublicProfile,
  Store,
  UserSnapshot,
  UserTx,
} from "./types.js";

/** Anything that can run a parameterized query: a pg client or pool, or PGlite. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SqlDriver extends Queryable {
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Release connections. Optional. */
  end?(): Promise<void>;
}

interface PgPoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
  end(): Promise<void>;
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
    end: () => pool.end(),
  };
}

interface PgliteLike extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** Adapt a PGlite instance (embedded Postgres, handy for tests and demos). */
export function fromPglite(db: PgliteLike): SqlDriver {
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(fn),
    end: async () => {
      await db.close?.();
    },
  };
}

export interface PostgresStoreOptions {
  /**
   * Prepended to every table and index name. Default "onstreak_". Use a
   * different prefix to run two onstreak apps in one database. To use a
   * separate Postgres schema instead, set it on the connection
   * (search_path), e.g. the ONSTREAK_DB_SCHEMA setting of the server.
   */
  tablePrefix?: string;
}

const PREFIX = /^[a-z_][a-z0-9_]{0,40}$/;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const ms = (v: unknown): number => (v instanceof Date ? v : new Date(String(v))).getTime();
const iso = (v: unknown): string => new Date(ms(v)).toISOString();
const json = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

function rowToStreak(r: Record<string, unknown>): StreakState {
  return {
    current: num(r.current),
    longest: num(r.longest),
    lastPeriod: (r.last_period as string | null) ?? null,
    freezes: num(r.freezes),
  };
}

function rowToProfile(r: Record<string, unknown> | undefined): ProfileData {
  return {
    displayName: (r?.display_name as string | null | undefined) ?? null,
    avatarUrl: (r?.avatar_url as string | null | undefined) ?? null,
    metadata: r?.metadata ? json<Record<string, unknown>>(r.metadata) : {},
    timezone: (r?.timezone as string | null | undefined) ?? null,
  };
}

/** Postgres-backed store. Works with any Postgres 13+, including Supabase and Neon. */
export class PostgresStore implements Store {
  private readonly t: Tables;

  constructor(
    private readonly db: SqlDriver,
    options: PostgresStoreOptions = {},
  ) {
    const prefix = options.tablePrefix ?? "onstreak_";
    if (!PREFIX.test(prefix)) throw new Error(`tablePrefix "${prefix}" must be lowercase letters, digits and _ (max 41 chars)`);
    this.t = tableNames(prefix);
  }

  async migrate(): Promise<MigrationReport> {
    const t = this.t;
    return this.db.transaction(async (q) => {
      // Two servers starting at once must not both run the same migration.
      await q.query("select pg_advisory_xact_lock(hashtext($1))", [`${t.prefix}migrate`]);
      await q.query(
        `create table if not exists ${t.migrations} (
           version integer primary key,
           name text not null,
           applied_at timestamptz not null default now()
         )`,
      );
      const { rows } = await q.query(`select version from ${t.migrations}`);
      const done = new Set(rows.map((r) => num(r.version)));
      const highest = Math.max(0, ...done);
      if (highest > LATEST_VERSION) {
        throw new Error(
          `database schema is at version ${highest}, but this onstreak only knows up to ${LATEST_VERSION}. Upgrade onstreak before connecting it to this database.`,
        );
      }
      const applied: MigrationReport["applied"] = [];
      for (const m of MIGRATIONS) {
        if (done.has(m.version)) continue;
        for (const statement of m.statements(t)) await q.query(statement);
        await q.query(`insert into ${t.migrations} (version, name) values ($1, $2)`, [m.version, m.name]);
        applied.push({ version: m.version, name: m.name });
      }
      return { applied, version: LATEST_VERSION };
    });
  }

  /** Current and pending schema versions, without changing anything. */
  async migrationStatus(): Promise<{ version: number; latest: number; pending: Array<{ version: number; name: string }> }> {
    const { rows } = await this.db.query("select to_regclass($1) is not null as present", [this.t.migrations]);
    let done = new Set<number>();
    if (rows[0]?.present) {
      const res = await this.db.query(`select version from ${this.t.migrations}`);
      done = new Set(res.rows.map((r) => num(r.version)));
    }
    return {
      version: Math.max(0, ...done),
      latest: LATEST_VERSION,
      pending: MIGRATIONS.filter((m) => !done.has(m.version)).map((m) => ({ version: m.version, name: m.name })),
    };
  }

  async withUser<T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
    const t = this.t;
    return this.db.transaction(async (q) => {
      await q.query(`insert into ${t.users} (id) values ($1) on conflict (id) do nothing`, [userId]);
      await q.query(`select id from ${t.users} where id = $1 for update`, [userId]);
      return fn(this.tx(q, userId));
    });
  }

  private tx(q: Queryable, userId: string): UserTx {
    const t = this.t;
    const getProfile = async (): Promise<ProfileData> => {
      const { rows } = await q.query(`select display_name, avatar_url, metadata, timezone from ${t.users} where id = $1`, [userId]);
      return rowToProfile(rows[0]);
    };
    return {
      getProfile,
      async updateProfile(patch) {
        const sets: string[] = [];
        const params: unknown[] = [userId];
        const set = (column: string, value: unknown, cast = "") => {
          params.push(value);
          sets.push(`${column} = $${params.length}${cast}`);
        };
        if (patch.displayName !== undefined) set("display_name", patch.displayName);
        if (patch.avatarUrl !== undefined) set("avatar_url", patch.avatarUrl);
        if (patch.metadata !== undefined) set("metadata", JSON.stringify(patch.metadata ?? {}), "::jsonb");
        if (patch.timezone !== undefined) set("timezone", patch.timezone);
        if (sets.length > 0) await q.query(`update ${t.users} set ${sets.join(", ")}, updated_at = now() where id = $1`, params);
        return getProfile();
      },
      async findByIdempotencyKey(key) {
        const { rows } = await q.query(`select result from ${t.events} where user_id = $1 and idempotency_key = $2`, [userId, key]);
        const result = rows[0]?.result;
        return result ? json<TrackResult>(result) : null;
      },
      async insertEvent(e) {
        await q.query(
          `insert into ${t.events} (id, user_id, key, value, ts, recorded_at, idempotency_key) values ($1, $2, $3, $4, $5, $6, $7)`,
          [e.id, userId, e.key, e.value, new Date(e.ts).toISOString(), new Date(e.recordedAt).toISOString(), e.idempotencyKey],
        );
      },
      async setEventResult(eventId, result) {
        await q.query(`update ${t.events} set result = $2 where id = $1`, [eventId, JSON.stringify(result)]);
      },
      async addMetric(key, delta) {
        const { rows } = await q.query(
          `insert into ${t.metrics} (user_id, key, total) values ($1, $2, $3)
           on conflict (user_id, key) do update set total = ${t.metrics}.total + excluded.total
           returning total`,
          [userId, key, delta],
        );
        return num(rows[0]?.total);
      },
      async getMetric(key) {
        const { rows } = await q.query(`select total from ${t.metrics} where user_id = $1 and key = $2`, [userId, key]);
        return rows[0] ? num(rows[0].total) : 0;
      },
      async addPoints(currency, amount, ts, eventId, recordedAt) {
        await q.query(
          `insert into ${t.ledger} (user_id, currency, amount, ts, recorded_at, event_id) values ($1, $2, $3, $4, $5, $6)`,
          [userId, currency, amount, new Date(ts).toISOString(), new Date(recordedAt).toISOString(), eventId],
        );
        const { rows } = await q.query(
          `insert into ${t.balances} (user_id, currency, total) values ($1, $2, $3)
           on conflict (user_id, currency) do update set total = ${t.balances}.total + excluded.total
           returning total`,
          [userId, currency, amount],
        );
        return num(rows[0]?.total);
      },
      async getBalance(currency) {
        const { rows } = await q.query(`select total from ${t.balances} where user_id = $1 and currency = $2`, [userId, currency]);
        return rows[0] ? num(rows[0].total) : 0;
      },
      async getStreak(id) {
        const { rows } = await q.query(`select * from ${t.streaks} where user_id = $1 and streak_id = $2`, [userId, id]);
        return rows[0] ? rowToStreak(rows[0]) : null;
      },
      async setStreak(id, s) {
        await q.query(
          `insert into ${t.streaks} (user_id, streak_id, current, longest, last_period, freezes) values ($1, $2, $3, $4, $5, $6)
           on conflict (user_id, streak_id) do update set current = $3, longest = $4, last_period = $5, freezes = $6`,
          [userId, id, s.current, s.longest, s.lastPeriod, s.freezes],
        );
      },
      async unlockedAchievements() {
        const { rows } = await q.query(`select achievement_id from ${t.achievements} where user_id = $1`, [userId]);
        return new Set(rows.map((r) => String(r.achievement_id)));
      },
      async unlock(id, ts) {
        await q.query(
          `insert into ${t.achievements} (user_id, achievement_id, unlocked_at) values ($1, $2, $3) on conflict do nothing`,
          [userId, id, new Date(ts).toISOString()],
        );
      },
      async getMemberships(leagueId, limit) {
        const { rows } = await q.query(
          `select * from ${t.leagueMembers} where user_id = $1 and league_id = $2 order by round_key desc limit $3`,
          [userId, leagueId, limit],
        );
        return rows.map(
          (r): Membership => ({
            leagueId: String(r.league_id),
            roundKey: String(r.round_key),
            tier: String(r.tier),
            group: num(r.group_no),
            joinedAt: ms(r.joined_at),
            outcome: (r.outcome as LeagueOutcome | null) ?? null,
            finalRank: r.final_rank === null || r.final_rank === undefined ? null : num(r.final_rank),
            nextTier: (r.next_tier as string | null) ?? null,
          }),
        );
      },
      async joinLeague(leagueId, roundKey, tier, groupSize, joinedAt) {
        // Serialize joins per (league, round, tier) so groups never overfill.
        await q.query("select pg_advisory_xact_lock(hashtext($1))", [`${t.prefix}league:${leagueId}:${roundKey}:${tier}`]);
        const { rows } = await q.query(
          `select group_no, count(*) as size from ${t.leagueMembers}
           where league_id = $1 and round_key = $2 and tier = $3 group by group_no order by group_no`,
          [leagueId, roundKey, tier],
        );
        const sizes = new Map(rows.map((r) => [num(r.group_no), num(r.size)]));
        let group = 1;
        while ((sizes.get(group) ?? 0) >= groupSize) group++;
        await q.query(
          `insert into ${t.leagueMembers} (league_id, user_id, round_key, tier, group_no, joined_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [leagueId, userId, roundKey, tier, group, new Date(joinedAt).toISOString()],
        );
        return group;
      },
      async settleMembership(leagueId, roundKey, result) {
        await q.query(
          `update ${t.leagueMembers} set outcome = $4, final_rank = $5, next_tier = $6
           where league_id = $1 and user_id = $2 and round_key = $3`,
          [leagueId, userId, roundKey, result.outcome, result.finalRank, result.nextTier],
        );
      },
      async groupStandings(g) {
        const { rows } = await q.query(
          `select m.user_id, m.joined_at, coalesce(sum(l.amount), 0) as score
           from ${t.leagueMembers} m
           left join ${t.ledger} l
             on l.user_id = m.user_id and l.currency = $5
            and l.ts >= $6::timestamptz and l.ts < $7::timestamptz
            and ($8::timestamptz is null or l.recorded_at < $8::timestamptz)
           where m.league_id = $1 and m.round_key = $2 and m.tier = $3 and m.group_no = $4
           group by m.user_id, m.joined_at
           order by score desc, m.joined_at asc, m.user_id`,
          [
            g.leagueId,
            g.roundKey,
            g.tier,
            g.group,
            g.currency,
            new Date(g.from).toISOString(),
            new Date(g.to).toISOString(),
            g.recordedBefore === null ? null : new Date(g.recordedBefore).toISOString(),
          ],
        );
        return rows.map((r) => ({ userId: String(r.user_id), score: num(r.score), joinedAt: ms(r.joined_at) }));
      },
    };
  }

  async snapshot(userId: string): Promise<UserSnapshot> {
    const t = this.t;
    const [profile, metrics, balances, streaks, achievements] = await Promise.all([
      this.db.query(`select display_name, avatar_url, metadata, timezone from ${t.users} where id = $1`, [userId]),
      this.db.query(`select key, total from ${t.metrics} where user_id = $1`, [userId]),
      this.db.query(`select currency, total from ${t.balances} where user_id = $1`, [userId]),
      this.db.query(`select * from ${t.streaks} where user_id = $1`, [userId]),
      this.db.query(`select achievement_id, unlocked_at from ${t.achievements} where user_id = $1 order by unlocked_at`, [userId]),
    ]);
    return {
      profile: rowToProfile(profile.rows[0]),
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
         from ${this.t.ledger}
         where currency = $1
           and ($2::timestamptz is null or ts >= $2::timestamptz)
           and ($3::timestamptz is null or ts < $3::timestamptz)
           and ($6::jsonb is null or user_id in (select jsonb_array_elements_text($6::jsonb)))
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
        q.userIds ? JSON.stringify(q.userIds) : null,
      ],
    );
    const toEntry = (r: Record<string, unknown>): LeaderboardEntry => ({ rank: num(r.rank), userId: String(r.user_id), score: num(r.score) });
    const entries = rows.filter((r) => num(r.pos) <= q.limit).map(toEntry);
    const userRow = q.userId ? rows.find((r) => r.user_id === q.userId) : undefined;
    return { entries, user: userRow ? toEntry(userRow) : null };
  }

  async profiles(userIds: string[]): Promise<Record<string, PublicProfile>> {
    if (userIds.length === 0) return {};
    const { rows } = await this.db.query(
      `select id, display_name, avatar_url from ${this.t.users}
       where id in (select jsonb_array_elements_text($1::jsonb))
         and (display_name is not null or avatar_url is not null)`,
      [JSON.stringify(userIds)],
    );
    return Object.fromEntries(
      rows.map((r) => [String(r.id), { displayName: (r.display_name as string | null) ?? null, avatarUrl: (r.avatar_url as string | null) ?? null }]),
    );
  }

  async events(userId: string, query: EventPageQuery): Promise<EventRecord[]> {
    const { rows } = await this.db.query(
      `select id, key, value, ts, recorded_at, result from ${this.t.events}
       where user_id = $1
         and ($2::timestamptz is null or (ts, id) < ($2::timestamptz, $3::uuid))
       order by ts desc, id desc
       limit $4`,
      [userId, query.before ? new Date(query.before.ts).toISOString() : null, query.before?.id ?? null, query.limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      key: String(r.key),
      value: num(r.value),
      ts: ms(r.ts),
      recordedAt: ms(r.recorded_at),
      result: r.result ? json<TrackResult>(r.result) : null,
    }));
  }

  async addFriendship(a: string, b: string, ts: number, maxFriends: number): Promise<boolean> {
    const t = this.t;
    return this.db.transaction(async (q) => {
      // Lock both users, always in the same order, so a and b adding each other at once cannot deadlock.
      for (const id of a < b ? [a, b] : [b, a]) {
        await q.query(`insert into ${t.users} (id) values ($1) on conflict (id) do nothing`, [id]);
        await q.query(`select id from ${t.users} where id = $1 for update`, [id]);
      }
      const existing = await q.query(`select 1 from ${t.friends} where user_id = $1 and friend_id = $2`, [a, b]);
      if (existing.rows.length > 0) return false;
      for (const id of [a, b]) {
        const { rows } = await q.query(`select count(*) as n from ${t.friends} where user_id = $1`, [id]);
        if (num(rows[0]?.n) >= maxFriends) throw new FriendLimitError(id);
      }
      await q.query(`insert into ${t.friends} (user_id, friend_id, created_at) values ($1, $2, $3), ($2, $1, $3)`, [
        a,
        b,
        new Date(ts).toISOString(),
      ]);
      return true;
    });
  }

  async removeFriendship(a: string, b: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `delete from ${this.t.friends} where (user_id = $1 and friend_id = $2) or (user_id = $2 and friend_id = $1) returning user_id`,
      [a, b],
    );
    return rows.length > 0;
  }

  async friends(userId: string): Promise<FriendRecord[]> {
    const t = this.t;
    const { rows } = await this.db.query(
      `select f.friend_id, f.created_at, u.display_name, u.avatar_url
       from ${t.friends} f join ${t.users} u on u.id = f.friend_id
       where f.user_id = $1
       order by f.created_at desc, f.friend_id`,
      [userId],
    );
    return rows.map((r) => ({
      userId: String(r.friend_id),
      since: ms(r.created_at),
      displayName: (r.display_name as string | null) ?? null,
      avatarUrl: (r.avatar_url as string | null) ?? null,
    }));
  }

  async ping(): Promise<void> {
    await this.db.query("select 1");
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}
