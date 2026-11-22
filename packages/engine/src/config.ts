import { isValidTimeZone, type LeaderboardPeriod, type StreakPeriod } from "./time.js";

/** A test on one event property: equal to a value, one of a list, or within a range. */
export type PropertyMatch = string | number | boolean | { in?: Array<string | number>; gte?: number; lte?: number };

/** Event properties that must match for a rule to apply, e.g. { difficulty: "hard", score: { gte: 80 } }. */
export type Where = Record<string, PropertyMatch>;

export function matchesWhere(where: Where | undefined, props: Record<string, string | number | boolean> | null | undefined): boolean {
  if (!where) return true;
  for (const [key, test] of Object.entries(where)) {
    const v = props?.[key];
    if (v === undefined) return false;
    if (test !== null && typeof test === "object") {
      if (test.in !== undefined && !test.in.includes(v as string | number)) return false;
      if ((test.gte !== undefined || test.lte !== undefined) && typeof v !== "number") return false;
      if (test.gte !== undefined && (v as number) < test.gte) return false;
      if (test.lte !== undefined && (v as number) > test.lte) return false;
    } else if (v !== test) return false;
  }
  return true;
}

export interface PointRule {
  /** Event key that earns points, e.g. "lesson_completed". */
  event: string;
  currency: string;
  amount: number;
  /** Multiply `amount` by the event's value (e.g. minutes studied). */
  multiplyByValue?: boolean;
  /** Multiply `amount` by this numeric event property instead (e.g. "score"). Events without it earn nothing. */
  multiplyBy?: string;
  /** Only events whose properties match. */
  where?: Where;
}

export interface StreakRule {
  id: string;
  event: string;
  /** Only events whose properties match count. */
  where?: Where;
  period: StreakPeriod | "monthly";
  /** Weekly streaks: the day weeks start on. Default "monday". */
  weekStartsOn?: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
  freezes?: {
    /** Freezes a new user starts with. */
    start?: number;
    /** Most freezes a user can hold. */
    max?: number;
    /** Earn one freeze every N periods of streak. */
    earnEvery?: number;
  };
  /**
   * Let users repair the streak within `withinHours` of it breaking, before
   * they start a new one, optionally for a price taken from their wallet.
   */
  repair?: { withinHours: number; cost?: { currency: string; amount: number } };
  /** A period only counts once the event's values add up to this ("at least 3 lessons a day"). Default: any activity. */
  minimum?: number;
  /** Daily streaks only: Saturdays and Sundays are never counted as missed (activity on them still counts). */
  skipWeekends?: boolean;
}

/**
 * One measured value. `gte` is the target (leave it out at the top of an
 * achievement with `tiers`). `within` counts only the current day, week or
 * month in the user's time zone ("5 lessons in one day", "100 XP this week").
 */
export type AchievementLeaf =
  | { metric: string; gte?: number; within?: AchievementWindow }
  | { streak: string; gte?: number }
  | { points: string; gte?: number; within?: AchievementWindow };

export type AchievementWindow = "day" | "week" | "month";

/** A value, or several combined: `all` needs every one, `any` needs at least one. */
export type AchievementCondition = AchievementLeaf | { all: AchievementCondition[] } | { any: AchievementCondition[] };

export function isLeaf(c: AchievementCondition): c is AchievementLeaf {
  return !("all" in c) && !("any" in c);
}

export interface AchievementTier {
  /** e.g. "Bronze". */
  name: string;
  gte: number;
  rewards?: QuestReward[];
}

export interface AchievementRule {
  id: string;
  name: string;
  description?: string;
  when: AchievementCondition;
  /** Levels of one badge (bronze, silver, gold), each unlocked on its own. Ascending `gte`. */
  tiers?: AchievementTier[];
  /** Kept secret (no name, description or progress) until unlocked. */
  hidden?: boolean;
  /** Points paid when it unlocks (for tiered badges, put rewards on each tier). */
  rewards?: QuestReward[];
}

/** One unlockable step of an achievement: the whole achievement, or one of its tiers. */
export interface AchievementLevel {
  /** Stored unlock id: the achievement id, or "id#level" for a tier. */
  key: string;
  gte: number;
  rewards: QuestReward[];
  tier: { level: number; name: string } | null;
}

export function achievementLevels(a: AchievementRule): AchievementLevel[] {
  if (a.tiers) {
    return a.tiers.map((t, i) => ({ key: `${a.id}#${i + 1}`, gte: t.gte, rewards: (t.rewards ?? []).map((r) => ({ ...r })), tier: { level: i + 1, name: t.name } }));
  }
  const gte = isLeaf(a.when) ? a.when.gte! : "all" in a.when ? a.when.all.length : 1;
  return [{ key: a.id, gte, rewards: (a.rewards ?? []).map((r) => ({ ...r })), tier: null }];
}

export interface LeaderboardRule {
  id: string;
  currency: string;
  period: LeaderboardPeriod;
  /** Time zone that defines where days, weeks and months start. Default UTC. */
  timezone?: string;
}

