import { randomUUID } from "node:crypto";
import { levelFor, resolveConfig, type ResolvedConfig, type OnstreakConfig } from "./config.js";
import { initialStreak, recordActivity, streakStatus, type StreakState, type StreakStatus } from "./streaks.js";
import type { LeaderboardEntry, Store } from "./store/types.js";
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
}

export interface UserProfile {
  userId: string;
  points: Record<string, number>;
  level: { current: number; points: number; nextAt: number | null } | null;
  metrics: Record<string, number>;
  streaks: Record<string, { current: number; longest: number; freezes: number; lastPeriod: string | null; status: StreakStatus }>;
  achievements: Array<{ id: string; name: string; description?: string; unlockedAt: string }>;
}

export interface LeaderboardResult {
  id: string;
  currency: string;
  period: LeaderboardPeriod;
  from: string | null;
  to: string | null;
  entries: LeaderboardEntry[];
  user: LeaderboardEntry | null;
}

const USER_ID = /^[^\s]{1,128}$/;
const EVENT_KEY = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const MAX_LIMIT = 100;

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
    const timezone = input.timezone ?? this.config.defaultTimezone;
    if (!isValidTimeZone(timezone)) throw new EngineError(`unknown timezone "${timezone}"`);
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

      const eventId = randomUUID();
      await tx.insertEvent({ id: eventId, userId, key: event, value, ts, idempotencyKey });
      const metrics = new Map<string, number>([[event, await tx.addMetric(event, value)]]);

      const levelBefore = config.levels ? levelFor(config.levels, await tx.getBalance(config.levels.currency)) : null;

      const points: TrackResult["points"] = {};
      for (const rule of config.points) {
        if (rule.event !== event) continue;
        const amount = rule.multiplyByValue ? rule.amount * value : rule.amount;
        if (amount === 0) continue;
        const total = await tx.addPoints(rule.currency, amount, ts, eventId);
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

      const result: TrackResult = { eventId, userId, event, value, duplicate: false, points, level, streaks, achievements };
      await tx.setEventResult(eventId, result);
      return result;
    });
  }

  async getUser(userId: string, options: { timezone?: string } = {}): Promise<UserProfile> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const timezone = options.timezone ?? this.config.defaultTimezone;
    if (!isValidTimeZone(timezone)) throw new EngineError(`unknown timezone "${timezone}"`);

    const snap = await this.store.snapshot(userId);
    const points: Record<string, number> = {};
    for (const c of this.config.currencies) points[c] = snap.balances[c] ?? 0;

    let level: UserProfile["level"] = null;
    if (this.config.levels) {
      const total = points[this.config.levels.currency] ?? 0;
      level = {
        current: levelFor(this.config.levels, total),
        points: total,
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

    return { userId, points, level, metrics: snap.metrics, streaks, achievements };
  }

  async leaderboard(id: string, options: { limit?: number; userId?: string } = {}): Promise<LeaderboardResult> {
    const rule = this.config.leaderboards.find((l) => l.id === id);
    if (!rule) throw new EngineError(`unknown leaderboard "${id}"`, 404);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const { from, to } = leaderboardWindow(rule.period, this.now(), rule.timezone ?? "UTC");
    const { entries, user } = await this.store.leaderboard({
      currency: rule.currency,
      from,
      to,
      limit,
      ...(options.userId ? { userId: options.userId } : {}),
    });
    return {
      id: rule.id,
      currency: rule.currency,
      period: rule.period,
      from: from === null ? null : new Date(from).toISOString(),
      to: to === null ? null : new Date(to).toISOString(),
      entries,
      user,
    };
  }
}
