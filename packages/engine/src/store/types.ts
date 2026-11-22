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
  /** Extra facts about the event, e.g. { difficulty: "hard" }. */
  properties?: EventProperties | null;
}

export type EventProperties = Record<string, string | number | boolean>;

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  type: string;
  userId: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
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
  /** How many of `quantity` were refunded. */
  refunded: number;
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

/** Where a user is in a reward calendar: the last day claimed, and when. */
export interface CalendarState {
  day: number;
  lastPeriod: string;
}

/** A referral: who brought this user in, and how far it has got. */
export interface ReferralRecord {
  /** Also used as the event id of the points it pays. */
  id: string;
  referrerId: string;
  referredId: string;
  createdAt: number;
  qualifiedAt: number | null;
  /** When the referrer's side was dealt with (paid, or skipped past the limit). */
  settledAt: number | null;
  /** Whether the referrer was paid for it. */
  rewarded: boolean;
}

/** Sum an event's values, or points in a currency, over a window: for everyone, or one user. */
export interface CommunityTotalQuery {
  kind: "event" | "points";
  /** Event key or currency. */
  key: string;
  from: number;
  to: number;
  userId?: string;
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
  properties: EventProperties | null;
  /** When the event was reversed, or null. */
  reversedAt?: number | null;
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
  /** Remove an unlocked achievement (or tier key). Returns false if it was not unlocked. */
  revokeAchievement(id: string): Promise<boolean>;
  /** Queue webhook deliveries in this transaction, so they exist exactly when the event does. */
  enqueueWebhooks(deliveries: WebhookDelivery[]): Promise<void>;
  /** One of this user's events, or null. */
  getEvent(eventId: string): Promise<(EventRecord & { reversedAt: number | null }) | null>;
  markReversed(eventId: string, at: number): Promise<void>;
  /** The user's most recent rounds in a league, newest first. */
  getMemberships(leagueId: string, limit: number): Promise<Membership[]>;
  /** Seat the user in the first group of their tier with room, opening a new one if all are full. */
  joinLeague(leagueId: string, roundKey: string, tier: string, groupSize: number, joinedAt: number): Promise<number>;
  settleMembership(leagueId: string, roundKey: string, result: { outcome: LeagueOutcome; finalRank: number; nextTier: string }): Promise<void>;
  /** Members of one group with their points in the round, ranked best first. */
  groupStandings(query: GroupQuery): Promise<GroupMember[]>;
  getQuest(questId: string, periodKey: string): Promise<QuestProgress | null>;
  setQuest(progress: QuestProgress): Promise<void>;
  /** This user's event values summed, or points earned, in [from, to). */
  windowTotal(kind: "event" | "points", key: string, from: number, to: number): Promise<number>;
  /** How many times the user has prestiged, and the level-currency total levels count from. */
  getPrestige(): Promise<{ rank: number; base: number }>;
  setPrestige(rank: number, base: number, at: number): Promise<void>;
  /** Points spent so far in a currency. Spendable balance is getBalance minus this. */
  getSpent(currency: string): Promise<number>;
  /** Take points from the wallet for something other than an item (e.g. a streak repair). */
  spend(currency: string, amount: number): Promise<void>;
  /** How many of an item the user owns. */
  getInventory(itemId: string): Promise<number>;
  findPurchase(idempotencyKey: string): Promise<PurchaseRecord | null>;
  getPurchase(purchaseId: string): Promise<PurchaseRecord | null>;
  /** Refund part of a purchase: gives `amount` back to the wallet and takes `quantity` out of the inventory. */
  refundPurchase(purchaseId: string, quantity: number, amount: number): Promise<void>;
  /** Store a purchase: adds its cost to spent and its quantity to the inventory. Returns the new quantity owned. */
  recordPurchase(purchase: PurchaseRecord): Promise<number>;
  findItemUse(idempotencyKey: string): Promise<ItemUseResult | null>;
  /** Store a use and take its quantity from the inventory (the caller checks there are enough). Returns how many are left. */
  recordItemUse(use: ItemUseRecord): Promise<number>;
  /** Boosts that end after `after` (running or yet to start), soonest start first. */
  getBoosts(after: number): Promise<BoostRecord[]>;
  findBoost(idempotencyKey: string): Promise<BoostRecord | null>;
  addBoost(boost: BoostRecord): Promise<void>;
  getCalendar(calendarId: string): Promise<CalendarState | null>;
  setCalendar(calendarId: string, state: CalendarState): Promise<void>;
  /** Who referred this user, if anyone. */
  getReferral(): Promise<ReferralRecord | null>;
  /** Record who referred this user (creating the referrer if needed). Returns false if one is already recorded. */
  addReferral(referral: ReferralRecord): Promise<boolean>;
  qualifyReferral(at: number): Promise<void>;
  /**
   * Settle this user's qualified referrals that are not settled yet, as the
   * referrer: the first ones up to `max` rewarded in total are marked
   * rewarded, the rest only settled. Returns the ones settled now.
   */
  settleReferrals(max: number | null, at: number): Promise<ReferralRecord[]>;
  /** Record that the user took a community goal's rewards. Returns false if they already had. */
  claimCommunityReward(goalId: string, at: number): Promise<boolean>;
  /** Record that the user took a season's rank award. Returns false if they already had. */
  claimSeasonAward(seasonId: string, rank: number, at: number): Promise<boolean>;
  /** Record that the user took a team goal's rewards for one period. Returns false if they already had. */
  claimTeamGoalReward(goalId: string, periodKey: string, teamId: string, at: number): Promise<boolean>;
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
  prestige: { rank: number; base: number };
  /** Reward calendar progress, by calendar id. */
  calendars: Record<string, CalendarState>;
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
  /** Only count points recorded before this instant (so a finished window stays fixed). */
  recordedBefore?: number | null;
  /** With userId: return the entries within this many places of the user instead of the top. */
  around?: number;
  /** Only rank users whose profile metadata[key], as text, equals value. */
  segment?: { key: string; value: string };
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
  communityTotal(query: CommunityTotalQuery): Promise<number>;
  /**
   * Take up to `limit` pending deliveries due by `now` and push their next
   * attempt to `now + leaseMs`, so concurrent workers never send one twice.
   */
  claimWebhooks(now: number, limit: number, leaseMs: number): Promise<WebhookDelivery[]>;
  updateWebhook(id: string, patch: { status: WebhookDelivery["status"]; attempts: number; nextAttemptAt: number; lastError: string | null; deliveredAt: number | null }): Promise<void>;
  /** Deliveries newest first, optionally only one status. */
  webhookDeliveries(query: { status?: WebhookDelivery["status"]; limit: number; before?: { ts: number; id: string } }): Promise<WebhookDelivery[]>;
  /** Record `key` and queue `deliveries` in one transaction, unless `key` was recorded before. Returns whether it was new. */
  enqueueOnce(key: string, at: number, deliveries: WebhookDelivery[]): Promise<boolean>;
  /** User ids in order, after `afterUserId`. */
  userIds(afterUserId: string | null, limit: number): Promise<string[]>;
  /** Users with a running streak (current > 0), by user id after `afterUserId`, with their saved time zone. */
  activeStreaks(streakId: string, afterUserId: string | null, limit: number): Promise<Array<{ userId: string; state: StreakState; timezone: string | null }>>;
  /** Community goals whose rewards this user has claimed. */
  communityClaims(userId: string): Promise<Set<string>>;
  /** Season awards this user has taken, by season id. */
  seasonAwards(userId: string): Promise<Record<string, { rank: number; claimedAt: number }>>;
  /** Who referred this user, and everyone they referred (newest first). */
  referrals(userId: string): Promise<{ referredBy: ReferralRecord | null; referred: ReferralRecord[] }>;
  /** A user's boosts that end after `after`, soonest start first. */
  boosts(userId: string, after: number): Promise<BoostRecord[]>;
  /** A user's purchases, newest first. */
  purchases(userId: string, query: PurchasePageQuery): Promise<PurchaseRecord[]>;
  /** Create a team, or rename it. Returns whether it was created. */
  saveTeam(team: TeamRecord): Promise<boolean>;
  getTeam(teamId: string): Promise<TeamRecord | null>;
  /**
   * Put a user in a team (creating the user if needed). Returns false if
   * they already were in it. Throws AlreadyInTeamError if they are in
   * another team, TeamFullError past `maxMembers`.
   */
  addTeamMember(teamId: string, userId: string, joinedAt: number, maxMembers: number): Promise<boolean>;
  /** Returns false if the user was not in the team. */
  removeTeamMember(teamId: string, userId: string): Promise<boolean>;
  /** Members, earliest joined first. */
  teamMembers(teamId: string): Promise<TeamMemberRecord[]>;
  userTeam(userId: string): Promise<TeamMemberRecord | null>;
  /** Teams ranked by their members' points (each from when they joined), plus one team's place. */
  teamScores(query: TeamScoreQuery): Promise<{ entries: Array<{ rank: number; teamId: string; score: number }>; team: { rank: number; teamId: string; score: number } | null }>;
  /** Each current member's contribution to a team goal in a window, counted from when they joined: event values summed, or points earned. */
  teamContributions(teamId: string, kind: "event" | "points", key: string, from: number, to: number): Promise<Record<string, number>>;
  /** Team goal periods this user was paid for, as "goalId|periodKey". */
  teamGoalClaims(userId: string): Promise<Set<string>>;
  /** Points each member of a team earned in a window since they joined. */
  teamMemberScores(teamId: string, currency: string, from: number | null, to: number | null): Promise<Record<string, number>>;
  /** Throws if the database cannot be reached. */
  ping(): Promise<void>;
  /** Release connections. */
  close(): Promise<void>;
}

export interface TeamRecord {
  id: string;
  name: string;
  createdAt: number;
}

export interface TeamMemberRecord {
  userId: string;
  teamId: string;
  joinedAt: number;
}

export interface TeamScoreQuery {
  currency: string;
  /** Window in epoch ms, or null for all time. A member's points count from when they joined. */
  from: number | null;
  to: number | null;
  limit: number;
  /** Also return this team's place. */
  teamId?: string;
}

/** Thrown by stores when a team is full. */
export class TeamFullError extends Error {
  constructor(readonly teamId: string) {
    super(`team ${teamId} is full`);
    this.name = "TeamFullError";
  }
}

/** Thrown by stores when a user is already in another team. */
export class AlreadyInTeamError extends Error {
  constructor(readonly teamId: string) {
    super(`already in team ${teamId}`);
    this.name = "AlreadyInTeamError";
  }
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