/** Levels as configured: a list of thresholds, or a formula. */
export interface LevelInput {
  currency: string;
  /** Points needed to reach level 2, 3, 4, ... in ascending order. */
  thresholds?: number[];
  /**
   * Instead of thresholds: "linear" needs `step` more points per level
   * (100, 200, 300...); "exponential" needs `base`, then each level `factor`
   * times the last step (100, 150, 225... with factor 1.5). `maxLevel`
   * defaults to 100.
   */
  curve?: { type: "linear"; step: number; maxLevel?: number } | { type: "exponential"; base: number; factor: number; maxLevel?: number };
  /** Points paid when a user reaches a level, e.g. [{ level: 5, rewards: [{ currency: "coins", amount: 50 }] }]. */
  rewards?: Array<{ level: number; rewards: QuestReward[] }>;
  /** Let users at the top level start over at level 1 with a prestige rank, optionally paid `rewards` each time. */
  prestige?: { rewards?: QuestReward[] };
}

export interface LevelConfig {
  currency: string;
  /** Points needed to reach level 2, 3, 4, ... in ascending order. */
  thresholds: number[];
  /** Rewards by level. */
  rewards: Array<{ level: number; rewards: QuestReward[] }>;
  /** Null when prestige is off. */
  prestige?: { rewards: QuestReward[] } | null;
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
  /**
   * When a season (from `seasons`) starts, move everyone back: to the first
   * tier, or down `dropTiers` tiers for a soft reset.
   */
  seasonReset?: true | { dropTiers: number };
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

export type ResolvedMultiplier =
  | { id: string; currency: string | null; kind: "window"; factor: number; from: number; to: number }
  | { id: string; currency: string | null; kind: "streak"; streak: string; steps: Array<{ gte: number; factor: number }> };

export interface ResolvedRivalry {
  id: string;
  currency: string;
  period: StreakPeriod;
  timezone: string;
  max: number;
}

export interface QuestReward {
  currency: string;
  amount: number;
}

export type QuestGoal = { event: string; target: number; where?: Where } | { points: string; target: number };

/** A quest's goals: its single goal, or a mission's list. */
export function questGoals(q: QuestRule): QuestGoal[] {
  return q.goals ?? [q.goal!];
}

export interface QuestRule {
  id: string;
  name: string;
  description?: string;
  /** A new quest every day or week, or "once" for a one-off that never resets. */
  period: StreakPeriod | "once";
  /** Locked until this one-off quest is completed: build chains ("first lesson", then "five lessons", ...). */
  after?: string;
  /**
   * Done when `event` adds up to `target` (event values are summed, so a plain
   * event counts 1), or when `target` points in a currency are earned.
   */
  goal?: QuestGoal;
  /** A mission: done when every one of these goals is reached in the same period. Use instead of `goal`. */
  goals?: QuestGoal[];
  /** Points paid once on completion. */
  rewards?: QuestReward[];
  /** Fix where days start for everyone. Default: each user's own time zone. */
  timezone?: string;
  /** Only run between these ISO dates (a seasonal challenge). Default: always. */
  from?: string;
  to?: string;
}

/**
 * Scales points from point rules. A window applies to events that happen
 * between `from` and `to` ("double XP weekend"); a streak multiplier applies
 * the highest step the user's streak has reached. Several multipliers multiply.
 */
export type MultiplierRule =
  | { id: string; currency?: string; factor: number; from: string; to: string }
  | { id: string; currency?: string; streak: string; steps: Array<{ gte: number; factor: number }> };

/**
 * A login reward calendar: the first `event` each day claims the next day's
 * rewards ("day 1: 5 coins ... day 7: 50 coins"). Missing a day starts over
 * unless `missed` is "continue". After the last day it starts over, or stays
 * on the last day with `afterLast: "stay"`.
 */
export interface CalendarRule {
  id: string;
  name?: string;
  /** The event that claims a day, e.g. "app_opened". */
  event: string;
  days: Array<{ rewards: QuestReward[] }>;
  missed?: "reset" | "continue";
  afterLast?: "repeat" | "stay";
  /** Fix where days start for everyone. Default: each user's own time zone. */
  timezone?: string;
}

/**
 * Rewards for bringing in new users. A referral is recorded once per new user.
 * With `qualify`, nobody is paid until the new user has done enough of an
 * event; otherwise both sides are paid as soon as it is recorded.
 */
export interface ReferralConfig {
  /** Paid to the person who referred. */
  referrer?: QuestReward[];
  /** Paid to the new user. */
  referred?: QuestReward[];
  qualify?: { event: string; target: number };
  /** Most referrals one user is rewarded for. Default: no limit. */
  max?: number;
}

/**
 * A goal everyone works toward together in a time window ("1M minutes this
 * month"). Event goals sum event values, points goals sum points earned.
 * Once reached, everyone who contributed at least `minContribution` can
 * claim `rewards`.
 */
export interface CommunityGoalRule {
  id: string;
  name: string;
  description?: string;
  goal: { event: string; target: number } | { points: string; target: number };
  /** ISO dates: events from `from` up to (not including) `to` count. */
  from: string;
  to: string;
  rewards?: QuestReward[];
  /** Least a user must contribute to share the rewards. Default: anything above 0. */
  minContribution?: number;
}

export interface ResolvedCommunityGoal extends Omit<CommunityGoalRule, "from" | "to"> {
  from: number;
  to: number;
}

/**
 * A named stretch of time with its own standings in one currency. When it
 * ends the standings are fixed, and users who placed in a reward tier get
 * that tier's rewards (only the best tier they reached).
 */
export interface SeasonRule {
  id: string;
  name: string;
  currency: string;
  /** ISO dates: points from `from` up to (not including) `to` count. */
  from: string;
  to: string;
  /** e.g. [{ top: 1, title: "Champion", rewards }, { top: 10, rewards }]. */
  rewards?: Array<{ top: number; title?: string; rewards: QuestReward[] }>;
}

export interface ResolvedSeason extends Omit<SeasonRule, "from" | "to" | "rewards"> {
  from: number;
  to: number;
  /** Best tier first (smallest `top`). */
  rewards: Array<{ top: number; title?: string; rewards: QuestReward[] }>;
}

/**
 * A goal a team reaches together each day or week ("our team: 20 lessons
 * this week"). Members' activity counts from when they joined. Once it is
 * reached, members who contributed are paid `rewards` (on their first look).
 */
export interface TeamGoalRule {
  id: string;
  name: string;
  description?: string;
  period: StreakPeriod;
  goal: QuestGoal;
  rewards?: QuestReward[];
  /** Where days and weeks start. Default: the config's defaultTimezone. */
  timezone?: string;
}

/** A personal multiplier: `factor` on points from point rules for `minutes`. No currency means every currency. */
export interface BoostSpec {
  factor: number;
  minutes: number;
  currency?: string;
}

/** Longest a single boost may last: 30 days. */
export const MAX_BOOST_MINUTES = 30 * 24 * 60;

/** Why a boost spec is invalid, or null if it is fine. */
export function boostSpecProblem(spec: unknown, currencies: string[]): string | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "a boost needs { factor, minutes, currency? }";
  const b = spec as Record<string, unknown>;
  if (typeof b.factor !== "number" || !Number.isFinite(b.factor) || b.factor <= 0 || b.factor > 100) return "boost factor must be above 0 and at most 100";
  if (!Number.isInteger(b.minutes) || (b.minutes as number) < 1 || (b.minutes as number) > MAX_BOOST_MINUTES) return `boost minutes must be a whole number from 1 to ${MAX_BOOST_MINUTES}`;
  if (b.currency !== undefined && (typeof b.currency !== "string" || !currencies.includes(b.currency))) return `boost uses unknown currency "${String(b.currency)}"`;
  return null;
}

