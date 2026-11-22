import type { StreakRule } from "./config.js";
import { addDays, addMonths, dayKey, daysBetween, monthStart } from "./time.js";

export interface StreakState {
  current: number;
  longest: number;
  /** Day (or week start) of the last counted activity, in the user's zone. */
  lastPeriod: string | null;
  freezes: number;
  /** For streaks with a minimum: the period being filled, and how much is done in it. */
  progressPeriod?: string | null;
  progress?: number;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_NAMES: readonly string[] = WEEKDAYS;

/** The period a moment falls in for this streak: its day, its week (from weekStartsOn, default Monday) or its month. */
export function streakPeriodKey(rule: StreakRule, ms: number, timeZone: string): string {
  const day = dayKey(ms, timeZone);
  if (rule.period === "daily") return day;
  if (rule.period === "monthly") return monthStart(day);
  const first = WEEKDAYS.indexOf(rule.weekStartsOn ?? "monday");
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow - first + 7) % 7));
}

/** Whole periods from one period key to another (negative if `to` is earlier). */
export function streakPeriodsBetween(rule: StreakRule, from: string, to: string): number {
  if (rule.period === "monthly") {
    const [fy, fm] = from.split("-").map(Number) as [number, number];
    const [ty, tm] = to.split("-").map(Number) as [number, number];
    return (ty - fy) * 12 + (tm - fm);
  }
  const days = daysBetween(from, to);
  return rule.period === "daily" ? days : Math.round(days / 7);
}

/** The period key `n` periods after (or before) `key`. */
export function shiftPeriod(rule: StreakRule, key: string, n: number): string {
  if (rule.period === "monthly") return addMonths(key, n);
  return addDays(key, rule.period === "daily" ? n : n * 7);
}

/** Whether a period must be done: with skipWeekends, Saturdays and Sundays never count as missed. */
function required(rule: StreakRule, period: string): boolean {
  if (!rule.skipWeekends) return true;
  const day = new Date(`${period}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

/** Required periods strictly between two periods. */
export function missedBetween(rule: StreakRule, from: string, to: string): number {
  const gap = streakPeriodsBetween(rule, from, to);
  if (!rule.skipWeekends) return Math.max(0, gap - 1);
  let missed = 0;
  for (let i = 1; i < gap; i++) if (required(rule, shiftPeriod(rule, from, i))) missed++;
  return missed;
}

/**
 * The first period in which the streak counts as broken: the one after the
 * (freezes + 1)th required period missed since `lastPeriod`.
 */
export function breakPeriod(rule: StreakRule, lastPeriod: string, freezes: number): string {
  let missed = 0;
  let p = lastPeriod;
  for (let i = 0; i < 10_000; i++) {
    p = shiftPeriod(rule, p, 1);
    if (required(rule, p)) missed++;
    if (missed > freezes) return shiftPeriod(rule, p, 1);
  }
  return shiftPeriod(rule, p, 1);
}

export interface StreakUpdate {
  state: StreakState;
  /** True when this activity grew the streak. */
  extended: boolean;
  freezesUsed: number;
  /** True when a missed period broke the old streak. */
  reset: boolean;
}

export type StreakStatus = "none" | "done" | "pending" | "broken";

export function initialStreak(rule: StreakRule): StreakState {
  return { current: 0, longest: 0, lastPeriod: null, freezes: rule.freezes?.start ?? 0 };
}

/**
 * Apply one activity in `period`. Repeats in the same period do nothing.
 * Activity older than the last counted period is ignored, so late or
 * replayed events never rewrite history.
 */
export function recordActivity(rule: StreakRule, prev: StreakState, period: string): StreakUpdate {
  const unchanged: StreakUpdate = { state: prev, extended: false, freezesUsed: 0, reset: false };
  if (prev.lastPeriod === period) return unchanged;

  let current = 1;
  let freezes = prev.freezes;
  let freezesUsed = 0;
  let reset = false;

  if (prev.lastPeriod !== null) {
    const gap = streakPeriodsBetween(rule, prev.lastPeriod, period);
    if (gap < 0) return unchanged;
    if (prev.current > 0) {
      const missed = missedBetween(rule, prev.lastPeriod, period);
      if (missed === 0) {
        current = prev.current + 1;
      } else if (missed <= freezes) {
        freezes -= missed;
        freezesUsed = missed;
        current = prev.current + 1;
      } else {
        reset = true;
      }
    }
  }

  const every = rule.freezes?.earnEvery;
  if (every && current % every === 0) freezes = Math.min(rule.freezes?.max ?? 0, freezes + 1);

  return {
    state: { ...prev, current, longest: Math.max(prev.longest, current), lastPeriod: period, freezes },
    extended: true,
    freezesUsed,
    reset,
  };
}

/**
 * How a streak looks right now, without changing it. A streak whose gap is
 * too big for the freezes left reads as broken (current 0).
 */
export function streakStatus(
  rule: StreakRule,
  state: StreakState,
  nowPeriod: string,
): { current: number; longest: number; freezes: number; lastPeriod: string | null; status: StreakStatus } {
  const base = { longest: state.longest, freezes: state.freezes, lastPeriod: state.lastPeriod };
  if (state.lastPeriod === null || state.current === 0) return { ...base, current: 0, status: "none" };
  const gap = streakPeriodsBetween(rule, state.lastPeriod, nowPeriod);
  if (gap <= 0) return { ...base, current: state.current, status: "done" };
  if (missedBetween(rule, state.lastPeriod, nowPeriod) <= state.freezes) return { ...base, current: state.current, status: "pending" };
  return { ...base, current: 0, status: "broken" };
}
