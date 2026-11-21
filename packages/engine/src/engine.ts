import { randomUUID } from "node:crypto";
import { levelFor, resolveConfig, type ResolvedConfig, type ResolvedLeague, type OnstreakConfig } from "./config.js";
import { currentRound, nextTier, outcomeFor, roundFromKey, zoneFor, type LeagueOutcome, type LeagueRound, type LeagueZone } from "./leagues.js";
import { initialStreak, recordActivity, streakStatus, type StreakState, type StreakStatus } from "./streaks.js";
import { FriendLimitError, type EventRecord, type LeaderboardEntry, type Membership, type ProfileData, type ProfilePatch, type PublicProfile, type Store, type UserTx } from "./store/types.js";
import { isValidTimeZone, leaderboardWindow, periodKey, type LeaderboardPeriod } from "./time.js";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface TrackInput {
  userId: string;
  event: string;
  /** How much happened (minutes, steps, lessons). Default 1. */
  value?: number;
  /** ISO string or epoch ms. Default now. */
  timestamp?: string | number;
  /** IANA zone the user is in, for streak days. Default from config. */
  timezone?: string;
  /** Retries with the same key return the first result instead of counting twice. */
  idempotencyKey?: string;
}

export interface TrackResult {
  eventId: string;
  userId: string;
  event: string;
  value: number;
  duplicate: boolean;
  points: Record<string, { awarded: number; total: number }>;
  level: { current: number; previous: number; leveledUp: boolean } | null;
  streaks: Record<string, { current: number; longest: number; freezes: number; extended: boolean; freezesUsed: number; reset: boolean }>;
  achievements: Array<{ id: string; name: string; description?: string }>;
  /** Leagues this event counted toward. `joined` is true the first time in a round. */
  leagues: Record<string, { tier: string; group: number; joined: boolean; previous: LeaguePrevious | null }>;
}

/** How the user's last finished round of a league ended. */
export interface LeaguePrevious {
  round: string;
  tier: string;
  rank: number;
  outcome: LeagueOutcome;
  nextTier: string;
}

/** A ranked user, with the name and avatar they chose (null if none). */
export interface RankedUser extends LeaderboardEntry {
  displayName: string | null;
  avatarUrl: string | null;
}

export interface LeagueStatus {
  id: string;
  /** The tier the user is in now (or will join in when they next earn points). */
  tier: string;
  tiers: string[];
  round: { key: string; startsAt: string; endsAt: string };
  /** The user's group this round, or null if they have not earned points yet this round. */
  group: { number: number; size: number; entries: Array<RankedUser & { zone: LeagueZone }> } | null;
  you: (RankedUser & { zone: LeagueZone }) | null;
  previous: LeaguePrevious | null;
}

export interface UserProfile {
  userId: string;
  profile: ProfileData;
  points: Record<string, number>;
  /** startsAt: points where the current level began; nextAt: points for the next one (null at max). */
  level: { current: number; points: number; startsAt: number; nextAt: number | null } | null;
  metrics: Record<string, number>;
  streaks: Record<string, { current: number; longest: number; freezes: number; lastPeriod: string | null; status: StreakStatus }>;
  achievements: Array<{ id: string; name: string; description?: string; unlockedAt: string }>;
}

export type LeaderboardScope = "all" | "friends";

export interface LeaderboardResult {
  id: string;
  currency: string;
  period: LeaderboardPeriod;
  scope: LeaderboardScope;
  from: string | null;
  to: string | null;
  entries: RankedUser[];
  user: RankedUser | null;
}

export interface EventHistory {
  events: Array<{
    id: string;
    event: string;
    value: number;
    timestamp: string;
    recordedAt: string;
    /** What the event awarded, as returned by track(). */
    result: TrackResult | null;
  }>;
  /** Pass as `cursor` to get the next (older) page, or null at the end. */
  nextCursor: string | null;
}

export interface FriendList {
  userId: string;
  friends: Array<{ userId: string; displayName: string | null; avatarUrl: string | null; since: string }>;
}