/** Something users can buy with points from the reward store. */
export interface ItemRule {
  id: string;
  name: string;
  description?: string;
  /** What one costs. The amount comes out of the user's spendable balance, not their earned total. */
  price: { currency: string; amount: number };
  /** Most a user can own at once. Default: no limit. */
  limit?: number;
  /** Anything your app needs to show or use the item (image URL, sku). Returned as is. */
  metadata?: Record<string, unknown>;
  /**
   * What using one does. `streakFreeze` adds a freeze to that streak (up to its
   * freezes.max). `boost` gives the user a personal multiplier for some
   * minutes; using several queues them back to back. Without an effect, using
   * an item just takes it from the inventory, for things your app handles
   * itself (vouchers, unlocks).
   */
  effect?: { streakFreeze: string } | { boost: BoostSpec };
}

export interface OnstreakConfig {
  /** Time zone used for streaks when an event does not say. Default UTC. */
  defaultTimezone?: string;
  currencies: string[];
  points?: PointRule[];
  levels?: LevelInput;
  streaks?: StreakRule[];
  achievements?: AchievementRule[];
  leaderboards?: LeaderboardRule[];
  leagues?: LeagueRule[];
  rivalries?: RivalryRule[];
  quests?: QuestRule[];
  multipliers?: MultiplierRule[];
  items?: ItemRule[];
  calendars?: CalendarRule[];
  referrals?: ReferralConfig;
  communityGoals?: CommunityGoalRule[];
  seasons?: SeasonRule[];
  teamGoals?: TeamGoalRule[];
  friends?: {
    /** Most friends one user can have. Default 1000. */
    max?: number;
  };
  teams?: {
    /** Most members one team can have. Default 50. */
    maxMembers?: number;
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
  /** Tiers to drop when a season starts: null drops to the first tier. Absent: no reset. */
  seasonReset?: { dropTiers: number | null };
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
  quests: QuestRule[];
  multipliers: ResolvedMultiplier[];
  items: ItemRule[];
  calendars: CalendarRule[];
  /** Null when referrals are not configured. */
  referrals: ReferralConfig | null;
  communityGoals: ResolvedCommunityGoal[];
  seasons: ResolvedSeason[];
  teamGoals: TeamGoalRule[];
  friends: { max: number };
  teams: { maxMembers: number };
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

const PROP_KEY = /^[a-z0-9_]{1,40}$/i;

function whereProblem(where: unknown): string | null {
  if (where === undefined) return null;
  if (!where || typeof where !== "object" || Array.isArray(where)) return "where must be an object of property tests";
  const entries = Object.entries(where);
  if (entries.length === 0 || entries.length > 10) return "where needs 1 to 10 properties";
  for (const [k, t] of entries) {
    if (!PROP_KEY.test(k)) return `where has bad property name "${k}"`;
    if (["string", "number", "boolean"].includes(typeof t)) continue;
    if (!t || typeof t !== "object" || Array.isArray(t)) return `where.${k} must be a value or { in, gte, lte }`;
    const o = t as Record<string, unknown>;
    if (Object.keys(o).some((x) => !["in", "gte", "lte"].includes(x)) || Object.keys(o).length === 0) return `where.${k} must be a value or { in, gte, lte }`;
    if (o.in !== undefined && (!Array.isArray(o.in) || o.in.length === 0 || o.in.some((x) => typeof x !== "string" && typeof x !== "number"))) return `where.${k}.in must be a list of strings or numbers`;
    for (const b of ["gte", "lte"]) if (o[b] !== undefined && (typeof o[b] !== "number" || !Number.isFinite(o[b] as number))) return `where.${k}.${b} must be a number`;
  }
  return null;
}

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
    const problem = whereProblem(rule.where);
    if (problem) throw new ConfigError(`point rule for "${rule.event}": ${problem}`);
    if (rule.multiplyBy !== undefined && (typeof rule.multiplyBy !== "string" || !PROP_KEY.test(rule.multiplyBy))) throw new ConfigError(`point rule for "${rule.event}" multiplyBy must be a property name`);
    if (rule.multiplyBy !== undefined && rule.multiplyByValue) throw new ConfigError(`point rule for "${rule.event}" can use multiplyBy or multiplyByValue, not both`);
  }

