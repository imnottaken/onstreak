import { isValidTimeZone, type LeaderboardPeriod, type StreakPeriod } from "./time.js";

export interface PointRule {
  /** Event key that earns points, e.g. "lesson_completed". */
  event: string;
  currency: string;
  amount: number;
  /** Multiply `amount` by the event's value (e.g. minutes studied). */
  multiplyByValue?: boolean;
}

export interface StreakRule {
  id: string;
  event: string;
  period: StreakPeriod;
  freezes?: {
    /** Freezes a new user starts with. */
    start?: number;
    /** Most freezes a user can hold. */
    max?: number;
    /** Earn one freeze every N periods of streak. */
    earnEvery?: number;
  };
}

export type AchievementCondition =
  | { metric: string; gte: number }
  | { streak: string; gte: number }
  | { points: string; gte: number };

export interface AchievementRule {
  id: string;
  name: string;
  description?: string;
  when: AchievementCondition;
}

export interface LeaderboardRule {
  id: string;
  currency: string;
  period: LeaderboardPeriod;
  /** Time zone that defines where days, weeks and months start. Default UTC. */
  timezone?: string;
}

export interface LevelConfig {
  currency: string;
  /** Points needed to reach level 2, 3, 4, ... in ascending order. */
  thresholds: number[];
}

export interface LeagueRule {
  id: string;
  /** Points in this currency decide the standings. */
  currency: string;
  /** Lowest to highest, e.g. ["bronze", "silver", "gold"]. Everyone starts in the first. */
  tiers: string[];
  /** Members per group. Default 30. */
  groupSize?: number;
  /** How many move up from each group when the period ends. Default 7. */
  promote?: number;
  /** How many move down from each group when the period ends. Default 5. */
  demote?: number;
  /** How long a round lasts. Default weekly. */
  period?: StreakPeriod;
  /** Time zone where rounds start and end. Default UTC. */
  timezone?: string;
}

export interface RivalryRule {
  id: string;
  /** Points in this currency decide each round. */
  currency: string;
  /** How long a round lasts. Default weekly. */
  period?: StreakPeriod;
  /** Time zone where rounds start and end. Default UTC. */
  timezone?: string;
  /** Most rivals one user can have in this rivalry. Default 10. */
  max?: number;
}

export interface ResolvedRivalry {
  id: string;
  currency: string;
  period: StreakPeriod;
  timezone: string;
  max: number;
}

export interface OnstreakConfig {
  /** Time zone used for streaks when an event does not say. Default UTC. */
  defaultTimezone?: string;
  currencies: string[];
  points?: PointRule[];
  levels?: LevelConfig;
  streaks?: StreakRule[];
  achievements?: AchievementRule[];
  leaderboards?: LeaderboardRule[];
  leagues?: LeagueRule[];
  rivalries?: RivalryRule[];
  friends?: {
    /** Most friends one user can have. Default 1000. */
    max?: number;
  };
}

/** A league with every default filled in. */
export interface ResolvedLeague {
  id: string;
  currency: string;
  tiers: string[];
  groupSize: number;
  promote: number;
  demote: number;
  period: StreakPeriod;
  timezone: string;
}