export type BatchItemResult = { ok: true; result: TrackResult } | { ok: false; status: number; error: string };

const USER_ID = /^[^\s]{1,128}$/;
const EVENT_KEY = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const MAX_LIMIT = 100;
export const MAX_BATCH = 100;
const MAX_METADATA_BYTES = 8 * 1024;
const PROFILE_FIELDS = new Set(["displayName", "avatarUrl", "metadata", "timezone"]);

function encodeCursor(e: { ts: number; id: string }): string {
  return Buffer.from(`${e.ts}:${e.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { ts: number; id: string } {
  const [ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  const n = Number(ts);
  if (!Number.isFinite(n) || !id || !/^[0-9a-f-]{36}$/.test(id)) throw new EngineError("cursor is not valid");
  return { ts: n, id };
}

/** Check a profile patch and return a clean copy. */
function validateProfilePatch(input: unknown): ProfilePatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EngineError("body must be a JSON object");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!PROFILE_FIELDS.has(key)) throw new EngineError(`unknown field "${key}" (allowed: displayName, avatarUrl, metadata, timezone)`);
  }
  const patch: ProfilePatch = {};
  if ("displayName" in raw) {
    const v = raw.displayName;
    if (v === null) patch.displayName = null;
    else if (typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 80) patch.displayName = v.trim();
    else throw new EngineError("displayName must be 1-80 characters, or null");
  }
  if ("avatarUrl" in raw) {
    const v = raw.avatarUrl;
    if (v === null) patch.avatarUrl = null;
    else {
      let ok = false;
      if (typeof v === "string" && v.length <= 2048) {
        try {
          ok = ["http:", "https:"].includes(new URL(v).protocol);
        } catch {
          ok = false;
        }
      }
      if (!ok) throw new EngineError("avatarUrl must be an http(s) URL of at most 2048 characters, or null");
      patch.avatarUrl = v as string;
    }
  }
  if ("metadata" in raw) {
    const v = raw.metadata;
    if (v === null) patch.metadata = null;
    else if (typeof v === "object" && !Array.isArray(v)) {
      if (Buffer.byteLength(JSON.stringify(v)) > MAX_METADATA_BYTES) throw new EngineError("metadata must be at most 8 KB of JSON");
      patch.metadata = v as Record<string, unknown>;
    } else throw new EngineError("metadata must be a JSON object, or null");
  }
  if ("timezone" in raw) {
    const v = raw.timezone;
    if (v === null) patch.timezone = null;
    else if (typeof v === "string" && isValidTimeZone(v)) patch.timezone = v;
    else throw new EngineError(`unknown timezone "${String(v)}"`);
  }
  return patch;
}

export class Engine {
  readonly config: ResolvedConfig;

  constructor(
    config: OnstreakConfig,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.config = resolveConfig(config);
  }

  async track(input: TrackInput): Promise<TrackResult> {
    const { userId, event } = input ?? ({} as TrackInput);
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces (max 128 chars)");
    if (typeof event !== "string" || !EVENT_KEY.test(event)) throw new EngineError("event must be 1-64 letters, digits, _ . : -");
    const value = input.value ?? 1;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new EngineError("value must be a positive number");
    const ts = input.timestamp === undefined ? this.now() : new Date(input.timestamp).getTime();
    if (!Number.isFinite(ts)) throw new EngineError("timestamp must be an ISO date or epoch milliseconds");
    if (input.timezone !== undefined && (typeof input.timezone !== "string" || !isValidTimeZone(input.timezone))) {
      throw new EngineError(`unknown timezone "${String(input.timezone)}"`);
    }
    const idempotencyKey = input.idempotencyKey ?? null;
    if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
      throw new EngineError("idempotencyKey must be a string of 1-200 characters");
    }

    const { config } = this;
    return this.store.withUser(userId, async (tx) => {
      if (idempotencyKey) {
        const previous = await tx.findByIdempotencyKey(idempotencyKey);
        if (previous) return { ...previous, duplicate: true };
      }

      // Streak days use the zone sent with the event, else the one remembered
      // for this user, else the config default. A zone sent with an event is remembered.
      const profile = await tx.getProfile();
      if (input.timezone && input.timezone !== profile.timezone) await tx.updateProfile({ timezone: input.timezone });
      const timezone = input.timezone ?? profile.timezone ?? config.defaultTimezone;

      const recordedAt = this.now();
      const eventId = randomUUID();
      await tx.insertEvent({ id: eventId, userId, key: event, value, ts, recordedAt, idempotencyKey });
      const metrics = new Map<string, number>([[event, await tx.addMetric(event, value)]]);

      const levelBefore = config.levels ? levelFor(config.levels, await tx.getBalance(config.levels.currency)) : null;

      const points: TrackResult["points"] = {};
      for (const rule of config.points) {
        if (rule.event !== event) continue;
        const amount = rule.multiplyByValue ? rule.amount * value : rule.amount;
        if (amount === 0) continue;
        const total = await tx.addPoints(rule.currency, amount, ts, eventId, recordedAt);
        const entry = points[rule.currency] ?? { awarded: 0, total };
        entry.awarded += amount;
        entry.total = total;
        points[rule.currency] = entry;
      }

      const streaks: TrackResult["streaks"] = {};
      const streakStates = new Map<string, StreakState>();
      for (const rule of config.streaks) {
        if (rule.event !== event) continue;
        const prev = (await tx.getStreak(rule.id)) ?? initialStreak(rule);
        const update = recordActivity(rule, prev, periodKey(ts, rule.period, timezone));
        if (update.extended) await tx.setStreak(rule.id, update.state);
        streakStates.set(rule.id, update.state);
        streaks[rule.id] = {
          current: update.state.current,
          longest: update.state.longest,
          freezes: update.state.freezes,
          extended: update.extended,
          freezesUsed: update.freezesUsed,
          reset: update.reset,
        };
      }

      const achievements: TrackResult["achievements"] = [];
      if (config.achievements.length > 0) {
        const unlocked = await tx.unlockedAchievements();
        for (const a of config.achievements) {
          if (unlocked.has(a.id)) continue;
          let progress: number;
          if ("metric" in a.when) {
            progress = metrics.get(a.when.metric) ?? (await tx.getMetric(a.when.metric));
          } else if ("streak" in a.when) {
            progress = (streakStates.get(a.when.streak) ?? (await tx.getStreak(a.when.streak)))?.current ?? 0;
          } else {
            progress = await tx.getBalance(a.when.points);
          }
          if (progress >= a.when.gte) {
            await tx.unlock(a.id, ts);
            achievements.push({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}) });
          }
        }
      }

      let level: TrackResult["level"] = null;
      if (config.levels && levelBefore !== null) {
        const current = levelFor(config.levels, await tx.getBalance(config.levels.currency));
        level = { current, previous: levelBefore, leveledUp: current > levelBefore };
      }

      const leagues: TrackResult["leagues"] = {};
      const now = recordedAt;
      for (const league of config.leagues) {
        if ((points[league.currency]?.awarded ?? 0) <= 0) continue;
        // Only points earned in the round that is running now count toward a league.
        if (currentRound(league, ts).key !== currentRound(league, now).key) continue;
        const seat = await this.seat(tx, userId, league, now, ts);
        if (seat.current) {
          leagues[league.id] = { tier: seat.tier, group: seat.current.group, joined: seat.joined, previous: seat.joined ? seat.previous : null };
        }
      }

      const result: TrackResult = { eventId, userId, event, value, duplicate: false, points, level, streaks, achievements, leagues };
      await tx.setEventResult(eventId, result);
      return result;
    });
  }

  async getUser(userId: string, options: { timezone?: string } = {}): Promise<UserProfile> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    if (options.timezone !== undefined && !isValidTimeZone(options.timezone)) throw new EngineError(`unknown timezone "${options.timezone}"`);

    const snap = await this.store.snapshot(userId);
    const timezone = options.timezone ?? snap.profile.timezone ?? this.config.defaultTimezone;
    const points: Record<string, number> = {};
    for (const c of this.config.currencies) points[c] = snap.balances[c] ?? 0;

    let level: UserProfile["level"] = null;
    if (this.config.levels) {
      const total = points[this.config.levels.currency] ?? 0;
      level = {
        current: levelFor(this.config.levels, total),
        points: total,
        startsAt: [...this.config.levels.thresholds].reverse().find((t) => t <= total) ?? 0,
        nextAt: this.config.levels.thresholds.find((t) => t > total) ?? null,
      };
    }

    const now = this.now();
    const streaks: UserProfile["streaks"] = {};
    for (const rule of this.config.streaks) {
      const state = snap.streaks[rule.id] ?? initialStreak(rule);
      streaks[rule.id] = streakStatus(rule, state, periodKey(now, rule.period, timezone));
    }

    const names = new Map(this.config.achievements.map((a) => [a.id, a]));
    const achievements = snap.achievements
      .filter((a) => names.has(a.id))
      .map((a) => {
        const rule = names.get(a.id)!;
        return { id: a.id, name: rule.name, ...(rule.description ? { description: rule.description } : {}), unlockedAt: a.unlockedAt };
      });

    return { userId, profile: snap.profile, points, level, metrics: snap.metrics, streaks, achievements };
  }

  /**
   * Top entries for the current window. With `scope: "friends"`, only the user
   * and their friends are ranked, and friends with no points yet are included.
   */
  async leaderboard(id: string, options: { limit?: number; userId?: string; scope?: LeaderboardScope } = {}): Promise<LeaderboardResult> {
    const rule = this.config.leaderboards.find((l) => l.id === id);
    if (!rule) throw new EngineError(`unknown leaderboard "${id}"`, 404);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const scope = options.scope ?? "all";
    if (scope !== "all" && scope !== "friends") throw new EngineError('scope must be "all" or "friends"');
    if (scope === "friends" && !options.userId) throw new EngineError("a friends leaderboard needs userId");
    const { from, to } = leaderboardWindow(rule.period, this.now(), rule.timezone ?? "UTC");

    let entries: LeaderboardEntry[];
    let user: LeaderboardEntry | null;
    if (scope === "friends") {
      const userId = options.userId as string;
      const ids = [userId, ...(await this.store.friends(userId)).map((f) => f.userId)];
      const scored = await this.store.leaderboard({ currency: rule.currency, from, to, limit: ids.length, userIds: ids });
      const scores = new Map(scored.entries.map((e) => [e.userId, e.score]));
      const ranked = rankScores(ids.map((u) => ({ userId: u, score: scores.get(u) ?? 0 })));
      entries = ranked.slice(0, limit);
      user = ranked.find((e) => e.userId === userId) ?? null;
    } else {
      ({ entries, user } = await this.store.leaderboard({
        currency: rule.currency,
        from,
        to,
        limit,
        ...(options.userId ? { userId: options.userId } : {}),
      }));
    }
    const names = await this.store.profiles([...new Set([...entries, ...(user ? [user] : [])].map((e) => e.userId))]);
    return {
      id: rule.id,
      currency: rule.currency,
      period: rule.period,
      scope,
      from: from === null ? null : new Date(from).toISOString(),
      to: to === null ? null : new Date(to).toISOString(),
      entries: entries.map((e) => withProfile(e, names)),
      user: user ? withProfile(user, names) : null,
    };
  }

  /** Make two users friends. Friendship is mutual. Users that do not exist yet are created. */
  async addFriend(userId: string, friendId: string): Promise<{ userId: string; friendId: string; created: boolean }> {
    this.checkPair(userId, friendId);
    try {
      const created = await this.store.addFriendship(userId, friendId, this.now(), this.config.friends.max);
      return { userId, friendId, created };
    } catch (err) {
      if (err instanceof FriendLimitError) {
        throw new EngineError(`${err.userId} already has the maximum of ${this.config.friends.max} friends`, 409);
      }
      throw err;
    }
  }

  /** End a friendship, for both users. */
  async removeFriend(userId: string, friendId: string): Promise<{ userId: string; friendId: string; removed: boolean }> {
    this.checkPair(userId, friendId);
    return { userId, friendId, removed: await this.store.removeFriendship(userId, friendId) };
  }

  /** A user's friends, newest first, with their names and avatars. */
  async friends(userId: string): Promise<FriendList> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const friends = await this.store.friends(userId);
    return {
      userId,
      friends: friends.map((f) => ({ userId: f.userId, displayName: f.displayName, avatarUrl: f.avatarUrl, since: new Date(f.since).toISOString() })),
    };
  }

  private checkPair(userId: string, friendId: string): void {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    if (typeof friendId !== "string" || !USER_ID.test(friendId)) throw new EngineError("friendId must be a non-empty string without spaces");
    if (userId === friendId) throw new EngineError("a user cannot be their own friend");
  }

  /** Throws if the store (database) cannot be reached. */
  async ping(): Promise<void> {
    await this.store.ping();
  }

  /** Release the store's connections. Call once, when shutting down. */
  async close(): Promise<void> {
    await this.store.close();
  }

  /** A user's tier, their group's live standings this round, and how last round ended. */
  async league(id: string, userId: string): Promise<LeagueStatus> {
    const league = this.config.leagues.find((l) => l.id === id);
    if (!league) throw new EngineError(`unknown league "${id}"`, 404);
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const now = this.now();

    const status = await this.store.withUser(userId, async (tx): Promise<LeagueStatus> => {
      const seat = await this.seat(tx, userId, league, now, null);
      let group: LeagueStatus["group"] = null;
      if (seat.current) {
        const standings = await tx.groupStandings({
          leagueId: league.id,
          roundKey: seat.round.key,
          tier: seat.current.tier,
          group: seat.current.group,
          currency: league.currency,
          from: seat.round.from,
          to: seat.round.to,
          recordedBefore: null,
        });
        const tierIndex = league.tiers.indexOf(seat.current.tier);
        group = {
          number: seat.current.group,
          size: standings.length,
          entries: standings.map((m, i) => ({
            rank: i + 1,
            userId: m.userId,
            score: m.score,
            displayName: null,
            avatarUrl: null,
            zone: zoneFor(league, tierIndex, i + 1, standings.length),
          })),
        };
      }
      return {
        id: league.id,
        tier: seat.tier,
        tiers: league.tiers,
        round: { key: seat.round.key, startsAt: new Date(seat.round.from).toISOString(), endsAt: new Date(seat.round.to).toISOString() },
        group,
        you: null,
        previous: seat.previous,
      };
    });
    // Names are looked up after the transaction: they are not part of the lock.
    if (status.group) {
      const names = await this.store.profiles(status.group.entries.map((e) => e.userId));
      status.group.entries = status.group.entries.map((e) => withProfile(e, names));
      status.you = status.group.entries.find((e) => e.userId === userId) ?? null;
    }
    return status;
  }

  /** Set a user's display name, avatar, metadata or time zone. Returns the full profile. */
  async updateUser(userId: string, patch: unknown): Promise<UserProfile> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const clean = validateProfilePatch(patch);
    await this.store.withUser(userId, (tx) => tx.updateProfile(clean));
    return this.getUser(userId);
  }

  /** A user's events, newest first, with what each one awarded. */
  async events(userId: string, options: { limit?: number; cursor?: string } = {}): Promise<EventHistory> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const before = options.cursor ? decodeCursor(options.cursor) : undefined;
    // Fetch one extra to know whether another page exists.
    const rows = await this.store.events(userId, { limit: limit + 1, ...(before ? { before } : {}) });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page.map((e: EventRecord) => ({
        id: e.id,
        event: e.key,
        value: e.value,
        timestamp: new Date(e.ts).toISOString(),
        recordedAt: new Date(e.recordedAt).toISOString(),
        result: e.result,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  /**
   * Track up to 100 events in order. Each is its own transaction: a bad item
   * is reported in place and the rest still count. Use idempotency keys if
   * you might retry a batch.
   */
  async trackBatch(inputs: unknown): Promise<BatchItemResult[]> {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_BATCH) {
      throw new EngineError(`events must be an array of 1 to ${MAX_BATCH} events`);
    }
    const results: BatchItemResult[] = [];
    for (const input of inputs) {
      try {
        results.push({ ok: true, result: await this.track(input as TrackInput) });
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        results.push({ ok: false, status: err.status, error: err.message });
      }
    }
    return results;
  }

  /**
   * Work out where a user sits in a league right now. Settles their last
   * finished round on the way (no background job needed), and when
   * `joinAt` is given, seats them in a group for the current round.
   */
  private async seat(
    tx: UserTx,
    userId: string,
    league: ResolvedLeague,
    now: number,
    joinAt: number | null,
  ): Promise<{ round: LeagueRound; tier: string; current: Membership | null; previous: LeaguePrevious | null; joined: boolean }> {
    const round = currentRound(league, now);
    const [latest, before] = await tx.getMemberships(league.id, 2);

    if (latest && latest.roundKey >= round.key) {
      const previous = before ? await this.settle(tx, userId, league, before) : null;
      return { round, tier: latest.tier, current: latest, previous, joined: false };
    }

    const previous = latest ? await this.settle(tx, userId, league, latest) : null;
    const tier = previous ? previous.nextTier : (league.tiers[0] as string);
    if (joinAt === null) return { round, tier, current: null, previous, joined: false };

    const group = await tx.joinLeague(league.id, round.key, tier, league.groupSize, joinAt);
    const current: Membership = { leagueId: league.id, roundKey: round.key, tier, group, joinedAt: joinAt, outcome: null, finalRank: null, nextTier: null };
    return { round, tier, current, previous, joined: true };
  }

  /** Final result of a finished round, computed once and then stored. */
  private async settle(tx: UserTx, userId: string, league: ResolvedLeague, m: Membership): Promise<LeaguePrevious> {
    if (m.outcome && m.finalRank !== null && m.nextTier) {
      return { round: m.roundKey, tier: m.tier, rank: m.finalRank, outcome: m.outcome, nextTier: m.nextTier };
    }
    const r = roundFromKey(league, m.roundKey);
    const standings = await tx.groupStandings({
      leagueId: league.id,
      roundKey: m.roundKey,
      tier: m.tier,
      group: m.group,
      currency: league.currency,
      from: r.from,
      to: r.to,
      // Points recorded after the round ended (backfilled events) never change its result.
      recordedBefore: r.to,
    });
    const index = standings.findIndex((s) => s.userId === userId);
    const rank = index === -1 ? standings.length + 1 : index + 1;
    const size = Math.max(standings.length, rank);
    const outcome = outcomeFor(league, league.tiers.indexOf(m.tier), rank, size);
    const next = nextTier(league, m.tier, outcome);
    await tx.settleMembership(league.id, m.roundKey, { outcome, finalRank: rank, nextTier: next });
    return { round: m.roundKey, tier: m.tier, rank, outcome, nextTier: next };
  }
}

function withProfile<T extends LeaderboardEntry>(entry: T, names: Record<string, PublicProfile>): T & RankedUser {
  const p = names[entry.userId];
  return { ...entry, displayName: p?.displayName ?? null, avatarUrl: p?.avatarUrl ?? null };
}

/** Highest first, ties share a rank (1, 2, 2, 4), then by user id for a stable order. */
function rankScores(rows: Array<{ userId: string; score: number }>): LeaderboardEntry[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score || (a.userId < b.userId ? -1 : 1));
  const ranked: LeaderboardEntry[] = [];
  sorted.forEach((r, i) => {
    const prev = ranked[i - 1];
    ranked.push({ ...r, rank: prev && prev.score === r.score ? prev.rank : i + 1 });
  });
  return ranked;
}