  let levels: LevelConfig | null = null;
  if (input.levels) {
    hasCurrency(input.levels.currency, "levels");
    const { curve } = input.levels;
    if ((input.levels.thresholds === undefined) === (curve === undefined)) throw new ConfigError("levels needs thresholds or a curve, not both");
    let t: number[];
    if (curve) {
      const max = curve.maxLevel ?? 100;
      if (!Number.isInteger(max) || max < 2 || max > 1000) throw new ConfigError("levels.curve.maxLevel must be a whole number from 2 to 1000");
      t = [];
      if (curve.type === "linear") {
        if (typeof curve.step !== "number" || !(curve.step > 0) || !Number.isFinite(curve.step)) throw new ConfigError("levels.curve.step must be positive");
        for (let n = 1; n < max; n++) t.push(curve.step * n);
      } else if (curve.type === "exponential") {
        if (typeof curve.base !== "number" || !(curve.base > 0) || !Number.isFinite(curve.base)) throw new ConfigError("levels.curve.base must be positive");
        if (typeof curve.factor !== "number" || !(curve.factor > 1) || curve.factor > 10) throw new ConfigError("levels.curve.factor must be above 1 and at most 10");
        let step = curve.base;
        let total = 0;
        for (let n = 1; n < max; n++) {
          total += step;
          const rounded = Math.round(total);
          if (!Number.isSafeInteger(rounded)) break;
          t.push(rounded);
          step *= curve.factor;
        }
      } else throw new ConfigError('levels.curve.type must be "linear" or "exponential"');
    } else {
      t = input.levels.thresholds!;
      if (!Array.isArray(t) || t.length === 0 || !t.every(isNonNegative)) throw new ConfigError("levels.thresholds must be non-negative numbers");
    }
    for (let i = 1; i < t.length; i++) {
      if ((t[i] as number) <= (t[i - 1] as number)) throw new ConfigError("levels.thresholds must be strictly ascending");
    }
    const rewards = input.levels.rewards ?? [];
    if (!Array.isArray(rewards)) throw new ConfigError("levels.rewards must be a list of { level, rewards }");
    const seen = new Set<number>();
    for (const r of rewards) {
      if (!r || !Number.isInteger(r.level) || r.level < 2 || r.level > t.length + 1) throw new ConfigError(`levels.rewards level must be a whole number from 2 to ${t.length + 1}`);
      if (seen.has(r.level)) throw new ConfigError(`levels.rewards has level ${r.level} twice`);
      seen.add(r.level);
      if (!Array.isArray(r.rewards)) throw new ConfigError("levels.rewards entries need rewards: [{ currency, amount }]");
      for (const x of r.rewards) {
        hasCurrency(x.currency, "levels.rewards");
        if (typeof x.amount !== "number" || !Number.isFinite(x.amount) || x.amount <= 0) throw new ConfigError("levels.rewards need positive amounts");
      }
    }
    const prestige = input.levels.prestige;
    if (prestige !== undefined) {
      if (!prestige || typeof prestige !== "object" || Array.isArray(prestige)) throw new ConfigError("levels.prestige must be an object, e.g. {}");
      for (const x of prestige.rewards ?? []) {
        hasCurrency(x.currency, "levels.prestige.rewards");
        if (typeof x.amount !== "number" || !Number.isFinite(x.amount) || x.amount <= 0) throw new ConfigError("levels.prestige.rewards need positive amounts");
      }
    }
    levels = { currency: input.levels.currency, thresholds: [...t], prestige: prestige ? { rewards: (prestige.rewards ?? []).map((x) => ({ ...x })) } : null, rewards: rewards.map((r) => ({ level: r.level, rewards: r.rewards.map((x) => ({ ...x })) })).sort((a, b) => a.level - b.level) };
  }