/** Normalized config with every optional list present. */
export interface ResolvedConfig {
  defaultTimezone: string;
  currencies: string[];
  points: PointRule[];
  levels: LevelConfig | null;
  streaks: StreakRule[];
  achievements: AchievementRule[];
  leaderboards: LeaderboardRule[];
  leagues: ResolvedLeague[];
  rivalries: ResolvedRivalry[];
  friends: { max: number };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid onstreak config: ${message}`);
    this.name = "ConfigError";
  }
}

const ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const STREAK_PERIODS: readonly string[] = ["daily", "weekly"];
const BOARD_PERIODS: readonly string[] = ["daily", "weekly", "monthly", "all"];

function isNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function uniqueIds(kind: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !ID.test(id)) throw new ConfigError(`${kind} id "${id}" must be 1-64 letters, digits, _ . : -`);
    if (seen.has(id)) throw new ConfigError(`duplicate ${kind} id "${id}"`);
    seen.add(id);
  }
}

export function resolveConfig(input: OnstreakConfig): ResolvedConfig {
  if (!input || typeof input !== "object") throw new ConfigError("config must be an object");
  const defaultTimezone = input.defaultTimezone ?? "UTC";
  if (!isValidTimeZone(defaultTimezone)) throw new ConfigError(`unknown defaultTimezone "${defaultTimezone}"`);

  const currencies = input.currencies ?? [];
  if (!Array.isArray(currencies) || currencies.length === 0) throw new ConfigError("currencies needs at least one entry, e.g. [\"xp\"]");
  uniqueIds("currency", currencies);
  const hasCurrency = (c: string, where: string) => {
    if (!currencies.includes(c)) throw new ConfigError(`${where} uses unknown currency "${c}"`);
  };

  const points = input.points ?? [];
  for (const rule of points) {
    if (typeof rule.event !== "string" || !ID.test(rule.event)) throw new ConfigError(`point rule has bad event "${rule.event}"`);
    hasCurrency(rule.currency, `point rule for "${rule.event}"`);
    if (typeof rule.amount !== "number" || !Number.isFinite(rule.amount)) throw new ConfigError(`point rule for "${rule.event}" needs a numeric amount`);
  }

  let levels: LevelConfig | null = null;
  if (input.levels) {
    hasCurrency(input.levels.currency, "levels");
    const t = input.levels.thresholds;
    if (!Array.isArray(t) || t.length === 0 || !t.every(isNonNegative)) throw new ConfigError("levels.thresholds must be non-negative numbers");
    for (let i = 1; i < t.length; i++) {
      if ((t[i] as number) <= (t[i - 1] as number)) throw new ConfigError("levels.thresholds must be strictly ascending");
    }
    levels = { currency: input.levels.currency, thresholds: [...t] };
  }

  const streaks = input.streaks ?? [];
  uniqueIds("streak", streaks.map((s) => s.id));
  for (const s of streaks) {
    if (typeof s.event !== "string" || !ID.test(s.event)) throw new ConfigError(`streak "${s.id}" has bad event "${s.event}"`);
    if (!STREAK_PERIODS.includes(s.period)) throw new ConfigError(`streak "${s.id}" period must be daily or weekly`);
    const f = s.freezes;
    if (f) {
      for (const key of ["start", "max", "earnEvery"] as const) {
        if (f[key] !== undefined && !(isNonNegative(f[key]) && Number.isInteger(f[key]))) {
          throw new ConfigError(`streak "${s.id}" freezes.${key} must be a whole number`);
        }
      }
      if ((f.start ?? 0) > (f.max ?? 0)) throw new ConfigError(`streak "${s.id}" freezes.start cannot exceed freezes.max`);
    }
  }

  const achievements = input.achievements ?? [];
  uniqueIds("achievement", achievements.map((a) => a.id));
  for (const a of achievements) {
    if (typeof a.name !== "string" || a.name.length === 0) throw new ConfigError(`achievement "${a.id}" needs a name`);
    const w = a.when as Record<string, unknown> | undefined;
    const kinds = w ? ["metric", "streak", "points"].filter((k) => k in w) : [];
    if (kinds.length !== 1 || !isNonNegative(w?.gte)) {
      throw new ConfigError(`achievement "${a.id}" needs when: { metric | streak | points, gte }`);
    }
    if ("streak" in a.when && !streaks.some((s) => s.id === (a.when as { streak: string }).streak)) {
      throw new ConfigError(`achievement "${a.id}" refers to unknown streak "${a.when.streak}"`);
    }
    if ("points" in a.when) hasCurrency(a.when.points, `achievement "${a.id}"`);
  }

  const leaderboards = input.leaderboards ?? [];
  uniqueIds("leaderboard", leaderboards.map((l) => l.id));
  for (const l of leaderboards) {
    hasCurrency(l.currency, `leaderboard "${l.id}"`);
    if (!BOARD_PERIODS.includes(l.period)) throw new ConfigError(`leaderboard "${l.id}" period must be daily, weekly, monthly or all`);
    if (l.timezone && !isValidTimeZone(l.timezone)) throw new ConfigError(`leaderboard "${l.id}" has unknown timezone "${l.timezone}"`);
  }

  const leagues: ResolvedLeague[] = [];
  uniqueIds("league", (input.leagues ?? []).map((l) => l.id));
  for (const l of input.leagues ?? []) {
    hasCurrency(l.currency, `league "${l.id}"`);
    if (!Array.isArray(l.tiers) || l.tiers.length < 2) throw new ConfigError(`league "${l.id}" needs at least two tiers`);
    uniqueIds(`tier in league "${l.id}"`, l.tiers);
    const resolved: ResolvedLeague = {
      id: l.id,
      currency: l.currency,
      tiers: [...l.tiers],
      groupSize: l.groupSize ?? 30,
      promote: l.promote ?? 7,
      demote: l.demote ?? 5,
      period: l.period ?? "weekly",
      timezone: l.timezone ?? "UTC",
    };
    for (const key of ["groupSize", "promote", "demote"] as const) {
      if (!Number.isInteger(resolved[key]) || resolved[key] < 0) throw new ConfigError(`league "${l.id}" ${key} must be a whole number`);
    }
    if (resolved.groupSize < 2 || resolved.groupSize > 1000) throw new ConfigError(`league "${l.id}" groupSize must be 2 to 1000`);
    if (resolved.promote + resolved.demote > resolved.groupSize) {
      throw new ConfigError(`league "${l.id}" promote + demote cannot exceed groupSize`);
    }
    if (!STREAK_PERIODS.includes(resolved.period)) throw new ConfigError(`league "${l.id}" period must be daily or weekly`);
    if (!isValidTimeZone(resolved.timezone)) throw new ConfigError(`league "${l.id}" has unknown timezone "${resolved.timezone}"`);
    leagues.push(resolved);
  }

  const rivalries: ResolvedRivalry[] = [];
  uniqueIds("rivalry", (input.rivalries ?? []).map((r) => r.id));
  for (const r of input.rivalries ?? []) {
    hasCurrency(r.currency, `rivalry "${r.id}"`);
    const resolved: ResolvedRivalry = {
      id: r.id,
      currency: r.currency,
      period: r.period ?? "weekly",
      timezone: r.timezone ?? "UTC",
      max: r.max ?? 10,
    };
    if (!STREAK_PERIODS.includes(resolved.period)) throw new ConfigError(`rivalry "${r.id}" period must be daily or weekly`);
    if (!isValidTimeZone(resolved.timezone)) throw new ConfigError(`rivalry "${r.id}" has unknown timezone "${resolved.timezone}"`);
    if (!Number.isInteger(resolved.max) || resolved.max < 1 || resolved.max > 1000) throw new ConfigError(`rivalry "${r.id}" max must be a whole number from 1 to 1000`);
    rivalries.push(resolved);
  }

  const maxFriends = input.friends?.max ?? 1000;
  if (!Number.isInteger(maxFriends) || maxFriends < 1 || maxFriends > 100_000) {
    throw new ConfigError("friends.max must be a whole number from 1 to 100000");
  }

  return {
    defaultTimezone,
    currencies: [...currencies],
    points,
    levels,
    streaks,
    achievements,
    leaderboards,
    leagues,
    rivalries,
    friends: { max: maxFriends },
  };
}

/** Level for a points total: 1 plus every threshold reached. */
export function levelFor(levels: LevelConfig, total: number): number {
  let level = 1;
  for (const t of levels.thresholds) if (total >= t) level++;
  return level;
}
