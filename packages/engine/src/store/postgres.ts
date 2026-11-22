import type { ItemUseResult, TrackResult } from "../engine.js";
import type { StreakState } from "../streaks.js";
import type { LeagueOutcome } from "../leagues.js";
import { LATEST_VERSION, MIGRATIONS, tableNames, type Tables } from "./migrations.js";
import { AlreadyInTeamError, FriendLimitError, RivalLimitError, TeamFullError } from "./types.js";
import type {
  EventPageQuery,
  FriendRecord,
  QuestProgress,
  PurchasePageQuery,
  PurchaseRecord,
  ItemUseRecord,
  BoostRecord,
  ReferralRecord,
  EventProperties,
  CommunityTotalQuery,
  TeamRecord,
  TeamMemberRecord,
  TeamScoreQuery,
  RivalRecord,
  WindowScoreQuery,
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

function rowToQuest(r: Record<string, unknown>): QuestProgress {
  return {
    questId: String(r.quest_id),
    periodKey: String(r.period_key),
    progress: num(r.progress),
    completedAt: r.completed_at === null || r.completed_at === undefined ? null : ms(r.completed_at),
  };
}

function rowToPurchase(r: Record<string, unknown>): PurchaseRecord {
  return {
    id: String(r.id),
    itemId: String(r.item_id),
    quantity: num(r.quantity),
    currency: String(r.currency),
    cost: num(r.cost),
    purchasedAt: ms(r.purchased_at),
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    refunded: num(r.refunded ?? 0),
  };
}

function rowToBoost(r: Record<string, unknown>): BoostRecord {
  return {
    id: String(r.id),
    currency: (r.currency as string | null) ?? null,
    factor: num(r.factor),
    startsAt: ms(r.starts_at),
    endsAt: ms(r.ends_at),
    reason: String(r.reason),
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
  };
}

function rowToReferral(r: Record<string, unknown>): ReferralRecord {
  const maybe = (v: unknown) => (v === null || v === undefined ? null : ms(v));
  return {
    id: String(r.id),
    referrerId: String(r.referrer_id),
    referredId: String(r.referred_id),
    createdAt: ms(r.created_at),
    qualifiedAt: maybe(r.qualified_at),
    settledAt: maybe(r.settled_at),
    rewarded: Boolean(r.rewarded),
  };
}

function rowToStreak(r: Record<string, unknown>): StreakState {
  return {
    current: num(r.current),
    longest: num(r.longest),
    lastPeriod: (r.last_period as string | null) ?? null,
    freezes: num(r.freezes),
    progressPeriod: (r.progress_period as string | null) ?? null,
    progress: num(r.progress ?? 0),
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
          `insert into ${t.events} (id, user_id, key, value, ts, recorded_at, idempotency_key, properties) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [e.id, userId, e.key, e.value, new Date(e.ts).toISOString(), new Date(e.recordedAt).toISOString(), e.idempotencyKey, e.properties ? JSON.stringify(e.properties) : null],
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
      async getSpent(currency) {
        const { rows } = await q.query(`select spent from ${t.balances} where user_id = $1 and currency = $2`, [userId, currency]);
        return rows[0] ? num(rows[0].spent) : 0;
      },
      async windowTotal(kind, key, from, to) {
        const sql =
          kind === "points"
            ? `select coalesce(sum(amount), 0) as total from ${t.ledger} where user_id = $1 and currency = $2 and ts >= $3 and ts < $4`
            : `select coalesce(sum(value), 0) as total from ${t.events} where user_id = $1 and key = $2 and ts >= $3 and ts < $4`;
        const { rows } = await q.query(sql, [userId, key, new Date(from).toISOString(), new Date(to).toISOString()]);
        return num(rows[0]?.total);
      },
      async spend(currency, amount) {
        await q.query(
          `insert into ${t.balances} (user_id, currency, total, spent) values ($1, $2, 0, $3)
           on conflict (user_id, currency) do update set spent = ${t.balances}.spent + excluded.spent`,
          [userId, currency, amount],
        );
      },
      async getInventory(itemId) {
        const { rows } = await q.query(`select quantity from ${t.inventory} where user_id = $1 and item_id = $2`, [userId, itemId]);
        return rows[0] ? num(rows[0].quantity) : 0;
      },
      async findPurchase(key) {
        const { rows } = await q.query(`select * from ${t.purchases} where user_id = $1 and idempotency_key = $2`, [userId, key]);
        return rows[0] ? rowToPurchase(rows[0]) : null;
      },
      async getPurchase(id) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
        const { rows } = await q.query(`select * from ${t.purchases} where user_id = $1 and id = $2`, [userId, id]);
        return rows[0] ? rowToPurchase(rows[0]) : null;
      },
      async refundPurchase(id, quantity, amount) {
        const { rows } = await q.query(`update ${t.purchases} set refunded = refunded + $3 where user_id = $1 and id = $2 returning currency, item_id`, [userId, id, quantity]);
        const p = rows[0]!;
        await q.query(`update ${t.balances} set spent = spent - $3 where user_id = $1 and currency = $2`, [userId, p.currency, amount]);
        await q.query(`update ${t.inventory} set quantity = quantity - $3 where user_id = $1 and item_id = $2`, [userId, p.item_id, quantity]);
      },
      async recordPurchase(p) {
        await q.query(
          `insert into ${t.purchases} (id, user_id, item_id, quantity, currency, cost, purchased_at, idempotency_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [p.id, userId, p.itemId, p.quantity, p.currency, p.cost, new Date(p.purchasedAt).toISOString(), p.idempotencyKey],
        );
        await q.query(
          `insert into ${t.balances} (user_id, currency, total, spent) values ($1, $2, 0, $3)
           on conflict (user_id, currency) do update set spent = ${t.balances}.spent + excluded.spent`,
          [userId, p.currency, p.cost],
        );
        const { rows } = await q.query(
          `insert into ${t.inventory} (user_id, item_id, quantity) values ($1, $2, $3)
           on conflict (user_id, item_id) do update set quantity = ${t.inventory}.quantity + excluded.quantity
           returning quantity`,
          [userId, p.itemId, p.quantity],
        );
        return num(rows[0]?.quantity);
      },
      async getReferral() {
        const { rows } = await q.query(`select * from ${t.referrals} where referred_id = $1`, [userId]);
        return rows[0] ? rowToReferral(rows[0]) : null;
      },
      async addReferral(r) {
        await q.query(`insert into ${t.users} (id) values ($1) on conflict (id) do nothing`, [r.referrerId]);
        const { rows } = await q.query(
          `insert into ${t.referrals} (referred_id, referrer_id, id, created_at, qualified_at) values ($1, $2, $3, $4, $5)
           on conflict (referred_id) do nothing returning referred_id`,
          [userId, r.referrerId, r.id, new Date(r.createdAt).toISOString(), r.qualifiedAt === null ? null : new Date(r.qualifiedAt).toISOString()],
        );
        return rows.length > 0;
      },
      async qualifyReferral(at) {
        await q.query(`update ${t.referrals} set qualified_at = $2 where referred_id = $1 and qualified_at is null`, [userId, new Date(at).toISOString()]);
      },
      async settleReferrals(max, at) {
        const { rows } = await q.query(
          `select * from ${t.referrals} where referrer_id = $1 and qualified_at is not null and settled_at is null
           order by qualified_at, referred_id for update`,
          [userId],
        );
        if (rows.length === 0) return [];
        const counted = await q.query(`select count(*) as n from ${t.referrals} where referrer_id = $1 and rewarded`, [userId]);
        let rewardedSoFar = num(counted.rows[0]?.n);
        const settled: ReferralRecord[] = [];
        for (const row of rows) {
          const rewarded = max === null || rewardedSoFar < max;
          if (rewarded) rewardedSoFar++;
          await q.query(`update ${t.referrals} set settled_at = $2, rewarded = $3 where referred_id = $1`, [row.referred_id, new Date(at).toISOString(), rewarded]);
          settled.push({ ...rowToReferral(row), settledAt: at, rewarded });
        }
        return settled;
      },
      async claimTeamGoalReward(goalId, periodKey, teamId, at) {
        const { rows } = await q.query(
          `insert into ${t.teamGoalRewards} (user_id, goal_id, period_key, team_id, claimed_at) values ($1, $2, $3, $4, $5) on conflict do nothing returning goal_id`,
          [userId, goalId, periodKey, teamId, new Date(at).toISOString()],
        );
        return rows.length > 0;
      },
      async claimSeasonAward(seasonId, rank, at) {
        const { rows } = await q.query(
          `insert into ${t.seasonAwards} (user_id, season_id, rank, claimed_at) values ($1, $2, $3, $4) on conflict do nothing returning season_id`,
          [userId, seasonId, rank, new Date(at).toISOString()],
        );
        return rows.length > 0;
      },
      async claimCommunityReward(goalId, at) {
        const { rows } = await q.query(
          `insert into ${t.communityRewards} (user_id, goal_id, claimed_at) values ($1, $2, $3) on conflict do nothing returning goal_id`,
          [userId, goalId, new Date(at).toISOString()],
        );
        return rows.length > 0;
      },
      async getCalendar(id) {
        const { rows } = await q.query(`select day, last_period from ${t.calendars} where user_id = $1 and calendar_id = $2`, [userId, id]);
        return rows[0] ? { day: num(rows[0].day), lastPeriod: String(rows[0].last_period) } : null;
      },
      async setCalendar(id, s) {
        await q.query(
          `insert into ${t.calendars} (user_id, calendar_id, day, last_period) values ($1, $2, $3, $4)
           on conflict (user_id, calendar_id) do update set day = $3, last_period = $4`,
          [userId, id, s.day, s.lastPeriod],
        );
      },
      async getBoosts(after) {
        const { rows } = await q.query(
          `select * from ${t.boosts} where user_id = $1 and ends_at > $2 order by starts_at, id`,
          [userId, new Date(after).toISOString()],
        );
        return rows.map(rowToBoost);
      },
      async findBoost(key) {
        const { rows } = await q.query(`select * from ${t.boosts} where user_id = $1 and idempotency_key = $2`, [userId, key]);
        return rows[0] ? rowToBoost(rows[0]) : null;
      },
      async addBoost(b) {
        await q.query(
          `insert into ${t.boosts} (id, user_id, currency, factor, starts_at, ends_at, reason, idempotency_key) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [b.id, userId, b.currency, b.factor, new Date(b.startsAt).toISOString(), new Date(b.endsAt).toISOString(), b.reason, b.idempotencyKey],
        );
      },
      async findItemUse(key) {
        const { rows } = await q.query(`select result from ${t.itemUses} where user_id = $1 and idempotency_key = $2`, [userId, key]);
        return rows[0] ? json<ItemUseResult>(rows[0].result) : null;
      },
      async recordItemUse(u: ItemUseRecord) {
        await q.query(
          `insert into ${t.itemUses} (id, user_id, item_id, quantity, used_at, idempotency_key, result) values ($1, $2, $3, $4, $5, $6, $7)`,
          [u.id, userId, u.itemId, u.quantity, new Date(u.usedAt).toISOString(), u.idempotencyKey, JSON.stringify(u.result)],
        );
        const { rows } = await q.query(
          `update ${t.inventory} set quantity = quantity - $3 where user_id = $1 and item_id = $2 returning quantity`,
          [userId, u.itemId, u.quantity],
        );
        return num(rows[0]?.quantity);
      },
      async getStreak(id) {
        const { rows } = await q.query(`select * from ${t.streaks} where user_id = $1 and streak_id = $2`, [userId, id]);
        return rows[0] ? rowToStreak(rows[0]) : null;
      },
      async setStreak(id, s) {
        await q.query(
          `insert into ${t.streaks} (user_id, streak_id, current, longest, last_period, freezes, progress_period, progress) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (user_id, streak_id) do update set current = $3, longest = $4, last_period = $5, freezes = $6, progress_period = $7, progress = $8`,
          [userId, id, s.current, s.longest, s.lastPeriod, s.freezes, s.progressPeriod ?? null, s.progress ?? 0],
        );
      },
      async getQuest(questId, periodKey) {
        const { rows } = await q.query(`select * from ${t.quests} where user_id = $1 and quest_id = $2 and period_key = $3`, [userId, questId, periodKey]);
        return rows[0] ? rowToQuest(rows[0]) : null;
      },
      async setQuest(p) {
        await q.query(
          `insert into ${t.quests} (user_id, quest_id, period_key, progress, completed_at) values ($1, $2, $3, $4, $5)
           on conflict (user_id, quest_id, period_key) do update set progress = $4, completed_at = $5`,
          [userId, p.questId, p.periodKey, p.progress, p.completedAt === null ? null : new Date(p.completedAt).toISOString()],
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
    const [profile, metrics, balances, inventory, calendars, streaks, achievements] = await Promise.all([
      this.db.query(`select display_name, avatar_url, metadata, timezone from ${t.users} where id = $1`, [userId]),
      this.db.query(`select key, total from ${t.metrics} where user_id = $1`, [userId]),
      this.db.query(`select currency, total, spent from ${t.balances} where user_id = $1`, [userId]),
      this.db.query(`select item_id, quantity from ${t.inventory} where user_id = $1 and quantity > 0`, [userId]),
      this.db.query(`select calendar_id, day, last_period from ${t.calendars} where user_id = $1`, [userId]),
      this.db.query(`select * from ${t.streaks} where user_id = $1`, [userId]),
      this.db.query(`select achievement_id, unlocked_at from ${t.achievements} where user_id = $1 order by unlocked_at`, [userId]),
    ]);
    return {
      profile: rowToProfile(profile.rows[0]),
      metrics: Object.fromEntries(metrics.rows.map((r) => [String(r.key), num(r.total)])),
      balances: Object.fromEntries(balances.rows.map((r) => [String(r.currency), num(r.total)])),
      spent: Object.fromEntries(balances.rows.filter((r) => num(r.spent) !== 0).map((r) => [String(r.currency), num(r.spent)])),
      inventory: Object.fromEntries(inventory.rows.map((r) => [String(r.item_id), num(r.quantity)])),
      calendars: Object.fromEntries(calendars.rows.map((r) => [String(r.calendar_id), { day: num(r.day), lastPeriod: String(r.last_period) }])),
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
           and ($7::timestamptz is null or recorded_at < $7::timestamptz)
           and ($9::text is null or user_id in (select id from ${this.t.users} where metadata ->> $9::text = $10::text))
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
          or ($8::int is not null and abs(pos - (select pos from ordered where user_id = $5)) <= $8::int)
       order by pos`,
      [
        q.currency,
        q.from === null ? null : new Date(q.from).toISOString(),
        q.to === null ? null : new Date(q.to).toISOString(),
        q.limit,
        q.userId ?? null,
        q.userIds ? JSON.stringify(q.userIds) : null,
        q.recordedBefore == null ? null : new Date(q.recordedBefore).toISOString(),
        q.around ?? null,
        q.segment?.key ?? null,
        q.segment?.value ?? null,
      ],
    );
    const toEntry = (r: Record<string, unknown>): LeaderboardEntry => ({ rank: num(r.rank), userId: String(r.user_id), score: num(r.score) });
    const userRow = q.userId ? rows.find((r) => r.user_id === q.userId) : undefined;
    const entries =
      q.around !== undefined && userRow
        ? rows.filter((r) => Math.abs(num(r.pos) - num(userRow.pos)) <= q.around!).map(toEntry)
        : rows.filter((r) => num(r.pos) <= q.limit).map(toEntry);
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
      `select id, key, value, ts, recorded_at, result, properties from ${this.t.events}
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
      properties: r.properties ? json<EventProperties>(r.properties) : null,
    }));
  }

  async communityTotal(q: CommunityTotalQuery): Promise<number> {
    const sql =
      q.kind === "points"
        ? `select coalesce(sum(amount), 0) as total from ${this.t.ledger} where currency = $1 and ts >= $2 and ts < $3 and ($4::text is null or user_id = $4)`
        : `select coalesce(sum(value), 0) as total from ${this.t.events} where key = $1 and ts >= $2 and ts < $3 and ($4::text is null or user_id = $4)`;
    const { rows } = await this.db.query(sql, [q.key, new Date(q.from).toISOString(), new Date(q.to).toISOString(), q.userId ?? null]);
    return num(rows[0]?.total);
  }

  async saveTeam(team: TeamRecord): Promise<boolean> {
    const { rows } = await this.db.query(
      `insert into ${this.t.teams} (id, name, created_at) values ($1, $2, $3)
       on conflict (id) do update set name = excluded.name
       returning (xmax = 0) as created`,
      [team.id, team.name, new Date(team.createdAt).toISOString()],
    );
    return Boolean(rows[0]?.created);
  }

  async getTeam(teamId: string): Promise<TeamRecord | null> {
    const { rows } = await this.db.query(`select * from ${this.t.teams} where id = $1`, [teamId]);
    return rows[0] ? { id: String(rows[0].id), name: String(rows[0].name), createdAt: ms(rows[0].created_at) } : null;
  }

  async addTeamMember(teamId: string, userId: string, joinedAt: number, maxMembers: number): Promise<boolean> {
    const t = this.t;
    return this.db.transaction(async (q) => {
      await q.query(`insert into ${t.users} (id) values ($1) on conflict (id) do nothing`, [userId]);
      await q.query(`select id from ${t.users} where id = $1 for update`, [userId]);
      // Joins to one team run one at a time, so it never overfills.
      await q.query("select pg_advisory_xact_lock(hashtext($1))", [`${t.prefix}team:${teamId}`]);
      const current = await q.query(`select team_id from ${t.teamMembers} where user_id = $1`, [userId]);
      if (current.rows[0]) {
        if (String(current.rows[0].team_id) === teamId) return false;
        throw new AlreadyInTeamError(String(current.rows[0].team_id));
      }
      const { rows } = await q.query(`select count(*) as n from ${t.teamMembers} where team_id = $1`, [teamId]);
      if (num(rows[0]?.n) >= maxMembers) throw new TeamFullError(teamId);
      await q.query(`insert into ${t.teamMembers} (user_id, team_id, joined_at) values ($1, $2, $3)`, [userId, teamId, new Date(joinedAt).toISOString()]);
      return true;
    });
  }

  async removeTeamMember(teamId: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.query(`delete from ${this.t.teamMembers} where user_id = $1 and team_id = $2 returning user_id`, [userId, teamId]);
    return rows.length > 0;
  }

  async teamMembers(teamId: string): Promise<TeamMemberRecord[]> {
    const { rows } = await this.db.query(`select * from ${this.t.teamMembers} where team_id = $1 order by joined_at, user_id`, [teamId]);
    return rows.map((r) => ({ userId: String(r.user_id), teamId: String(r.team_id), joinedAt: ms(r.joined_at) }));
  }

  async userTeam(userId: string): Promise<TeamMemberRecord | null> {
    const { rows } = await this.db.query(`select * from ${this.t.teamMembers} where user_id = $1`, [userId]);
    return rows[0] ? { userId: String(rows[0].user_id), teamId: String(rows[0].team_id), joinedAt: ms(rows[0].joined_at) } : null;
  }

  async teamContributions(teamId: string, kind: "event" | "points", key: string, from: number, to: number): Promise<Record<string, number>> {
    const t = this.t;
    const sql =
      kind === "points"
        ? `select m.user_id, sum(l.amount) as total from ${t.teamMembers} m
           join ${t.ledger} l on l.user_id = m.user_id and l.currency = $2 and l.ts >= greatest(m.joined_at, $3::timestamptz) and l.ts < $4::timestamptz
           where m.team_id = $1 group by m.user_id`
        : `select m.user_id, sum(e.value) as total from ${t.teamMembers} m
           join ${t.events} e on e.user_id = m.user_id and e.key = $2 and e.ts >= greatest(m.joined_at, $3::timestamptz) and e.ts < $4::timestamptz
           where m.team_id = $1 group by m.user_id`;
    const { rows } = await this.db.query(sql, [teamId, key, new Date(from).toISOString(), new Date(to).toISOString()]);
    return Object.fromEntries(rows.map((r) => [String(r.user_id), num(r.total)]).filter(([, n]) => n !== 0));
  }

  async teamGoalClaims(userId: string): Promise<Set<string>> {
    const { rows } = await this.db.query(`select goal_id, period_key from ${this.t.teamGoalRewards} where user_id = $1`, [userId]);
    return new Set(rows.map((r) => `${r.goal_id}|${r.period_key}`));
  }

  async teamMemberScores(teamId: string, currency: string, from: number | null, to: number | null): Promise<Record<string, number>> {
    const { rows } = await this.db.query(
      `select m.user_id, sum(l.amount) as score
       from ${this.t.teamMembers} m
       join ${this.t.ledger} l on l.user_id = m.user_id and l.currency = $2 and l.ts >= m.joined_at
        and ($3::timestamptz is null or l.ts >= $3::timestamptz) and ($4::timestamptz is null or l.ts < $4::timestamptz)
       where m.team_id = $1
       group by m.user_id`,
      [teamId, currency, from === null ? null : new Date(from).toISOString(), to === null ? null : new Date(to).toISOString()],
    );
    return Object.fromEntries(rows.map((r) => [String(r.user_id), num(r.score)]));
  }

  async teamScores(q: TeamScoreQuery) {
    const t = this.t;
    const { rows } = await this.db.query(
      `with scores as (
         select m.team_id, sum(l.amount) as score
         from ${t.teamMembers} m
         join ${t.ledger} l on l.user_id = m.user_id and l.currency = $1 and l.ts >= m.joined_at
          and ($2::timestamptz is null or l.ts >= $2::timestamptz) and ($3::timestamptz is null or l.ts < $3::timestamptz)
         group by m.team_id
       ), ranked as (
         select tm.id as team_id, coalesce(s.score, 0) as score,
                rank() over (order by coalesce(s.score, 0) desc) as rank,
                row_number() over (order by coalesce(s.score, 0) desc, tm.id) as pos
         from ${t.teams} tm left join scores s on s.team_id = tm.id
       )
       select * from ranked where pos <= $4 or team_id = $5 order by pos`,
      [q.currency, q.from === null ? null : new Date(q.from).toISOString(), q.to === null ? null : new Date(q.to).toISOString(), q.limit, q.teamId ?? null],
    );
    const toEntry = (r: Record<string, unknown>) => ({ rank: num(r.rank), teamId: String(r.team_id), score: num(r.score) });
    const entries = rows.filter((r) => num(r.pos) <= q.limit).map(toEntry);
    const team = q.teamId ? rows.find((r) => r.team_id === q.teamId) : undefined;
    return { entries, team: team ? toEntry(team) : null };
  }

  async seasonAwards(userId: string): Promise<Record<string, { rank: number; claimedAt: number }>> {
    const { rows } = await this.db.query(`select season_id, rank, claimed_at from ${this.t.seasonAwards} where user_id = $1`, [userId]);
    return Object.fromEntries(rows.map((r) => [String(r.season_id), { rank: num(r.rank), claimedAt: ms(r.claimed_at) }]));
  }

  async communityClaims(userId: string): Promise<Set<string>> {
    const { rows } = await this.db.query(`select goal_id from ${this.t.communityRewards} where user_id = $1`, [userId]);
    return new Set(rows.map((r) => String(r.goal_id)));
  }

  async referrals(userId: string): Promise<{ referredBy: ReferralRecord | null; referred: ReferralRecord[] }> {
    const [by, referred] = await Promise.all([
      this.db.query(`select * from ${this.t.referrals} where referred_id = $1`, [userId]),
      this.db.query(`select * from ${this.t.referrals} where referrer_id = $1 order by created_at desc, referred_id desc`, [userId]),
    ]);
    return { referredBy: by.rows[0] ? rowToReferral(by.rows[0]) : null, referred: referred.rows.map(rowToReferral) };
  }

  async boosts(userId: string, after: number): Promise<BoostRecord[]> {
    const { rows } = await this.db.query(
      `select * from ${this.t.boosts} where user_id = $1 and ends_at > $2 order by starts_at, id`,
      [userId, new Date(after).toISOString()],
    );
    return rows.map(rowToBoost);
  }

  async purchases(userId: string, query: PurchasePageQuery): Promise<PurchaseRecord[]> {
    const { rows } = await this.db.query(
      `select * from ${this.t.purchases}
       where user_id = $1
         and ($2::timestamptz is null or (purchased_at, id) < ($2::timestamptz, $3::uuid))
       order by purchased_at desc, id desc
       limit $4`,
      [userId, query.before ? new Date(query.before.ts).toISOString() : null, query.before?.id ?? null, query.limit],
    );
    return rows.map(rowToPurchase);
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

  async addRivalry(rivalryId: string, a: string, b: string, startedRound: string, ts: number, max: number): Promise<boolean> {
    const t = this.t;
    const [ua, ub] = a < b ? [a, b] : [b, a];
    return this.db.transaction(async (q) => {
      for (const id of [ua, ub]) {
        await q.query(`insert into ${t.users} (id) values ($1) on conflict (id) do nothing`, [id]);
        await q.query(`select id from ${t.users} where id = $1 for update`, [id]);
      }
      const existing = await q.query(`select 1 from ${t.rivalries} where rivalry_id = $1 and user_a = $2 and user_b = $3`, [rivalryId, ua, ub]);
      if (existing.rows.length > 0) return false;
      for (const id of [a, b]) {
        const { rows } = await q.query(`select count(*) as n from ${t.rivalries} where rivalry_id = $1 and (user_a = $2 or user_b = $2)`, [rivalryId, id]);
        if (num(rows[0]?.n) >= max) throw new RivalLimitError(id);
      }
      await q.query(`insert into ${t.rivalries} (rivalry_id, user_a, user_b, started_round, created_at) values ($1, $2, $3, $4, $5)`, [
        rivalryId,
        ua,
        ub,
        startedRound,
        new Date(ts).toISOString(),
      ]);
      return true;
    });
  }

  async removeRivalry(rivalryId: string, a: string, b: string): Promise<boolean> {
    const [ua, ub] = a < b ? [a, b] : [b, a];
    const { rows } = await this.db.query(
      `delete from ${this.t.rivalries} where rivalry_id = $1 and user_a = $2 and user_b = $3 returning rivalry_id`,
      [rivalryId, ua, ub],
    );
    return rows.length > 0;
  }

  async quests(userId: string, keys: Array<{ questId: string; periodKey: string }>): Promise<QuestProgress[]> {
    if (keys.length === 0) return [];
    const { rows } = await this.db.query(
      `select q.* from ${this.t.quests} q
       join unnest($2::text[], $3::text[]) as k(quest_id, period_key) on q.quest_id = k.quest_id and q.period_key = k.period_key
       where q.user_id = $1`,
      [userId, keys.map((k) => k.questId), keys.map((k) => k.periodKey)],
    );
    return rows.map(rowToQuest);
  }

  async rivalries(rivalryId: string, userId: string): Promise<RivalRecord[]> {
    const t = this.t;
    const [pairs, rounds] = await Promise.all([
      this.db.query(
        `select case when user_a = $2 then user_b else user_a end as rival, started_round, created_at
         from ${t.rivalries} where rivalry_id = $1 and (user_a = $2 or user_b = $2)
         order by created_at desc, rival`,
        [rivalryId, userId],
      ),
      this.db.query(
        `select user_a, user_b, round_key, score_a, score_b from ${t.rivalryRounds}
         where rivalry_id = $1 and (user_a = $2 or user_b = $2) order by round_key`,
        [rivalryId, userId],
      ),
    ]);
    const byRival = new Map<string, RivalRecord["rounds"]>();
    for (const r of rounds.rows) {
      const mine = r.user_a === userId;
      const rival = String(mine ? r.user_b : r.user_a);
      const list = byRival.get(rival) ?? [];
      list.push({ roundKey: String(r.round_key), you: num(mine ? r.score_a : r.score_b), them: num(mine ? r.score_b : r.score_a) });
      byRival.set(rival, list);
    }
    return pairs.rows.map((r) => ({
      rivalId: String(r.rival),
      startedRound: String(r.started_round),
      since: ms(r.created_at),
      rounds: byRival.get(String(r.rival)) ?? [],
    }));
  }

  async recordRivalryRound(rivalryId: string, a: string, b: string, roundKey: string, scoreA: number, scoreB: number): Promise<void> {
    const t = this.t;
    const [ua, ub, sa, sb] = a < b ? [a, b, scoreA, scoreB] : [b, a, scoreB, scoreA];
    // Only if the rivalry still exists (it may have been ended meanwhile).
    await this.db.query(
      `insert into ${t.rivalryRounds} (rivalry_id, user_a, user_b, round_key, score_a, score_b)
       select $1, $2, $3, $4, $5, $6
       where exists (select 1 from ${t.rivalries} where rivalry_id = $1 and user_a = $2 and user_b = $3)
       on conflict do nothing`,
      [rivalryId, ua, ub, roundKey, sa, sb],
    );
  }

  async windowScores(q: WindowScoreQuery): Promise<Record<string, number>> {
    if (q.userIds.length === 0) return {};
    const { rows } = await this.db.query(
      `select user_id, sum(amount) as score from ${this.t.ledger}
       where currency = $1 and ts >= $2::timestamptz and ts < $3::timestamptz
         and ($4::timestamptz is null or recorded_at < $4::timestamptz)
         and user_id in (select jsonb_array_elements_text($5::jsonb))
       group by user_id`,
      [
        q.currency,
        new Date(q.from).toISOString(),
        new Date(q.to).toISOString(),
        q.recordedBefore === null ? null : new Date(q.recordedBefore).toISOString(),
        JSON.stringify(q.userIds),
      ],
    );
    return Object.fromEntries(rows.map((r) => [String(r.user_id), num(r.score)]));
  }

  async ping(): Promise<void> {
    await this.db.query("select 1");
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}