  const streaks = input.streaks ?? [];
  uniqueIds("streak", streaks.map((s) => s.id));
  for (const s of streaks) {
    if (typeof s.event !== "string" || !ID.test(s.event)) throw new ConfigError(`streak "${s.id}" has bad event "${s.event}"`);
    const streakWhere = whereProblem(s.where);
    if (streakWhere) throw new ConfigError(`streak "${s.id}": ${streakWhere}`);
    if (!STREAK_PERIODS.includes(s.period) && s.period !== "monthly") throw new ConfigError(`streak "${s.id}" period must be daily, weekly or monthly`);
    if (s.weekStartsOn !== undefined) {
      if (s.period !== "weekly") throw new ConfigError(`streak "${s.id}" weekStartsOn only works with weekly streaks`);
      if (!["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].includes(s.weekStartsOn)) throw new ConfigError(`streak "${s.id}" weekStartsOn must be a day name like "sunday"`);
    }
    const f = s.freezes;
    if (f) {
      for (const key of ["start", "max", "earnEvery"] as const) {
        if (f[key] !== undefined && !(isNonNegative(f[key]) && Number.isInteger(f[key]))) {
          throw new ConfigError(`streak "${s.id}" freezes.${key} must be a whole number`);
        }
      }
      if ((f.start ?? 0) > (f.max ?? 0)) throw new ConfigError(`streak "${s.id}" freezes.start cannot exceed freezes.max`);
    }
    if (s.minimum !== undefined && !(typeof s.minimum === "number" && Number.isFinite(s.minimum) && s.minimum > 0)) throw new ConfigError(`streak "${s.id}" minimum must be a positive number`);
    if (s.skipWeekends !== undefined && typeof s.skipWeekends !== "boolean") throw new ConfigError(`streak "${s.id}" skipWeekends must be true or false`);
    if (s.skipWeekends && s.period !== "daily") throw new ConfigError(`streak "${s.id}" skipWeekends only works with daily streaks`);
    const repair = s.repair as { withinHours?: unknown; cost?: { currency?: unknown; amount?: unknown } } | undefined;
    if (repair !== undefined) {
      if (!repair || typeof repair.withinHours !== "number" || !(repair.withinHours > 0) || repair.withinHours > 720) {
        throw new ConfigError(`streak "${s.id}" repair.withinHours must be above 0 and at most 720`);
      }
      if (repair.cost !== undefined) {
        hasCurrency(String(repair.cost?.currency), `streak "${s.id}" repair`);
        if (!isNonNegative(repair.cost.amount)) throw new ConfigError(`streak "${s.id}" repair cost must be zero or more`);
      }
    }
  }

  const achievements = input.achievements ?? [];
  uniqueIds("achievement", achievements.map((a) => a.id));
  for (const a of achievements) {
    if (typeof a.name !== "string" || a.name.length === 0) throw new ConfigError(`achievement "${a.id}" needs a name`);
    const w = a.when as Record<string, unknown> | undefined;
    const checkCondition = (c: unknown, top: boolean, depth: number): void => {
      if (!c || typeof c !== "object" || Array.isArray(c)) throw new ConfigError(`achievement "${a.id}" needs when: { metric | streak | points, gte }`);
      const cond = c as Record<string, unknown>;
      if ("all" in cond || "any" in cond) {
        const list = cond.all ?? cond.any;
        if (depth > 3) throw new ConfigError(`achievement "${a.id}" nests all/any too deep (3 levels at most)`);
        if (("all" in cond && "any" in cond) || !Array.isArray(list) || list.length < 2 || list.length > 10) {
          throw new ConfigError(`achievement "${a.id}" all/any needs a list of 2 to 10 conditions`);
        }
        for (const x of list) checkCondition(x, false, depth + 1);
        return;
      }
      const kinds = ["metric", "streak", "points"].filter((k) => k in cond);
      if (kinds.length !== 1) throw new ConfigError(`achievement "${a.id}" needs when: { metric | streak | points, gte }`);
      if (!(top && a.tiers !== undefined) && !isNonNegative(cond.gte)) throw new ConfigError(`achievement "${a.id}" needs when: { metric | streak | points, gte }`);
      if (cond.within !== undefined) {
        if ("streak" in cond) throw new ConfigError(`achievement "${a.id}" within does not apply to streaks`);
        if (!["day", "week", "month"].includes(cond.within as string)) throw new ConfigError(`achievement "${a.id}" within must be day, week or month`);
      }
      if ("streak" in cond && !streaks.some((s) => s.id === cond.streak)) throw new ConfigError(`achievement "${a.id}" refers to unknown streak "${String(cond.streak)}"`);
      if ("points" in cond) hasCurrency(cond.points as string, `achievement "${a.id}"`);
      if ("metric" in cond && (typeof cond.metric !== "string" || !ID.test(cond.metric))) throw new ConfigError(`achievement "${a.id}" has bad metric "${String(cond.metric)}"`);
    };
    checkCondition(w, true, 1);
    if (a.tiers === undefined) {
      // checked above
    } else {
      if (!isLeaf(a.when)) throw new ConfigError(`achievement "${a.id}" with tiers needs a single value in when, not all/any`);
      if (w?.gte !== undefined) throw new ConfigError(`achievement "${a.id}" has tiers, so put gte on each tier instead of in when`);
      if (a.rewards !== undefined) throw new ConfigError(`achievement "${a.id}" has tiers, so put rewards on each tier`);
      if (!Array.isArray(a.tiers) || a.tiers.length < 2 || a.tiers.length > 10) throw new ConfigError(`achievement "${a.id}" tiers must list 2 to 10 tiers`);
      a.tiers.forEach((t, i) => {
        if (!t || typeof t.name !== "string" || t.name.length === 0) throw new ConfigError(`achievement "${a.id}" tiers need a name`);
        if (!isNonNegative(t.gte) || (i > 0 && t.gte <= a.tiers![i - 1]!.gte)) throw new ConfigError(`achievement "${a.id}" tier gte values must be ascending`);
      });
    }
    if (a.hidden !== undefined && typeof a.hidden !== "boolean") throw new ConfigError(`achievement "${a.id}" hidden must be true or false`);
    for (const r of [...(a.rewards ?? []), ...(a.tiers ?? []).flatMap((t) => t.rewards ?? [])]) {
      hasCurrency(r.currency, `achievement "${a.id}" reward`);
      if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0) throw new ConfigError(`achievement "${a.id}" rewards need a positive amount`);
    }
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
    if (l.seasonReset !== undefined) {
      if (!(input.seasons ?? []).length) throw new ConfigError(`league "${l.id}" seasonReset needs seasons to be configured`);
      if (l.seasonReset === true) resolved.seasonReset = { dropTiers: null };
      else if (l.seasonReset && typeof l.seasonReset === "object" && Number.isInteger(l.seasonReset.dropTiers) && l.seasonReset.dropTiers >= 1) {
        resolved.seasonReset = { dropTiers: l.seasonReset.dropTiers };
      } else throw new ConfigError(`league "${l.id}" seasonReset must be true or { dropTiers: 1 or more }`);
    }
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

  const quests = input.quests ?? [];
  uniqueIds("quest", quests.map((q) => q.id));
  for (const q of quests) {
    if (typeof q.name !== "string" || q.name.length === 0) throw new ConfigError(`quest "${q.id}" needs a name`);
    if (!STREAK_PERIODS.includes(q.period) && q.period !== "once") throw new ConfigError(`quest "${q.id}" period must be daily, weekly or once`);
    if (q.after !== undefined) {
      const prev = quests.find((x) => x.id === q.after);
      if (!prev || prev.id === q.id) throw new ConfigError(`quest "${q.id}" comes after unknown quest "${q.after}"`);
      if (prev.period !== "once") throw new ConfigError(`quest "${q.id}" can only come after a one-off quest, and "${prev.id}" repeats`);
    }
    if ((q.goal === undefined) === (q.goals === undefined)) throw new ConfigError(`quest "${q.id}" needs goal: { event | points, target } (or goals: [...] for a mission), not both`);
    if (q.goals !== undefined && (!Array.isArray(q.goals) || q.goals.length < 2 || q.goals.length > 10)) throw new ConfigError(`quest "${q.id}" goals must list 2 to 10 goals`);
    for (const goal of questGoals(q)) {
      const g = goal as Record<string, unknown> | undefined;
      const kinds = g && typeof g === "object" ? ["event", "points"].filter((k) => k in g) : [];
      if (kinds.length !== 1 || typeof g?.target !== "number" || !Number.isFinite(g.target) || g.target <= 0) {
        throw new ConfigError(`quest "${q.id}" needs goal: { event | points, target } with a positive target`);
      }
      if ("event" in goal && (typeof goal.event !== "string" || !ID.test(goal.event))) throw new ConfigError(`quest "${q.id}" has bad event "${goal.event}"`);
      const goalWhere = "event" in goal ? whereProblem(goal.where) : (goal as Record<string, unknown>).where !== undefined ? "where only works on event goals" : null;
      if (goalWhere) throw new ConfigError(`quest "${q.id}": ${goalWhere}`);
      if ("points" in goal) hasCurrency(goal.points, `quest "${q.id}"`);
    }
    for (const r of q.rewards ?? []) {
      hasCurrency(r.currency, `quest "${q.id}" reward`);
      if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0) throw new ConfigError(`quest "${q.id}" rewards need a positive amount`);
    }
    if (q.timezone !== undefined && !isValidTimeZone(q.timezone)) throw new ConfigError(`quest "${q.id}" has unknown timezone "${q.timezone}"`);
    const from = q.from === undefined ? -Infinity : Date.parse(q.from);
    const to = q.to === undefined ? Infinity : Date.parse(q.to);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw new ConfigError(`quest "${q.id}" from and to must be ISO dates with from before to`);
  }

  // Chains must not loop back on themselves.
  for (const q of quests) {
    const seen = new Set([q.id]);
    let next = q.after;
    while (next !== undefined) {
      if (seen.has(next)) throw new ConfigError(`quest "${q.id}" is part of a loop of "after" quests`);
      seen.add(next);
      next = quests.find((x) => x.id === next)?.after;
    }
  }

  const multipliers: ResolvedMultiplier[] = [];
  uniqueIds("multiplier", (input.multipliers ?? []).map((m) => m.id));
  const goodFactor = (f: unknown) => typeof f === "number" && Number.isFinite(f) && f > 0 && f <= 100;
  for (const m of input.multipliers ?? []) {
    if (m.currency !== undefined) hasCurrency(m.currency, `multiplier "${m.id}"`);
    const currency = m.currency ?? null;
    if ("streak" in m) {
      if (!streaks.some((s) => s.id === m.streak)) throw new ConfigError(`multiplier "${m.id}" refers to unknown streak "${m.streak}"`);
      if (!Array.isArray(m.steps) || m.steps.length === 0) throw new ConfigError(`multiplier "${m.id}" needs steps: [{ gte, factor }]`);
      for (const s of m.steps) {
        if (!isNonNegative(s.gte) || !goodFactor(s.factor)) throw new ConfigError(`multiplier "${m.id}" steps need gte >= 0 and a factor above 0 (at most 100)`);
      }
      const steps = [...m.steps].sort((a, b) => a.gte - b.gte).map((s) => ({ gte: s.gte, factor: s.factor }));
      multipliers.push({ id: m.id, currency, kind: "streak", streak: m.streak, steps });
    } else {
      if (!goodFactor(m.factor)) throw new ConfigError(`multiplier "${m.id}" factor must be above 0 and at most 100`);
      const from = Date.parse(m.from as string);
      const to = Date.parse(m.to as string);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new ConfigError(`multiplier "${m.id}" needs ISO dates with from before to`);
      multipliers.push({ id: m.id, currency, kind: "window", factor: m.factor, from, to });
    }
  }

  const items = input.items ?? [];
  uniqueIds("item", items.map((i) => i.id));
  for (const i of items) {
    if (typeof i.name !== "string" || i.name.length === 0) throw new ConfigError(`item "${i.id}" needs a name`);
    if (!i.price || typeof i.price !== "object") throw new ConfigError(`item "${i.id}" needs price: { currency, amount }`);
    hasCurrency(i.price.currency, `item "${i.id}"`);
    if (!isNonNegative(i.price.amount)) throw new ConfigError(`item "${i.id}" price amount must be zero or more`);
    if (i.limit !== undefined && !(Number.isInteger(i.limit) && i.limit >= 1)) throw new ConfigError(`item "${i.id}" limit must be a whole number of at least 1`);
    if (i.metadata !== undefined && (i.metadata === null || typeof i.metadata !== "object" || Array.isArray(i.metadata))) {
      throw new ConfigError(`item "${i.id}" metadata must be an object`);
    }
    if (i.effect !== undefined && i.effect !== null && typeof i.effect === "object" && "boost" in i.effect) {
      const problem = boostSpecProblem(i.effect.boost, currencies);
      if (problem) throw new ConfigError(`item "${i.id}" ${problem}`);
    } else if (i.effect !== undefined) {
      const target = streaks.find((s) => s.id === (i.effect as { streakFreeze?: string } | null)?.streakFreeze);
      if (!target) throw new ConfigError(`item "${i.id}" effect needs { streakFreeze: <streak id> } with a known streak, or { boost: { factor, minutes } }`);
      if ((target.freezes?.max ?? 0) < 1) throw new ConfigError(`item "${i.id}" gives freezes, but streak "${target.id}" has freezes.max 0`);
    }
  }

  const calendars = input.calendars ?? [];
  uniqueIds("calendar", calendars.map((c) => c.id));
  for (const c of calendars) {
    if (typeof c.event !== "string" || !ID.test(c.event)) throw new ConfigError(`calendar "${c.id}" has bad event "${c.event}"`);
    if (c.name !== undefined && (typeof c.name !== "string" || c.name.length === 0)) throw new ConfigError(`calendar "${c.id}" name must be a non-empty string`);
    if (!Array.isArray(c.days) || c.days.length === 0 || c.days.length > 366) throw new ConfigError(`calendar "${c.id}" needs 1 to 366 days`);
    for (const d of c.days) {
      if (!d || !Array.isArray(d.rewards)) throw new ConfigError(`calendar "${c.id}" days need rewards: [{ currency, amount }]`);
      for (const r of d.rewards) {
        hasCurrency(r.currency, `calendar "${c.id}" reward`);
        if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0) throw new ConfigError(`calendar "${c.id}" rewards need a positive amount`);
      }
    }
    if (c.missed !== undefined && c.missed !== "reset" && c.missed !== "continue") throw new ConfigError(`calendar "${c.id}" missed must be "reset" or "continue"`);
    if (c.afterLast !== undefined && c.afterLast !== "repeat" && c.afterLast !== "stay") throw new ConfigError(`calendar "${c.id}" afterLast must be "repeat" or "stay"`);
    if (c.timezone !== undefined && !isValidTimeZone(c.timezone)) throw new ConfigError(`calendar "${c.id}" has unknown timezone "${c.timezone}"`);
  }

