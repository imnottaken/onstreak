import type { StreakRule } from "./config.js";
import { periodsBetween } from "./time.js";

export interface StreakState {
  current: number;
  longest: number;
  /** Day (or week start) of the last counted activity, in the user's zone. */
  lastPeriod: string | null;
  freezes: number;
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
    const gap = periodsBetween(prev.lastPeriod, period, rule.period);
    if (gap < 0) return unchanged;
    if (prev.current > 0) {
      const missed = gap - 1;
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
    state: { current, longest: Math.max(prev.longest, current), lastPeriod: period, freezes },
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
  const gap = periodsBetween(state.lastPeriod, nowPeriod, rule.period);
  if (gap <= 0) return { ...base, current: state.current, status: "done" };
  if (gap - 1 <= state.freezes) return { ...base, current: state.current, status: "pending" };
  return { ...base, current: 0, status: "broken" };
}
