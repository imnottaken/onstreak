import type { StreakState } from "../streaks.js";
import type { ItemUseResult, TrackResult } from "../engine.js";
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

/** A friend, with what others may see about them. */
export interface FriendRecord extends PublicProfile {
  userId: string;
  since: number;
}

/** One of a user's rivals in a rivalry, with settled rounds from the user's side. */
export interface RivalRecord {
  rivalId: string;
  startedRound: string;
  since: number;
  /** Settled rounds, oldest first; `you` is the asking user's score. */
  rounds: Array<{ roundKey: string; you: number; them: number }>;
}

/** A user's progress on one quest in one period. */
export interface QuestProgress {
  questId: string;
  periodKey: string;
  progress: number;
  completedAt: number | null;
}

/** One purchase from the reward store. */
export interface PurchaseRecord {
  id: string;
  itemId: string;
  quantity: number;
  currency: string;
  /** Total paid: price times quantity. */
  cost: number;
  purchasedAt: number;
  idempotencyKey: string | null;
}

/** One use of owned items, with the result returned to the caller (for idempotent retries). */
export interface ItemUseRecord {
  id: string;
  itemId: string;
  quantity: number;
  usedAt: number;
  idempotencyKey: string | null;
  result: ItemUseResult;
}

/** A multiplier given to one user for a while. Null currency means every currency. */
export interface BoostRecord {
  id: string;
  currency: string | null;
  factor: number;
  startsAt: number;
  endsAt: number;
  reason: string;
  idempotencyKey: string | null;
}

export interface PurchasePageQuery {
  limit: number;
  /** Return purchases strictly older than this position (newest first). */
  before?: { ts: number; id: string };
}

export interface WindowScoreQuery {
  currency: string;
  from: number;
  to: number;
  /** Only count points recorded before this instant (null: everything so far). */
  recordedBefore: number | null;
  userIds: string[];
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
  getQuest(questId: string, periodKey: string): Promise<QuestProgress | null>;
  setQuest(progress: QuestProgress): Promise<void>;
  /** Points spent so far in a currency. Spendable balance is getBalance minus this. */
  getSpent(currency: string): Promise<number>;
  /** How many of an item the user owns. */
  getInventory(itemId: string): Promise<number>;
  findPurchase(idempotencyKey: string): Promise<PurchaseRecord | null>;
  /** Store a purchase: adds its cost to spent and its quantity to the inventory. Returns the new quantity owned. */
  recordPurchase(purchase: PurchaseRecord): Promise<number>;
  findItemUse(idempotencyKey: string): Promise<ItemUseResult | null>;
  /** Store a use and take its quantity from the inventory (the caller checks there are enough). Returns how many are left. */
  recordItemUse(use: ItemUseRecord): Promise<number>;
  /** Boosts that end after `after` (running or yet to start), soonest start first. */
  getBoosts(after: number): Promise<BoostRecord[]>;
  findBoost(idempotencyKey: string): Promise<BoostRecord | null>;
  addBoost(boost: BoostRecord): Promise<void>;
}

export interface UserSnapshot {
  profile: ProfileData;
  metrics: Record<string, number>;
  /** Points earned, per currency (never goes down). */
  balances: Record<string, number>;
  /** Points spent in the reward store, per currency. */
  spent: Record<string, number>;
  /** Items owned, by item id. Items with none are left out. */
  inventory: Record<string, number>;
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
  /** Only rank these users. */
  userIds?: string[];
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
  /**
   * Make two users friends (both directions). Creates users that do not exist.
   * Returns false if they already were. Fails with FriendLimitError when either
   * side already has `maxFriends`.
   */
  addFriendship(a: string, b: string, ts: number, maxFriends: number): Promise<boolean>;
  /** Returns false if they were not friends. */
  removeFriendship(a: string, b: string): Promise<boolean>;
  /** A user's friends, newest first. */
  friends(userId: string): Promise<FriendRecord[]>;
  /** Start a rivalry between two users. Returns false if it already exists. Throws RivalLimitError past `max`. */
  addRivalry(rivalryId: string, a: string, b: string, startedRound: string, ts: number, max: number): Promise<boolean>;
  /** End a rivalry and drop its history. Returns false if there was none. */
  removeRivalry(rivalryId: string, a: string, b: string): Promise<boolean>;
  /** A user's rivals in one rivalry, newest first. */
  rivalries(rivalryId: string, userId: string): Promise<RivalRecord[]>;
  /** Store a finished round's scores (first write wins; repeats are ignored). */
  recordRivalryRound(rivalryId: string, a: string, b: string, roundKey: string, scoreA: number, scoreB: number): Promise<void>;
  /** Points each user earned in a window. Users with none are left out. */
  windowScores(query: WindowScoreQuery): Promise<Record<string, number>>;
  /** A user's progress on these quest periods. Periods never started are left out. */
  quests(userId: string, keys: Array<{ questId: string; periodKey: string }>): Promise<QuestProgress[]>;
  /** A user's boosts that end after `after`, soonest start first. */
  boosts(userId: string, after: number): Promise<BoostRecord[]>;
  /** A user's purchases, newest first. */
  purchases(userId: string, query: PurchasePageQuery): Promise<PurchaseRecord[]>;
  /** Throws if the database cannot be reached. */
  ping(): Promise<void>;
  /** Release connections. */
  close(): Promise<void>;
}

/** Thrown by stores when a friendship would exceed the friend limit. */
export class FriendLimitError extends Error {
  constructor(readonly userId: string) {
    super(`${userId} already has the maximum number of friends`);
    this.name = "FriendLimitError";
  }
}

/** Thrown by stores when a rivalry would exceed the per-user limit. */
export class RivalLimitError extends Error {
  constructor(readonly userId: string) {
    super(`${userId} already has the maximum number of rivals`);
    this.name = "RivalLimitError";
  }
}