  let referrals: ReferralConfig | null = null;
  if (input.referrals !== undefined) {
    const r = input.referrals;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new ConfigError("referrals must be an object");
    for (const side of ["referrer", "referred"] as const) {
      const list = r[side];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new ConfigError(`referrals.${side} must be a list of { currency, amount }`);
      for (const reward of list) {
        hasCurrency(reward.currency, `referrals.${side}`);
        if (typeof reward.amount !== "number" || !Number.isFinite(reward.amount) || reward.amount <= 0) throw new ConfigError(`referrals.${side} rewards need a positive amount`);
      }
    }
    if (r.qualify !== undefined) {
      if (!r.qualify || typeof r.qualify.event !== "string" || !ID.test(r.qualify.event)) throw new ConfigError("referrals.qualify needs { event, target }");
      if (typeof r.qualify.target !== "number" || !Number.isFinite(r.qualify.target) || r.qualify.target <= 0) throw new ConfigError("referrals.qualify.target must be positive");
    }
    if (r.max !== undefined && !(Number.isInteger(r.max) && r.max >= 1)) throw new ConfigError("referrals.max must be a whole number of at least 1");
    referrals = {
      referrer: (r.referrer ?? []).map((x) => ({ ...x })),
      referred: (r.referred ?? []).map((x) => ({ ...x })),
      ...(r.qualify ? { qualify: { ...r.qualify } } : {}),
      ...(r.max !== undefined ? { max: r.max } : {}),
    };
  }

