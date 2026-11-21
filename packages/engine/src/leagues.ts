import type { ResolvedLeague } from "./config.js";
import { addDays, dayKey, leaderboardWindow, startOfDay } from "./time.js";

export type LeagueOutcome = "promoted" | "demoted" | "stayed";
export type LeagueZone = "promotion" | "demotion" | "safe";

/** One round of a league: its key (local start date) and [from, to) instants. */
export interface LeagueRound {
  key: string;
  from: number;
  to: number;
}

/** Anything with rounds: leagues and rivalries. */
export type RoundRule = Pick<ResolvedLeague, "period" | "timezone">;

export function currentRound(league: RoundRule, ms: number): LeagueRound {
  const { from, to } = leaderboardWindow(league.period, ms, league.timezone);
  return { key: dayKey(from as number, league.timezone), from: from as number, to: to as number };
}

export function roundFromKey(league: RoundRule, key: string): LeagueRound {
  const days = league.period === "weekly" ? 7 : 1;
  return { key, from: startOfDay(key, league.timezone), to: startOfDay(addDays(key, days), league.timezone) };
}

/**
 * Where a rank sits in a group of `size`. Top `promote` move up and bottom
 * `demote` move down, but nobody moves up from the top tier or down from the
 * bottom one, a group needs more members than promotion spots before anyone
 * is promoted, and the zones never overlap.
 */
export function zoneFor(league: ResolvedLeague, tierIndex: number, rank: number, size: number): LeagueZone {
  const top = tierIndex === league.tiers.length - 1;
  const bottom = tierIndex === 0;
  if (!top && rank <= league.promote && size > league.promote) return "promotion";
  if (!bottom && league.demote > 0 && rank > Math.max(league.promote, size - league.demote)) return "demotion";
  return "safe";
}

export function outcomeFor(league: ResolvedLeague, tierIndex: number, rank: number, size: number): LeagueOutcome {
  const zone = zoneFor(league, tierIndex, rank, size);
  return zone === "promotion" ? "promoted" : zone === "demotion" ? "demoted" : "stayed";
}

export function nextTier(league: ResolvedLeague, tier: string, outcome: LeagueOutcome): string {
  const i = Math.max(0, league.tiers.indexOf(tier));
  const j = outcome === "promoted" ? i + 1 : outcome === "demoted" ? i - 1 : i;
  return league.tiers[Math.min(league.tiers.length - 1, Math.max(0, j))] as string;
}

/** The key of the round after `key`. */
export function nextRoundKey(rule: RoundRule, key: string): string {
  return addDays(key, rule.period === "weekly" ? 7 : 1);
}
