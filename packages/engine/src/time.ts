/**
 * Calendar math in a user's time zone. Day keys are "YYYY-MM-DD" strings in
 * that zone, so a streak day always means the user's own midnight-to-midnight.
 */

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(ms: number, timeZone: string): WallClock {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out as unknown as WallClock;
}

const pad = (n: number): string => String(n).padStart(2, "0");

function keyToUtc(key: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcToKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The calendar day ("YYYY-MM-DD") that instant `ms` falls on in `timeZone`. */
export function dayKey(ms: number, timeZone: string): string {
  const w = wallClock(ms, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export function addDays(key: string, days: number): string {
  return utcToKey(keyToUtc(key) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((keyToUtc(to) - keyToUtc(from)) / DAY_MS);
}

/** Monday of the ISO week containing `key`. */
export function weekStart(key: string): string {
  const dow = new Date(keyToUtc(key)).getUTCDay();
  return addDays(key, -((dow + 6) % 7));
}

export function monthStart(key: string): string {
  return `${key.slice(0, 8)}01`;
}

export function addMonths(key: string, months: number): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return utcToKey(Date.UTC(y, m - 1 + months, 1));
}

/** Milliseconds `timeZone` is ahead of UTC at instant `ms`. */
function offsetMs(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant local midnight starts `key` in `timeZone` (handles DST). */
export function startOfDay(key: string, timeZone: string): number {
  const guess = keyToUtc(key);
  const first = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(first, timeZone);
}

export type StreakPeriod = "daily" | "weekly";
export type LeaderboardPeriod = "daily" | "weekly" | "monthly" | "all";

/** The period a moment belongs to: its day, or the Monday of its week. */
export function periodKey(ms: number, period: StreakPeriod, timeZone: string): string {
  const day = dayKey(ms, timeZone);
  return period === "daily" ? day : weekStart(day);
}

export function periodsBetween(from: string, to: string, period: StreakPeriod): number {
  const days = daysBetween(from, to);
  return period === "daily" ? days : Math.round(days / 7);
}

/** [from, to) instants of the leaderboard window that contains `ms`. */
export function leaderboardWindow(
  period: LeaderboardPeriod,
  ms: number,
  timeZone: string,
): { from: number | null; to: number | null } {
  if (period === "all") return { from: null, to: null };
  const day = dayKey(ms, timeZone);
  let start: string;
  let end: string;
  if (period === "daily") {
    start = day;
    end = addDays(day, 1);
  } else if (period === "weekly") {
    start = weekStart(day);
    end = addDays(start, 7);
  } else {
    start = monthStart(day);
    end = addMonths(start, 1);
  }
  return { from: startOfDay(start, timeZone), to: startOfDay(end, timeZone) };
}