  const communityGoals: ResolvedCommunityGoal[] = [];
  uniqueIds("community goal", (input.communityGoals ?? []).map((g) => g.id));
  for (const g of input.communityGoals ?? []) {
    if (typeof g.name !== "string" || g.name.length === 0) throw new ConfigError(`community goal "${g.id}" needs a name`);
    const goal = g.goal as Record<string, unknown> | undefined;
    const kinds = goal ? ["event", "points"].filter((k) => k in goal) : [];
    if (kinds.length !== 1 || typeof goal?.target !== "number" || !Number.isFinite(goal.target) || goal.target <= 0) {
      throw new ConfigError(`community goal "${g.id}" needs goal: { event | points, target } with a positive target`);
    }
    if ("event" in g.goal && (typeof g.goal.event !== "string" || !ID.test(g.goal.event))) throw new ConfigError(`community goal "${g.id}" has bad event "${g.goal.event}"`);
    if ("points" in g.goal) hasCurrency(g.goal.points, `community goal "${g.id}"`);
    const from = Date.parse(g.from);
    const to = Date.parse(g.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new ConfigError(`community goal "${g.id}" needs ISO dates with from before to`);
    for (const r of g.rewards ?? []) {
      hasCurrency(r.currency, `community goal "${g.id}" reward`);
      if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0) throw new ConfigError(`community goal "${g.id}" rewards need a positive amount`);
    }
    if (g.minContribution !== undefined && !(isNonNegative(g.minContribution) && g.minContribution > 0)) throw new ConfigError(`community goal "${g.id}" minContribution must be positive`);
    communityGoals.push({ ...g, goal: { ...g.goal }, rewards: (g.rewards ?? []).map((r) => ({ ...r })), from, to });
  }

