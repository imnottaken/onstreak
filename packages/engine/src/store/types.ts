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
  /** Points whose event time falls in [from, to) count... */
  from: number;
  to: number;
  /** ...but only if they were recorded before this instant. Null counts everything recorded so far. */
  recordedBefore: number | null;
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
  /** When the event happened (may be in the past for backfilled events). */
  ts: number;
  /** When onstreak received it. */
  recordedAt: number;
  idempotencyKey: string | null;
}

/** A user's own profile fields. */
export interface ProfileData {
  displayName: string | null;
  avatarUrl: string | null;
  metadata: Record<string, unknown>;
  timezone: string | null;
}

/** Fields to change. Omitted fields stay as they are; null clears one. */
export interface ProfilePatch {
  displayName?: string | null;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  timezone?: string | null;
}

/** What other users may see about someone on a leaderboard. */
export interface PublicProfile {
  displayName: string | null;
  avatarUrl: string | null;
}

export interface EventRecord {
  id: string;
  key: string;
  value: number;
  ts: number;
  recordedAt: number;
  result: TrackResult | null;
}

export interface EventPageQuery {
  limit: number;
  /** Return events strictly older than this position (newest first). */
  before?: { ts: number; id: string };
}

/** Everything the engine reads or writes for one user, inside one transaction. */
export interface UserTx {
  getProfile(): Promise<ProfileData>;
  updateProfile(patch: ProfilePatch): Promise<ProfileData>;
  findByIdempotencyKey(key: string): Promise<TrackResult | null>;
  insertEvent(event: StoredEvent): Promise<void>;
  setEventResult(eventId: string, result: TrackResult): Promise<void>;
  addMetric(key: string, delta: number): Promise<number>;
  getMetric(key: string): Promise<number>;
  addPoints(currency: string, amount: number, ts: number, eventId: string, recordedAt: number): Promise<number>;
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
  profile: ProfileData;
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

export interface MigrationReport {
  /** Migrations applied by this call, oldest first. */
  applied: Array<{ version: number; name: string }>;
  /** Schema version after the call. */
  version: number;
}

export interface Store {
  /** Bring the schema up to date. Safe to call on every start and from several processes at once. */
  migrate(): Promise<MigrationReport>;
  /** Run `fn` with the user locked, so concurrent events for one user apply in order. */
  withUser<T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T>;
  snapshot(userId: string): Promise<UserSnapshot>;
  leaderboard(query: LeaderboardQuery): Promise<{ entries: LeaderboardEntry[]; user: LeaderboardEntry | null }>;
  /** Display names and avatars for these users. Users without a profile are left out. */
  profiles(userIds: string[]): Promise<Record<string, PublicProfile>>;
  /** A user's events, newest first. */
  events(userId: string, query: EventPageQuery): Promise<EventRecord[]>;
  /** Throws if the database cannot be reached. */
  ping(): Promise<void>;
  /** Release connections. */
  close(): Promise<void>;
}
