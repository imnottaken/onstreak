import type { StreakState } from "../streaks.js";
import type { TrackResult } from "../engine.js";
import type { LeagueOutcome } from "../leagues.js";

/** A user's seat in one league round. */
export interface Membership {
  leagueId: string;
  roundKey: string;
  tier: string;
  group: number;
  joinedAt: number;
  /** Filled in once the round is over and settled. */
  outcome: LeagueOutcome | null;
  finalRank: number | null;
  nextTier: string | null;
}

export interface GroupQuery {
  leagueId: string;
  roundKey: string;
  tier: string;
  group: number;
  currency: string;
  from: number;
  to: number;
}

/** A group member and the points they earned in the round, best first. */
export interface GroupMember {
  userId: string;
  score: number;
  joinedAt: number;
}

export interface StoredEvent {
  id: string;
  userId: string;
  key: string;
  value: number;
  ts: number;
  idempotencyKey: string | null;
}

/** Everything the engine reads or writes for one user, inside one transaction. */
export interface UserTx {
  findByIdempotencyKey(key: string): Promise<TrackResult | null>;
  insertEvent(event: StoredEvent): Promise<void>;
  setEventResult(eventId: string, result: TrackResult): Promise<void>;
  addMetric(key: string, delta: number): Promise<number>;
  getMetric(key: string): Promise<number>;
  addPoints(currency: string, amount: number, ts: number, eventId: string): Promise<number>;
  getBalance(currency: string): Promise<number>;
  getStreak(id: string): Promise<StreakState | null>;
  setStreak(id: string, state: StreakState): Promise<void>;
  unlockedAchievements(): Promise<Set<string>>;
  unlock(id: string, ts: number): Promise<void>;
  /** The user's most recent rounds in a league, newest first. */
  getMemberships(leagueId: string, limit: number): Promise<Membership[]>;
  /** Seat the user in the first group of their tier with room, opening a new one if all are full. */
  joinLeague(leagueId: string, roundKey: string, tier: string, groupSize: number, joinedAt: number): Promise<number>;
  settleMembership(leagueId: string, roundKey: string, result: { outcome: LeagueOutcome; finalRank: number; nextTier: string }): Promise<void>;
  /** Members of one group with their points in the round, ranked best first. */
  groupStandings(query: GroupQuery): Promise<GroupMember[]>;
}

export interface UserSnapshot {
  metrics: Record<string, number>;
  balances: Record<string, number>;
  streaks: Record<string, StreakState>;
  achievements: Array<{ id: string; unlockedAt: string }>;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  score: number;
}

export interface LeaderboardQuery {
  currency: string;
  /** Window start (inclusive) and end (exclusive) in epoch ms, or null for all time. */
  from: number | null;
  to: number | null;
  limit: number;
  userId?: string;
}

export interface Store {
  /** Create tables if needed. Safe to call on every start. */
  migrate(): Promise<void>;
  /** Run `fn` with the user locked, so concurrent events for one user apply in order. */
  withUser<T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T>;
  snapshot(userId: string): Promise<UserSnapshot>;
  leaderboard(query: LeaderboardQuery): Promise<{ entries: LeaderboardEntry[]; user: LeaderboardEntry | null }>;
}