  const seasons: ResolvedSeason[] = [];
  uniqueIds("season", (input.seasons ?? []).map((s) => s.id));
  for (const s of input.seasons ?? []) {
    if (typeof s.name !== "string" || s.name.length === 0) throw new ConfigError(`season "${s.id}" needs a name`);
    hasCurrency(s.currency, `season "${s.id}"`);
    const from = Date.parse(s.from);
    const to = Date.parse(s.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new ConfigError(`season "${s.id}" needs ISO dates with from before to`);
    const tiers = s.rewards ?? [];
    if (!Array.isArray(tiers)) throw new ConfigError(`season "${s.id}" rewards must be a list of { top, rewards }`);
    const tops = new Set<number>();
    for (const tier of tiers) {
      if (!tier || !Number.isInteger(tier.top) || tier.top < 1) throw new ConfigError(`season "${s.id}" reward tiers need top: a whole number of at least 1`);
      if (tops.has(tier.top)) throw new ConfigError(`season "${s.id}" has two tiers with top ${tier.top}`);
      tops.add(tier.top);
      if (tier.title !== undefined && (typeof tier.title !== "string" || tier.title.length === 0)) throw new ConfigError(`season "${s.id}" tier titles must be non-empty`);
      if (!Array.isArray(tier.rewards)) throw new ConfigError(`season "${s.id}" tiers need rewards: [{ currency, amount }]`);
      for (const r of tier.rewards) {
        hasCurrency(r.currency, `season "${s.id}" reward`);
        if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0) throw new ConfigError(`season "${s.id}" rewards need a positive amount`);
      }
    }
    seasons.push({
      id: s.id,
      name: s.name,
      currency: s.currency,
      from,
      to,
      rewards: [...tiers].sort((a, b) => a.top - b.top).map((tier) => ({ top: tier.top, ...(tier.title ? { title: tier.title } : {}), rewards: tier.rewards.map((r) => ({ ...r })) })),
    });
  }

  const teamGoals = input.teamGoals ?? [];
  uniqueIds("team goal", teamGoals.map((g) => g.id));
  for (const g of teamGoals) {
    if (typeof g.name !== "string" || g.name.length === 0) throw new ConfigError(`team goal "${g.id}" needs a name`);
    if (!STREAK_PERIODS.includes(g.period)) throw new ConfigError(`team goal "${g.id}" period must be daily or weekly`);
    const goal = g.goal as Record<string, unknown> | undefined;
    const kinds = goal && typeof goal === "object" ? ["event", "points"].filter((k) => k in goal) : [];
    if (kinds.length !== 1 || typeof goal?.target !== "number" || !Number.isFinite(goal.target) || goal.target <= 0) {
      throw new ConfigError(`team goal "${g.id}" needs goal: { event | points, target } with a positive target`);
    }
    if ("event" in g.goal && (typeof g.goal.event !== "string" || !ID.test(g.goal.event))) throw new ConfigError(`team goal "${g.id}" has bad event "${g.goal.event}"`);
    if ("points" in g.goal) hasCurrency(g.goal.points, `team goal "${g.id}"`);
    if ("where" in g.goal) throw new ConfigError(`team goal "${g.id}" does not support where yet`);
    for (const r of g.rewards ?? []) {
      hasCurrency(r.currency, `team goal "${g.id}" reward`);
      if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0) throw new ConfigError(`team goal "${g.id}" rewards need a positive amount`);
    }
    if (g.timezone !== undefined && !isValidTimeZone(g.timezone)) throw new ConfigError(`team goal "${g.id}" has unknown timezone "${g.timezone}"`);
  }

  const maxFriends = input.friends?.max ?? 1000;
  if (!Number.isInteger(maxFriends) || maxFriends < 1 || maxFriends > 100_000) {
    throw new ConfigError("friends.max must be a whole number from 1 to 100000");
  }

  const maxMembers = input.teams?.maxMembers ?? 50;
  if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100_000) throw new ConfigError("teams.maxMembers must be a whole number from 1 to 100000");

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
    quests,
    multipliers,
    items,
    calendars,
    referrals,
    communityGoals,
    seasons,
    teamGoals,
    friends: { max: maxFriends },
    teams: { maxMembers },
  };
}

/** Whether a quest runs at `ms` (inside its optional from/to window). */
export function questRunsAt(quest: QuestRule, ms: number): boolean {
  return (quest.from === undefined || ms >= Date.parse(quest.from)) && (quest.to === undefined || ms < Date.parse(quest.to));
}

/** Level for a points total: 1 plus every threshold reached. */
export function levelFor(levels: LevelConfig, total: number): number {
  let level = 1;
  for (const t of levels.thresholds) if (total >= t) level++;
  return level;
}
