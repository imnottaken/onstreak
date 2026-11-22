import { randomUUID } from "node:crypto";
import { levelFor, resolveConfig, type ResolvedConfig, type ResolvedLeague, type ResolvedRivalry, type OnstreakConfig, type QuestRule, type QuestReward, type ItemRule, type BoostSpec, type CalendarRule, type StreakRule, matchesWhere, localize, isLocale, boostSpecProblem, achievementLevels, isLeaf, type AchievementCondition, type AchievementLeaf, questGoals, questRunsAt, type QuestGoal } from "./config.js";
import { currentRound, nextRoundKey, nextTier, outcomeFor, roundFromKey, zoneFor, type LeagueOutcome, type LeagueRound, type LeagueZone } from "./leagues.js";
import { breakPeriod, missedBetween, shiftPeriod, streakPeriodKey, streakPeriodsBetween, initialStreak, recordActivity, streakStatus, type StreakState, type StreakStatus } from "./streaks.js";
import { AlreadyInTeamError, FriendLimitError, RivalLimitError, TeamFullError, type EventRecord, type LeaderboardEntry, type Membership, type ProfileData, type ProfilePatch, type PublicProfile, type BoostRecord, type CalendarState, type ItemUseRecord, type ReferralRecord, type PurchaseRecord, type Store, type UserTx, type WebhookDelivery } from "./store/types.js";
import { MAX_WEBHOOK_ATTEMPTS, signWebhook, webhookBackoffMs } from "./webhooks.js";
import type { WebhookEventType } from "./config.js";
import { addDays, isValidTimeZone, leaderboardWindow, periodKey, periodsBetween, startOfDay, type LeaderboardPeriod } from "./time.js";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** A stable reason clients can branch on, e.g. "insufficient_funds". */
    readonly code?: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface TrackInput {
  userId: string;
  event: string;
  /** How much happened (minutes, steps, lessons). Default 1. */
  value?: number;
  /** ISO string or epoch ms. Default now. */
  timestamp?: string | number;
  /** IANA zone the user is in, for streak days. Default from config. */
  timezone?: string;
  /** Retries with the same key return the first result instead of counting twice. */
  idempotencyKey?: string;
  /** Extra facts rules can filter on, e.g. { difficulty: "hard", score: 92 }. Up to 20 keys, 2 KB. */
  properties?: Record<string, string | number | boolean>;
}

const PROPERTY_KEY = /^[a-z0-9_]{1,40}$/i;

function validateProperties(input: unknown): Record<string, string | number | boolean> | null {
  if (input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EngineError("properties must be an object");
  const entries = Object.entries(input);
  if (entries.length > 20) throw new EngineError("properties can have at most 20 keys");
  for (const [k, v] of entries) {
    if (!PROPERTY_KEY.test(k)) throw new EngineError(`property name "${k}" must be 1-40 letters, digits or _`);
    const ok = (typeof v === "string" && v.length <= 200) || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";
    if (!ok) throw new EngineError(`property "${k}" must be a string (at most 200 characters), a number or true/false`);
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 2048) throw new EngineError("properties must be at most 2 KB of JSON");
  return { ...(input as Record<string, string | number | boolean>) };
}

export interface TrackResult {
  eventId: string;
  userId: string;
  event: string;
  value: number;
  duplicate: boolean;
  points: Record<string, { awarded: number; total: number }>;
  /** `rewards` lists what reaching new levels paid (already in `points`). */
  level: { current: number; previous: number; leveledUp: boolean; rewards?: QuestReward[] } | null;
  /** `progress` is this period's total so far, for streaks with a minimum. */
  streaks: Record<string, { current: number; longest: number; freezes: number; extended: boolean; freezesUsed: number; reset: boolean; progress?: number }>;
  /** Achievements (or tiers of one) this event unlocked. Their rewards are already in `points`. */
  achievements: Array<{ id: string; name: string; description?: string; tier?: { level: number; name: string }; rewards?: QuestReward[] }>;
  /** Leagues this event counted toward. `joined` is true the first time in a round. */
  leagues: Record<string, { tier: string; group: number; joined: boolean; previous: LeaguePrevious | null }>;
  /** Quests this event moved forward. `completed` is true on the event that finished one; its rewards are already in `points`. */
  quests: Record<string, { progress: number; target: number; completed: boolean; rewards: QuestReward[]; goals?: Array<{ progress: number; target: number }> }>;
  /** Reward calendar days this event claimed. Their rewards are already in `points`. */
  calendars: Record<string, { day: number; rewards: QuestReward[] }>;
  /** Set when this event qualified the user's referral. Their own rewards are already in `points`; the referrer is paid separately. */
  referral: { referrerId: string; rewards: QuestReward[] } | null;
  /** Multipliers applied to this event's points from point rules (not quest rewards). Null currency means every currency. */
  multipliers: Record<string, { factor: number; currency: string | null }>;
}

/** How the user's last finished round of a league ended. */
export interface LeaguePrevious {
  round: string;
  tier: string;
  rank: number;
  outcome: LeagueOutcome;
  nextTier: string;
  /** What finishing at this rank paid (paid once, when the round settled). */
  rewards: QuestReward[];
}

/** A ranked user, with the name and avatar they chose (null if none). */
export interface RankedUser extends LeaderboardEntry {
  displayName: string | null;
  avatarUrl: string | null;
}

export interface LeagueStatus {
  id: string;
  /** The tier the user is in now (or will join in when they next earn points). */
  tier: string;
  tiers: string[];
  round: { key: string; startsAt: string; endsAt: string };
  /** The user's group this round, or null if they have not earned points yet this round. */
  group: { number: number; size: number; entries: Array<RankedUser & { zone: LeagueZone }> } | null;
  you: (RankedUser & { zone: LeagueZone }) | null;
  previous: LeaguePrevious | null;
}

export interface UserProfile {
  userId: string;
  profile: ProfileData;
  /** Points earned, per currency. Spending does not lower these. */
  points: Record<string, number>;
  /** Points left to spend in the reward store: earned minus spent. */
  wallet: Record<string, number>;
  /** Items owned, by item id. */
  inventory: Record<string, number>;
  /** Personal boosts running now or queued to start, soonest first. */
  boosts: Boost[];
  /** startsAt: points where the current level began; nextAt: points for the next one (null at max). */
  /** With prestige, `points` counts from the last prestige and `prestige` is how many times the user has started over. */
  level: { current: number; points: number; startsAt: number; nextAt: number | null; prestige: number } | null;
  metrics: Record<string, number>;
  /** `repairableUntil` is set while a broken streak can still be repaired. */
  streaks: Record<string, { current: number; longest: number; freezes: number; lastPeriod: string | null; status: StreakStatus; repairableUntil?: string; progress?: number }>;
  /** Unlocked achievements; a tiered badge appears once per tier reached. */
  achievements: Array<{ id: string; name: string; description?: string; tier?: { level: number; name: string }; unlockedAt: string }>;
}

export type LeaderboardScope = "all" | "friends";

export interface LeaderboardResult {
  id: string;
  currency: string;
  period: LeaderboardPeriod;
  scope: LeaderboardScope;
  /** Set when the entries are the places around the user rather than the top. */
  around?: number;
  /** Set when only users with this profile metadata were ranked. */
  segment?: { key: string; value: string };
  from: string | null;
  to: string | null;
  entries: RankedUser[];
  user: RankedUser | null;
}

export interface StreaksAtRisk {
  streak: string;
  /** Users whose streak is still going but who have not done this period's activity yet. */
  users: Array<{
    userId: string;
    displayName: string | null;
    current: number;
    /** Freezes left once the periods already missed are covered. */
    freezes: number;
    /** When the period ends in the user's time zone. Missing it uses a freeze, or breaks the streak. */
    endsAt: string;
    /** True when no freeze is left, so missing this period breaks the streak. */
    lastChance: boolean;
  }>;
  /** Pass as `cursor` to keep going, or null when every user was checked. */
  nextCursor: string | null;
}

export interface ReversalResult {
  userId: string;
  eventId: string;
  /** Points taken back, per currency (the event's awards, quest and achievement rewards included). */
  points: Record<string, number>;
  /** Totals after the reversal. */
  totals: Record<string, number>;
}

export interface WebhookDeliveryList {
  deliveries: Array<{
    id: string;
    webhookId: string;
    type: string;
    userId: string;
    status: "pending" | "delivered" | "failed";
    attempts: number;
    /** When the next attempt is due (pending only). */
    nextAttemptAt: string | null;
    lastError: string | null;
    createdAt: string;
    deliveredAt: string | null;
    /** The JSON body that is (or was) sent. */
    payload: Record<string, unknown>;
  }>;
  nextCursor: string | null;
}

export interface UserExport {
  exportedAt: string;
  user: UserProfile;
  events: EventHistory["events"];
  purchases: Purchase[];
  friends: FriendList["friends"];
  team: { id: string; name: string; joinedAt: string } | null;
  referrals: { referredBy: string | null; referred: string[] } | null;
}

export interface ConfigPreview {
  /** Users checked. */
  users: number;
  /** True when there were more users than were checked. */
  truncated: boolean;
  /** How many users' level would go up, down or stay, or null without levels in both configs. */
  levels: { up: number; down: number; same: number } | null;
  /** By achievement id (or "id#2" for a tier): users who would unlock it on their next event, and users who have it but would no longer qualify. */
  achievements: Record<string, { wouldUnlock: number; noLongerQualify: number }>;
}

export interface LeaderboardHistory {
  id: string;
  currency: string;
  period: LeaderboardPeriod;
  /** Finished windows, newest first, each with its winners as they stood when it closed. */
  windows: Array<{ from: string; to: string; entries: RankedUser[] }>;
}

export interface EventHistory {
  events: Array<{
    id: string;
    event: string;
    value: number;
    timestamp: string;
    recordedAt: string;
    properties: Record<string, string | number | boolean>;
    /** When the event was reversed, or null. */
    reversedAt: string | null;
    /** What the event awarded, as returned by track(). */
    result: TrackResult | null;
  }>;
  /** Pass as `cursor` to get the next (older) page, or null at the end. */
  nextCursor: string | null;
}

export interface FriendList {
  userId: string;
  friends: Array<{ userId: string; displayName: string | null; avatarUrl: string | null; since: string }>;
}

export type RivalOutcome = "won" | "lost" | "draw";

export interface QuestStatus {
  id: string;
  name: string;
  description?: string;
  period: "daily" | "weekly" | "once";
  /** The one-off quest this one unlocked after, if any. */
  after?: string;
  /** Event or points goal, as configured (absent for missions, which have `goals`). */
  goal?: QuestGoal;
  /** A mission's goals, each with its own progress. Then `progress` and `target` count goals done. */
  goals?: Array<QuestGoal & { progress: number }>;
  progress: number;
  target: number;
  completed: boolean;
  completedAt: string | null;
  rewards: QuestReward[];
  /** The current period: progress resets at endsAt. Null for one-off quests (endsAt is their `to` date, if any). */
  startsAt: string | null;
  endsAt: string | null;
  /** When a limited-time quest stops running, or null if it always runs. */
  until: string | null;
}

export interface QuestList {
  userId: string;
  quests: QuestStatus[];
}

/** An item in the reward store, from one user's point of view. */
export interface StoreItemStatus {
  id: string;
  name: string;
  description?: string;
  price: { currency: string; amount: number };
  /** Most a user can own, or null for no limit. */
  limit: number | null;
  metadata?: Record<string, unknown>;
  owned: number;
  /** The user can afford one more and is under the limit. */
  canBuy: boolean;
}

export interface RewardStore {
  userId: string;
  wallet: Record<string, number>;
  items: StoreItemStatus[];
}

export interface PurchaseInput {
  item: string;
  /** How many to buy at once. Default 1. */
  quantity?: number;
  /** Retries with the same key return the first purchase instead of charging twice. */
  idempotencyKey?: string;
}

export interface Purchase {
  id: string;
  item: string;
  /** The item's current name, or null if it is no longer in the config. */
  name: string | null;
  quantity: number;
  cost: { currency: string; amount: number };
  purchasedAt: string;
  /** How many were refunded. */
  refunded: number;
}

export interface PurchaseResult {
  userId: string;
  purchase: Purchase;
  duplicate: boolean;
  /** Spendable balances after the purchase. */
  wallet: Record<string, number>;
  /** How many of the item the user owns now. */
  owned: number;
}

/** A personal multiplier on points from point rules. Null currency means every currency. */
export interface Boost {
  id: string;
  factor: number;
  currency: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface BoostInput extends BoostSpec {
  /** Shown back to you, e.g. "welcome_back" or "support". Default "boost". */
  reason?: string;
  /** Retries with the same key return the first boost instead of adding another. */
  idempotencyKey?: string;
}

export interface BoostResult {
  userId: string;
  boost: Boost;
  duplicate: boolean;
  /** Every boost running now or queued, soonest first. */
  boosts: Boost[];
}

export interface CalendarStatus {
  id: string;
  name?: string;
  event: string;
  /** The day claimed today, or the day the next claim will pay. */
  day: number;
  claimedToday: boolean;
  days: Array<{ day: number; rewards: QuestReward[]; status: "claimed" | "today" | "upcoming" }>;
  /** When today ends and the next day can be claimed. */
  nextClaimAt: string;
}

export interface CalendarList {
  userId: string;
  calendars: CalendarStatus[];
}

export interface ReferralResult {
  userId: string;
  referrerId: string;
  /** False if this referral was already recorded. */
  created: boolean;
  /** Whether the new user has qualified, so both sides are paid. */
  qualified: boolean;
  /** What the new user was paid by this call. */
  rewards: QuestReward[];
}

export interface ReferralList {
  userId: string;
  referredBy: { userId: string; qualified: boolean } | null;
  /** People this user referred, newest first. */
  referred: Array<{ userId: string; displayName: string | null; avatarUrl: string | null; since: string; qualified: boolean; rewarded: boolean }>;
  /** Referrals this user has been rewarded for, and the most they can be (null: no limit). */
  rewarded: number;
  max: number | null;
}

export interface CommunityGoalStatus {
  id: string;
  name: string;
  description?: string;
  goal: { event: string; target: number } | { points: string; target: number };
  /** Everyone's total so far. */
  progress: number;
  target: number;
  completed: boolean;
  status: "upcoming" | "active" | "ended";
  startsAt: string;
  endsAt: string;
  rewards: QuestReward[];
  /** Least a user must contribute to share the rewards (0 means anything above 0). */
  minContribution: number;
  /** The asking user's part, when a userId was given. */
  you: {
    contribution: number;
    /** Contributed enough to share the rewards once the goal is reached. */
    eligible: boolean;
    /** Has received the rewards (now or earlier). */
    rewarded: boolean;
    /** What this request paid (rewards are paid the first time an eligible user looks after the goal is reached). */
    paidNow: QuestReward[];
  } | null;
}

export interface CommunityGoalList {
  goals: CommunityGoalStatus[];
}

export interface StreakRepairResult {
  userId: string;
  streak: string;
  /** The streak as it stands after the repair: do today's activity to extend it. */
  current: number;
  status: StreakStatus;
  cost: { currency: string; amount: number } | null;
  wallet: Record<string, number>;
}

export interface SeasonAward {
  top: number;
  title?: string;
  rewards: QuestReward[];
}

export interface SeasonStatus {
  id: string;
  name: string;
  currency: string;
  status: "upcoming" | "active" | "ended";
  startsAt: string;
  endsAt: string;
  /** Reward tiers, best first. */
  rewards: SeasonAward[];
  /** The asking user's place, when a userId was given. */
  you: {
    score: number;
    /** Null until they score in the season. */
    rank: number | null;
    /** The best tier their rank reaches: final once the season has ended. */
    award: SeasonAward | null;
    /** Whether the award was paid (now or before). Awards are paid the first time the user looks after the season ends. */
    rewarded: boolean;
    paidNow: QuestReward[];
  } | null;
}

export interface SeasonList {
  seasons: SeasonStatus[];
}

export interface SeasonStandings {
  id: string;
  name: string;
  currency: string;
  status: "upcoming" | "active" | "ended";
  startsAt: string;
  endsAt: string;
  /** True once the season has ended: these standings will not change. */
  final: boolean;
  entries: RankedUser[];
  user: RankedUser | null;
}

export interface Team {
  id: string;
  name: string;
  createdAt: string;
}

export interface TeamStatus extends Team {
  maxMembers: number;
  /** Earliest joined first. With a leaderboard, `score` is what each earned for the team in its window. */
  members: Array<{ userId: string; displayName: string | null; avatarUrl: string | null; joinedAt: string; score?: number }>;
  /** The team's place on a leaderboard, when one was asked for. */
  leaderboard: { id: string; score: number; rank: number } | null;
}

export interface TeamGoalStatus {
  id: string;
  name: string;
  description?: string;
  period: "daily" | "weekly";
  goal: QuestGoal;
  /** The team's total this period, from members' activity since they joined. */
  progress: number;
  target: number;
  completed: boolean;
  rewards: QuestReward[];
  startsAt: string;
  endsAt: string;
  /** Current members' contributions this period, biggest first. */
  contributions: Array<{ userId: string; amount: number }>;
  /** The asking member's part, when a userId was given. */
  you: { contribution: number; rewarded: boolean; paidNow: QuestReward[] } | null;
}

export interface TeamGoalList {
  teamId: string;
  goals: TeamGoalStatus[];
}

export interface AchievementStatus {
  id: string;
  /** Null for a hidden achievement nobody has shown the user yet. */
  name: string | null;
  description?: string;
  hidden: boolean;
  /** At least one level unlocked (for a plain achievement: unlocked). */
  unlocked: boolean;
  /** Every level unlocked. */
  completed: boolean;
  /** When the most recent level unlocked. */
  unlockedAt: string | null;
  /** Toward the next level (or the last one once completed). Null while hidden. */
  progress: { current: number; target: number; percent: number } | null;
  tiers?: Array<{ level: number; name: string; gte: number; unlockedAt: string | null }>;
  rewards?: QuestReward[];
}

export interface AchievementList {
  userId: string;
  achievements: AchievementStatus[];
}

export interface TeamLeaderboard {
  id: string;
  currency: string;
  period: LeaderboardPeriod;
  from: string | null;
  to: string | null;
  entries: Array<{ rank: number; teamId: string; name: string; score: number }>;
  team: { rank: number; teamId: string; name: string; score: number } | null;
}

const TEAM_ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

export interface ItemUseInput {
  /** How many to use at once. Default 1. */
  quantity?: number;
  /** Retries with the same key return the first result instead of using more. */
  idempotencyKey?: string;
}

export interface ItemUseResult {
  userId: string;
  item: string;
  used: number;
  /** How many the user has left. */
  owned: number;
  duplicate: boolean;
  /** What using it did, if the item has an effect. */
  effects: {
    streakFreeze?: { streak: string; freezes: number };
    /** The boosts this use queued: from the first one's start to the last one's end. */
    boost?: { factor: number; currency: string | null; startsAt: string; endsAt: string };
  };
}

export interface RefundResult {
  userId: string;
  purchase: Purchase;
  /** What this call gave back. */
  refund: { quantity: number; amount: number; currency: string };
  wallet: Record<string, number>;
  /** How many of the item the user owns now. */
  owned: number;
}

export interface PurchaseHistory {
  purchases: Purchase[];
  /** Pass as `cursor` to get the next (older) page, or null at the end. */
  nextCursor: string | null;
}

export interface RivalryStatus {
  rivalryId: string;
  userId: string;
  /** The round being played now. */
  round: { key: string; startsAt: string; endsAt: string };
  rivals: Array<{
    rivalId: string;
    displayName: string | null;
    avatarUrl: string | null;
    since: string;
    /** Points each side has earned so far this round. */
    current: { you: number; them: number; leading: "you" | "them" | "tied" };
    /** Finished rounds where at least one side scored. */
    record: { wins: number; losses: number; draws: number };
    /** The run of identical results ending with the last counted round. */
    streak: { outcome: RivalOutcome; length: number } | null;
    last: { round: string; you: number; them: number; outcome: RivalOutcome } | null;
  }>;
}

/** Rounds settled per rival per request at most; any more settle on the next request. */
const MAX_SETTLE_ROUNDS = 260;

export type BatchItemResult = { ok: true; result: TrackResult } | { ok: false; status: number; error: string };

const USER_ID = /^[^\s]{1,128}$/;
const EVENT_KEY = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const MAX_LIMIT = 100;
export const MAX_BATCH = 100;
const MAX_METADATA_BYTES = 8 * 1024;
const PROFILE_FIELDS = new Set(["displayName", "avatarUrl", "metadata", "timezone"]);
const MAX_QUANTITY = 1000;

/** Trim float noise from sums like 0.1 + 0.2. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const REASON = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

const WINDOW_PERIOD = { day: "daily", week: "weekly", month: "monthly" } as const;

/**
 * How far a condition is: a value against its `gte`, or for all/any the
 * number of parts met (all: out of every part; any: 1 once one is met).
 */
async function conditionProgress(c: AchievementCondition, read: (leaf: AchievementLeaf) => Promise<number>): Promise<{ current: number; target: number }> {
  if (isLeaf(c)) return { current: await read(c), target: c.gte ?? 0 };
  const list = "all" in c ? c.all : c.any;
  let met = 0;
  for (const part of list) {
    const p = await conditionProgress(part, read);
    if (p.current >= p.target) met++;
  }
  return "all" in c ? { current: met, target: list.length } : { current: met > 0 ? 1 : 0, target: 1 };
}

/** The period a quest is in at `ms`: a day or week, or the single "once" period of a one-off quest. */
function questRound(q: QuestRule, timezone: string, ms: number): { key: string; from: number | null; to: number | null } {
  if (q.period === "once") return { key: "once", from: q.from ? Date.parse(q.from) : null, to: q.to ? Date.parse(q.to) : null };
  return currentRound({ period: q.period, timezone }, ms);
}

/**
 * When a broken streak stops being repairable: `withinHours` after the start
 * of the first period that broke it (the one after the last period the
 * freezes could cover). Null if the streak has no repair rule or no history.
 */
function repairDeadline(rule: StreakRule, state: StreakState, timezone: string): number | null {
  if (!rule.repair || state.lastPeriod === null || state.current === 0) return null;
  const brokeAt = startOfDay(breakPeriod(rule, state.lastPeriod, state.freezes), timezone);
  return brokeAt + rule.repair.withinHours * 3_600_000;
}

/**
 * The calendar day a claim on `today` would pay, or null if the user already
 * claimed today (or `today` is before their last claim).
 */
function nextCalendarDay(rule: CalendarRule, state: CalendarState | null, today: string): number | null {
  if (!state) return 1;
  const gap = periodsBetween(state.lastPeriod, today, "daily");
  if (gap <= 0) return null;
  if (gap > 1 && (rule.missed ?? "reset") === "reset") return 1;
  if (state.day < rule.days.length) return state.day + 1;
  return (rule.afterLast ?? "repeat") === "repeat" ? 1 : rule.days.length;
}

const toBoost = (b: BoostRecord): Boost => ({
  id: b.id,
  factor: b.factor,
  currency: b.currency,
  startsAt: new Date(b.startsAt).toISOString(),
  endsAt: new Date(b.endsAt).toISOString(),
  reason: b.reason,
});

/**
 * Add a boost. A boost with the same factor and currency as one already
 * running or queued starts when the last of those ends, so stacking the same
 * boost extends it instead of multiplying it.
 */
async function queueBoost(tx: UserTx, spec: BoostSpec, now: number, reason: string, idempotencyKey: string | null): Promise<BoostRecord> {
  const currency = spec.currency ?? null;
  const same = (await tx.getBoosts(now)).filter((b) => b.factor === spec.factor && b.currency === currency);
  const startsAt = Math.max(now, ...same.map((b) => b.endsAt));
  const record: BoostRecord = { id: randomUUID(), currency, factor: spec.factor, startsAt, endsAt: startsAt + spec.minutes * 60_000, reason, idempotencyKey };
  await tx.addBoost(record);
  return record;
}

function checkLocale(locale: unknown): asserts locale is string | undefined {
  if (locale !== undefined && !isLocale(locale)) throw new EngineError(`locale "${String(locale)}" must look like "en", "es" or "pt-BR"`);
}

function checkUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces (max 128 chars)");
}

function encodeCursor(e: { ts: number; id: string }): string {
  return Buffer.from(`${e.ts}:${e.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { ts: number; id: string } {
  const [ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  const n = Number(ts);
  if (!Number.isFinite(n) || !id || !/^[0-9a-f-]{36}$/.test(id)) throw new EngineError("cursor is not valid");
  return { ts: n, id };
}

/** Check a profile patch and return a clean copy. */
function validateProfilePatch(input: unknown): ProfilePatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EngineError("body must be a JSON object");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!PROFILE_FIELDS.has(key)) throw new EngineError(`unknown field "${key}" (allowed: displayName, avatarUrl, metadata, timezone)`);
  }
  const patch: ProfilePatch = {};
  if ("displayName" in raw) {
    const v = raw.displayName;
    if (v === null) patch.displayName = null;
    else if (typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 80) patch.displayName = v.trim();
    else throw new EngineError("displayName must be 1-80 characters, or null");
  }
  if ("avatarUrl" in raw) {
    const v = raw.avatarUrl;
    if (v === null) patch.avatarUrl = null;
    else {
      let ok = false;
      if (typeof v === "string" && v.length <= 2048) {
        try {
          ok = ["http:", "https:"].includes(new URL(v).protocol);
        } catch {
          ok = false;
        }
      }
      if (!ok) throw new EngineError("avatarUrl must be an http(s) URL of at most 2048 characters, or null");
      patch.avatarUrl = v as string;
    }
  }
  if ("metadata" in raw) {
    const v = raw.metadata;
    if (v === null) patch.metadata = null;
    else if (typeof v === "object" && !Array.isArray(v)) {
      if (Buffer.byteLength(JSON.stringify(v)) > MAX_METADATA_BYTES) throw new EngineError("metadata must be at most 8 KB of JSON");
      patch.metadata = v as Record<string, unknown>;
    } else throw new EngineError("metadata must be a JSON object, or null");
  }
  if ("timezone" in raw) {
    const v = raw.timezone;
    if (v === null) patch.timezone = null;
    else if (typeof v === "string" && isValidTimeZone(v)) patch.timezone = v;
    else throw new EngineError(`unknown timezone "${String(v)}"`);
  }
  return patch;
}

export class Engine {
  readonly config: ResolvedConfig;

  constructor(
    config: OnstreakConfig,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.config = resolveConfig(config);
  }

  /** The engine's clock (Date.now unless a test clock was given). */
  clock(): number {
    return this.now();
  }

  async track(input: TrackInput): Promise<TrackResult> {
    const { userId, event } = input ?? ({} as TrackInput);
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces (max 128 chars)");
    if (typeof event !== "string" || !EVENT_KEY.test(event)) throw new EngineError("event must be 1-64 letters, digits, _ . : -");
    const value = input.value ?? 1;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new EngineError("value must be a positive number");
    const ts = input.timestamp === undefined ? this.now() : new Date(input.timestamp).getTime();
    if (!Number.isFinite(ts)) throw new EngineError("timestamp must be an ISO date or epoch milliseconds");
    if (input.timezone !== undefined && (typeof input.timezone !== "string" || !isValidTimeZone(input.timezone))) {
      throw new EngineError(`unknown timezone "${String(input.timezone)}"`);
    }
    const idempotencyKey = input.idempotencyKey ?? null;
    if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
      throw new EngineError("idempotencyKey must be a string of 1-200 characters");
    }
    const properties = validateProperties(input.properties);

    const { config } = this;
    const tracked = await this.store.withUser(userId, async (tx) => {
      if (idempotencyKey) {
        const previous = await tx.findByIdempotencyKey(idempotencyKey);
        if (previous) return { ...previous, duplicate: true };
      }

      // Streak days use the zone sent with the event, else the one remembered
      // for this user, else the config default. A zone sent with an event is remembered.
      const profile = await tx.getProfile();
      if (input.timezone && input.timezone !== profile.timezone) await tx.updateProfile({ timezone: input.timezone });
      const timezone = input.timezone ?? profile.timezone ?? config.defaultTimezone;

      const recordedAt = this.now();
      const eventId = randomUUID();
      await tx.insertEvent({ id: eventId, userId, key: event, value, ts, recordedAt, idempotencyKey, properties });
      const metrics = new Map<string, number>([[event, await tx.addMetric(event, value)]]);

      // With prestige, levels count from the total at the last prestige.
      const levelBase = config.levels?.prestige ? (await tx.getPrestige()).base : 0;
      const levelBefore = config.levels ? levelFor(config.levels, (await tx.getBalance(config.levels.currency)) - levelBase) : null;

      const streaks: TrackResult["streaks"] = {};
      const streakStates = new Map<string, StreakState>();
      for (const rule of config.streaks) {
        if (rule.event !== event || !matchesWhere(rule.where, properties)) continue;
        let prev = (await tx.getStreak(rule.id)) ?? initialStreak(rule);
        const period = streakPeriodKey(rule, ts, timezone);
        let progress: number | undefined;
        let enough = true;
        if (rule.minimum !== undefined) {
          const filling = prev.progressPeriod ?? null;
          if (filling !== null && streakPeriodsBetween(rule, filling, period) < 0) {
            // A late event for a period before the one being filled changes nothing.
            enough = false;
            progress = prev.progress ?? 0;
          } else {
            progress = round6((filling === period ? (prev.progress ?? 0) : 0) + value);
            prev = { ...prev, progressPeriod: period, progress };
            enough = progress >= rule.minimum;
          }
        }
        const update = enough ? recordActivity(rule, prev, period) : { state: prev, extended: false, freezesUsed: 0, reset: false };
        if (update.extended || rule.minimum !== undefined) await tx.setStreak(rule.id, update.state);
        streakStates.set(rule.id, update.state);
        streaks[rule.id] = {
          current: update.state.current,
          longest: update.state.longest,
          freezes: update.state.freezes,
          extended: update.extended,
          freezesUsed: update.freezesUsed,
          reset: update.reset,
          ...(progress !== undefined ? { progress } : {}),
        };
      }

      // Multipliers that apply to this event: time windows it falls in, and
      // streak steps reached (counting this event's activity).
      const multipliers: TrackResult["multipliers"] = {};
      for (const m of config.multipliers) {
        let factor: number | null = null;
        if (m.kind === "window") {
          if (ts >= m.from && ts < m.to) factor = m.factor;
        } else {
          // A streak this event did not touch may have lapsed since; count it as it stands now.
          const rule = config.streaks.find((r) => r.id === m.streak)!;
          const state = streakStates.get(m.streak) ?? (await tx.getStreak(m.streak));
          const current = state ? streakStatus(rule, state, streakPeriodKey(rule, ts, timezone)).current : 0;
          factor = [...m.steps].reverse().find((step) => current >= step.gte)?.factor ?? null;
        }
        if (factor !== null && factor !== 1) multipliers[m.id] = { factor, currency: m.currency };
      }
      // Personal boosts running when the event happened. Ones granted later never reach back.
      for (const b of await tx.getBoosts(ts)) {
        if (b.startsAt <= ts && b.factor !== 1) multipliers[`boost:${b.id}`] = { factor: b.factor, currency: b.currency };
      }
      const factorFor = (currency: string) =>
        Object.values(multipliers).reduce((f, m) => (m.currency === null || m.currency === currency ? f * m.factor : f), 1);

      const points: TrackResult["points"] = {};
      for (const rule of config.points) {
        if (rule.event !== event || !matchesWhere(rule.where, properties)) continue;
        let base = rule.multiplyByValue ? rule.amount * value : rule.amount;
        if (rule.multiplyBy !== undefined) {
          const factor = properties?.[rule.multiplyBy];
          base = typeof factor === "number" ? rule.amount * factor : 0;
        }
        const amount = Math.round(base * factorFor(rule.currency) * 1e6) / 1e6;
        if (amount === 0) continue;
        const total = await tx.addPoints(rule.currency, amount, ts, eventId, recordedAt);
        const entry = points[rule.currency] ?? { awarded: 0, total };
        entry.awarded += amount;
        entry.total = total;
        points[rule.currency] = entry;
      }

      // Quests. Only events in the period running now count, and each quest pays
      // its rewards once per period. Points goals count what the rules above
      // awarded, not other quests' rewards.
      const quests: TrackResult["quests"] = {};
      const earned = new Map(Object.entries(points).map(([c, p]) => [c, p.awarded]));
      const completedNow = new Set<string>();
      for (const quest of config.quests) {
        if (!questRunsAt(quest, ts)) continue;
        const goals = questGoals(quest);
        const gains = goals.map((g) => ("event" in g ? (g.event === event && matchesWhere(g.where, properties) ? value : 0) : (earned.get(g.points) ?? 0)));
        if (gains.every((gain) => gain <= 0)) continue;
        // A chained quest starts counting with the first event after the one that unlocked it.
        if (quest.after !== undefined && (completedNow.has(quest.after) || (await tx.getQuest(quest.after, "once"))?.completedAt == null)) continue;
        const zone = quest.timezone ?? timezone;
        const round = questRound(quest, zone, ts);
        if (round.key !== questRound(quest, zone, recordedAt).key) continue;
        const prev = await tx.getQuest(quest.id, round.key);
        if (prev?.completedAt != null) continue;
        let progress: number;
        let target: number;
        let parts: Array<{ progress: number; target: number }> | undefined;
        if (quest.goals) {
          // A mission keeps each goal's progress in its own row ("id#0", "id#1", ...).
          parts = [];
          for (const [i, g] of quest.goals.entries()) {
            const key = `${quest.id}#${i}`;
            let p = (await tx.getQuest(key, round.key))?.progress ?? 0;
            if (gains[i]! > 0 && p < g.target) {
              p = Math.min(g.target, p + gains[i]!);
              await tx.setQuest({ questId: key, periodKey: round.key, progress: p, completedAt: p >= g.target ? recordedAt : null });
            }
            parts.push({ progress: p, target: g.target });
          }
          progress = parts.filter((p) => p.progress >= p.target).length;
          target = parts.length;
        } else {
          target = goals[0]!.target;
          progress = Math.min(target, (prev?.progress ?? 0) + gains[0]!);
        }
        const completed = progress >= target;
        if (completed) completedNow.add(quest.id);
        await tx.setQuest({ questId: quest.id, periodKey: round.key, progress, completedAt: completed ? recordedAt : null });
        const rewards = completed ? (quest.rewards ?? []).map((r) => ({ ...r })) : [];
        for (const r of rewards) {
          const total = await tx.addPoints(r.currency, r.amount, ts, eventId, recordedAt);
          const entry = points[r.currency] ?? { awarded: 0, total };
          entry.awarded += r.amount;
          entry.total = total;
          points[r.currency] = entry;
        }
        quests[quest.id] = { progress, target, completed, rewards, ...(parts ? { goals: parts } : {}) };
      }

      // Reward calendars: the first matching event each day claims the next day.
      // Like quests, only events from today count.
      const calendars: TrackResult["calendars"] = {};
      for (const cal of config.calendars) {
        if (cal.event !== event) continue;
        const zone = cal.timezone ?? timezone;
        const today = periodKey(ts, "daily", zone);
        if (today !== periodKey(recordedAt, "daily", zone)) continue;
        const day = nextCalendarDay(cal, await tx.getCalendar(cal.id), today);
        if (day === null) continue;
        await tx.setCalendar(cal.id, { day, lastPeriod: today });
        const rewards = cal.days[day - 1]!.rewards.map((r) => ({ ...r }));
        for (const r of rewards) {
          const total = await tx.addPoints(r.currency, r.amount, ts, eventId, recordedAt);
          const entry = points[r.currency] ?? { awarded: 0, total };
          entry.awarded += r.amount;
          entry.total = total;
          points[r.currency] = entry;
        }
        calendars[cal.id] = { day, rewards };
      }

      // Referrals: doing enough of the qualifying event pays the new user now; the referrer is paid after this transaction.
      let referral: TrackResult["referral"] = null;
      const qualify = config.referrals?.qualify;
      if (qualify && qualify.event === event) {
        const ref = await tx.getReferral();
        const done = metrics.get(event) ?? (await tx.getMetric(event));
        if (ref && ref.qualifiedAt === null && done >= qualify.target) {
          await tx.qualifyReferral(recordedAt);
          const rewards = (config.referrals!.referred ?? []).map((r) => ({ ...r }));
          for (const r of rewards) {
            const total = await tx.addPoints(r.currency, r.amount, ts, eventId, recordedAt);
            const entry = points[r.currency] ?? { awarded: 0, total };
            entry.awarded += r.amount;
            entry.total = total;
            points[r.currency] = entry;
          }
          referral = { referrerId: ref.referrerId, rewards };
        }
      }

      const achievements: TrackResult["achievements"] = [];
      if (config.achievements.length > 0) {
        const unlocked = await tx.unlockedAchievements();
        for (const a of config.achievements) {
          const levels = achievementLevels(a).filter((l) => !unlocked.has(l.key));
          if (levels.length === 0) continue;
          const { current: progress } = await conditionProgress(a.when, async (leaf) => {
            if ("streak" in leaf) return (streakStates.get(leaf.streak) ?? (await tx.getStreak(leaf.streak)))?.current ?? 0;
            if (leaf.within) {
              const { from, to } = leaderboardWindow(WINDOW_PERIOD[leaf.within], ts, timezone);
              return tx.windowTotal("metric" in leaf ? "event" : "points", "metric" in leaf ? leaf.metric : leaf.points, from!, to!);
            }
            return "metric" in leaf ? (metrics.get(leaf.metric) ?? (await tx.getMetric(leaf.metric))) : tx.getBalance(leaf.points);
          });
          for (const l of levels) {
            if (progress < l.gte) break;
            await tx.unlock(l.key, ts);
            for (const r of l.rewards) {
              const total = await tx.addPoints(r.currency, r.amount, ts, eventId, recordedAt);
              const entry = points[r.currency] ?? { awarded: 0, total };
              entry.awarded += r.amount;
              entry.total = total;
              points[r.currency] = entry;
            }
            achievements.push({
              id: a.id,
              name: a.name,
              ...(a.description ? { description: a.description } : {}),
              ...(l.tier ? { tier: l.tier } : {}),
              ...(l.rewards.length ? { rewards: l.rewards } : {}),
            });
          }
        }
      }

      let level: TrackResult["level"] = null;
      if (config.levels && levelBefore !== null) {
        let current = levelFor(config.levels, (await tx.getBalance(config.levels.currency)) - levelBase);
        const paid: QuestReward[] = [];
        // Pay each level passed; a reward in the level currency can push the user further.
        let rewardedUpTo = levelBefore;
        while (current > rewardedUpTo) {
          for (const entry of config.levels.rewards) {
            if (entry.level <= rewardedUpTo || entry.level > current) continue;
            for (const r of entry.rewards) {
              const total = await tx.addPoints(r.currency, r.amount, ts, eventId, recordedAt);
              const p = points[r.currency] ?? { awarded: 0, total };
              p.awarded += r.amount;
              p.total = total;
              points[r.currency] = p;
              const same = paid.find((x) => x.currency === r.currency);
              if (same) same.amount += r.amount;
              else paid.push({ ...r });
            }
          }
          rewardedUpTo = current;
          current = levelFor(config.levels, (await tx.getBalance(config.levels.currency)) - levelBase);
        }
        level = { current, previous: levelBefore, leveledUp: current > levelBefore, ...(paid.length ? { rewards: paid } : {}) };
      }

      const leagues: TrackResult["leagues"] = {};
      const now = recordedAt;
      for (const league of config.leagues) {
        if ((points[league.currency]?.awarded ?? 0) <= 0) continue;
        // Only points earned in the round that is running now count toward a league.
        if (currentRound(league, ts).key !== currentRound(league, now).key) continue;
        const seat = await this.seat(tx, userId, league, now, ts);
        if (seat.current) {
          leagues[league.id] = { tier: seat.tier, group: seat.current.group, joined: seat.joined, previous: seat.joined ? seat.previous : null };
        }
      }

      const result: TrackResult = { eventId, userId, event, value, duplicate: false, points, level, streaks, achievements, leagues, quests, calendars, referral, multipliers };
      if (config.webhooks.length > 0) await tx.enqueueWebhooks(this.webhooksFor(result, recordedAt));
      await tx.setEventResult(eventId, result);
      return result;
    });
    if (tracked.referral && !tracked.duplicate) await this.settleReferrer(tracked.referral.referrerId);
    return tracked;
  }

  async getUser(userId: string, options: { timezone?: string; locale?: string } = {}): Promise<UserProfile> {
    checkLocale(options.locale);
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    if (options.timezone !== undefined && !isValidTimeZone(options.timezone)) throw new EngineError(`unknown timezone "${options.timezone}"`);

    const [snap, boosts] = await Promise.all([this.store.snapshot(userId), this.store.boosts(userId, this.now())]);
    const timezone = options.timezone ?? snap.profile.timezone ?? this.config.defaultTimezone;
    const points: Record<string, number> = {};
    const wallet: Record<string, number> = {};
    for (const c of this.config.currencies) {
      points[c] = snap.balances[c] ?? 0;
      wallet[c] = round6(points[c] - (snap.spent[c] ?? 0));
    }

    let level: UserProfile["level"] = null;
    if (this.config.levels) {
      const total = round6((points[this.config.levels.currency] ?? 0) - (this.config.levels.prestige ? snap.prestige.base : 0));
      level = {
        prestige: snap.prestige.rank,
        current: levelFor(this.config.levels, total),
        points: total,
        startsAt: [...this.config.levels.thresholds].reverse().find((t) => t <= total) ?? 0,
        nextAt: this.config.levels.thresholds.find((t) => t > total) ?? null,
      };
    }

    const now = this.now();
    const streaks: UserProfile["streaks"] = {};
    for (const rule of this.config.streaks) {
      const state = snap.streaks[rule.id] ?? initialStreak(rule);
      const nowPeriod = streakPeriodKey(rule, now, timezone);
      const status = streakStatus(rule, state, nowPeriod);
      const until = repairDeadline(rule, state, timezone);
      streaks[rule.id] = {
        ...status,
        ...(status.status === "broken" && until !== null && now < until ? { repairableUntil: new Date(until).toISOString() } : {}),
        ...(rule.minimum !== undefined ? { progress: state.progressPeriod === nowPeriod ? (state.progress ?? 0) : 0 } : {}),
      };
    }

    const names = new Map(this.config.achievements.map((a) => [a.id, a]));
    const achievements = snap.achievements
      .map((a) => {
        const [id, level] = a.id.split("#") as [string, string | undefined];
        const rule = names.get(id);
        const tier = rule && level !== undefined ? rule.tiers?.[Number(level) - 1] : undefined;
        if (!rule || (level !== undefined && !tier)) return null;
        return {
          id,
          ...localize(rule, options.locale),
          ...(tier ? { tier: { level: Number(level), name: localize(tier, options.locale).name } } : {}),
          unlockedAt: a.unlockedAt,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    return { userId, profile: snap.profile, points, wallet, inventory: snap.inventory, boosts: boosts.map(toBoost), level, metrics: snap.metrics, streaks, achievements };
  }

  /** Every achievement with the user's progress toward it. Hidden ones stay secret until unlocked. */
  async achievements(userId: string, options: { locale?: string } = {}): Promise<AchievementList> {
    checkUserId(userId);
    checkLocale(options.locale);
    const snap = await this.store.snapshot(userId);
    const now = this.now();
    const timezone = snap.profile.timezone ?? this.config.defaultTimezone;
    const unlockedAt = new Map(snap.achievements.map((a) => [a.id, a.unlockedAt]));
    const read = this.snapshotReader(this.config, userId, snap, now);
    const currents = new Map<string, number>();
    for (const a of this.config.achievements) currents.set(a.id, (await conditionProgress(a.when, read)).current);
    return {
      userId,
      achievements: this.config.achievements.map((a): AchievementStatus => {
        const levels = achievementLevels(a);
        const done = levels.filter((l) => unlockedAt.has(l.key));
        const unlocked = done.length > 0;
        const completed = done.length === levels.length;
        const last = done.map((l) => unlockedAt.get(l.key)!).sort().at(-1) ?? null;
        if (a.hidden && !unlocked) {
          return { id: a.id, name: null, hidden: true, unlocked: false, completed: false, unlockedAt: null, progress: null };
        }
        const current = currents.get(a.id)!;
        const target = (levels.find((l) => !unlockedAt.has(l.key)) ?? levels[levels.length - 1]!).gte;
        const percent = target <= 0 ? 100 : Math.min(100, Math.floor((current / target) * 100));
        return {
          id: a.id,
          ...localize(a, options.locale),
          hidden: Boolean(a.hidden),
          unlocked,
          completed,
          unlockedAt: last,
          progress: { current, target, percent: completed ? 100 : percent },
          ...(a.tiers ? { tiers: a.tiers.map((t, i) => ({ level: i + 1, name: localize(t, options.locale).name, gte: t.gte, unlockedAt: unlockedAt.get(`${a.id}#${i + 1}`) ?? null })) } : {}),
          ...(a.rewards ? { rewards: a.rewards.map((r) => ({ ...r })) } : {}),
        };
      }),
    };
  }

  /** Outbox rows for what an event did, one per webhook that wants each kind. */
  private webhooksFor(r: TrackResult, at: number): WebhookDelivery[] {
    const notes: Array<{ type: WebhookEventType; data: Record<string, unknown> }> = [];
    if (r.level?.leveledUp) notes.push({ type: "level.up", data: { previous: r.level.previous, current: r.level.current } });
    for (const a of r.achievements) notes.push({ type: "achievement.unlocked", data: { ...a } });
    for (const [streak, s] of Object.entries(r.streaks)) {
      if (s.reset) notes.push({ type: "streak.broken", data: { streak } });
      if (s.extended) notes.push({ type: "streak.extended", data: { streak, current: s.current, longest: s.longest } });
    }
    for (const [quest, q] of Object.entries(r.quests)) if (q.completed) notes.push({ type: "quest.completed", data: { quest, rewards: q.rewards } });
    for (const [league, l] of Object.entries(r.leagues)) if (l.joined && l.previous) notes.push({ type: "league.settled", data: { league, ...l.previous } });
    return this.deliveriesFor(notes, r.userId, r.eventId, at);
  }

  /** One outbox row per note per webhook that wants its type. A null user is a system notice (e.g. a season ending). */
  private deliveriesFor(notes: Array<{ type: WebhookEventType; data: Record<string, unknown> }>, userId: string | null, eventId: string | null, at: number): WebhookDelivery[] {
    const rows: WebhookDelivery[] = [];
    for (const n of notes) {
      for (const hook of this.config.webhooks) {
        if (!hook.events.has(n.type)) continue;
        const id = randomUUID();
        rows.push({
          id,
          webhookId: hook.id,
          type: n.type,
          userId: userId ?? "",
          payload: { id, type: n.type, createdAt: new Date(at).toISOString(), userId, eventId, data: n.data },
          status: "pending",
          attempts: 0,
          nextAttemptAt: at,
          lastError: null,
          createdAt: at,
          deliveredAt: null,
        });
      }
    }
    return rows;
  }

  /**
   * Everything onstreak stores about a user, in one JSON document (for data
   * access requests). Events and purchases are included in full.
   */
  async exportUser(userId: string): Promise<UserExport> {
    checkUserId(userId);
    const events: EventHistory["events"] = [];
    let cursor: string | undefined;
    do {
      const page = await this.events(userId, { limit: MAX_LIMIT, ...(cursor ? { cursor } : {}) });
      events.push(...page.events);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const purchases: Purchase[] = [];
    cursor = undefined;
    do {
      const page = await this.purchases(userId, { limit: MAX_LIMIT, ...(cursor ? { cursor } : {}) });
      purchases.push(...page.purchases);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const team = (await this.userTeam(userId)).team;
    let referrals: UserExport["referrals"] = null;
    if (this.config.referrals) {
      const r = await this.store.referrals(userId);
      referrals = { referredBy: r.referredBy?.referrerId ?? null, referred: r.referred.map((x) => x.referredId) };
    }
    return {
      exportedAt: new Date(this.now()).toISOString(),
      user: await this.getUser(userId),
      events,
      purchases,
      friends: (await this.friends(userId)).friends,
      team: team ? { id: team.id, name: team.name, joinedAt: team.joinedAt } : null,
      referrals,
    };
  }

  /**
   * Delete a user and everything about them (right to erasure). Their points
   * leave every leaderboard and league group, and friendships, rivalries and
   * referrals involving them are removed on both sides. Cannot be undone.
   */
  async deleteUser(userId: string): Promise<{ userId: string; deleted: boolean }> {
    checkUserId(userId);
    return { userId, deleted: await this.store.deleteUser(userId) };
  }

  /**
   * Run the scheduled jobs once (the server does every minute): queue a
   * streak.at_risk webhook for users whose period ends within the streak's
   * remindBeforeHours and who have not acted yet (once per user per period),
   * and a season.ended webhook once for each season that ended in the last
   * 7 days, with its top 3. Safe to run from several servers at once.
   */
  async runScheduledJobs(): Promise<{ reminders: number; seasonsEnded: number }> {
    const wants = (type: WebhookEventType) => this.config.webhooks.some((w) => w.events.has(type));
    let reminders = 0;
    let seasonsEnded = 0;
    const now = this.now();
    if (wants("streak.at_risk")) {
      for (const rule of this.config.streaks) {
        if (rule.remindBeforeHours === undefined) continue;
        let cursor: string | undefined;
        do {
          const page = await this.streaksAtRisk(rule.id, { limit: 500, endingWithinHours: rule.remindBeforeHours, ...(cursor ? { cursor } : {}) });
          for (const u of page.users) {
            const rows = this.deliveriesFor([{ type: "streak.at_risk", data: { streak: rule.id, current: u.current, freezes: u.freezes, endsAt: u.endsAt, lastChance: u.lastChance } }], u.userId, null, now);
            if (await this.store.enqueueOnce(`remind:${rule.id}:${u.userId}:${u.endsAt}`, now, rows)) reminders++;
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
    }
    if (wants("season.ended")) {
      for (const s of this.config.seasons) {
        if (s.to > now || now - s.to > 7 * 86_400_000) continue;
        const standings = await this.seasonStandings(s.id, { limit: 3 });
        const rows = this.deliveriesFor([{ type: "season.ended", data: { season: s.id, name: s.name, endsAt: standings.endsAt, top: standings.entries } }], null, null, now);
        if (await this.store.enqueueOnce(`season-ended:${s.id}`, now, rows)) seasonsEnded++;
      }
    }
    return { reminders, seasonsEnded };
  }

  /**
   * Send due webhook deliveries once. Run it on a timer (the server does, every
   * few seconds). Each POST carries `onstreak-signature`, `onstreak-event` and
   * `onstreak-delivery` headers; a 2xx answer counts as delivered, anything
   * else is retried with backoff and marked failed after 8 attempts.
   */
  async deliverWebhooks(options: { limit?: number; timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<{ attempted: number; delivered: number; failed: number }> {
    const send = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const now = this.now();
    const due = await this.store.claimWebhooks(now, options.limit ?? 50, timeoutMs + 60_000);
    let delivered = 0;
    let failed = 0;
    await Promise.all(
      due.map(async (d) => {
        const hook = this.config.webhooks.find((w) => w.id === d.webhookId);
        const attempts = d.attempts + 1;
        if (!hook) {
          failed++;
          await this.store.updateWebhook(d.id, { status: "failed", attempts, nextAttemptAt: now, lastError: "webhook is no longer configured", deliveredAt: null });
          return;
        }
        const body = JSON.stringify(d.payload);
        let error: string | null = null;
        try {
          const res = await send(hook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": "onstreak-webhooks",
              "onstreak-event": d.type,
              "onstreak-delivery": d.id,
              "onstreak-signature": signWebhook(hook.secret, body, Math.floor(this.now() / 1000)),
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) error = `HTTP ${res.status}`;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (error === null) {
          delivered++;
          await this.store.updateWebhook(d.id, { status: "delivered", attempts, nextAttemptAt: now, lastError: null, deliveredAt: this.now() });
        } else {
          const gaveUp = attempts >= MAX_WEBHOOK_ATTEMPTS;
          if (gaveUp) failed++;
          await this.store.updateWebhook(d.id, { status: gaveUp ? "failed" : "pending", attempts, nextAttemptAt: now + webhookBackoffMs(attempts), lastError: error.slice(0, 500), deliveredAt: null });
        }
      }),
    );
    return { attempted: due.length, delivered, failed };
  }

  /** Webhook deliveries, newest first: what was sent, when, and why one failed. */
  async webhookDeliveries(options: { status?: string; limit?: number; cursor?: string } = {}): Promise<WebhookDeliveryList> {
    const status = options.status;
    if (status !== undefined && !["pending", "delivered", "failed"].includes(status)) throw new EngineError('status must be "pending", "delivered" or "failed"');
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const before = options.cursor ? decodeCursor(options.cursor) : undefined;
    const rows = await this.store.webhookDeliveries({ ...(status ? { status: status as WebhookDelivery["status"] } : {}), limit: limit + 1, ...(before ? { before } : {}) });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      deliveries: page.map((d) => ({
        id: d.id,
        webhookId: d.webhookId,
        type: d.type,
        userId: d.userId,
        status: d.status,
        attempts: d.attempts,
        nextAttemptAt: d.status === "pending" ? new Date(d.nextAttemptAt).toISOString() : null,
        lastError: d.lastError,
        createdAt: new Date(d.createdAt).toISOString(),
        deliveredAt: d.deliveredAt === null ? null : new Date(d.deliveredAt).toISOString(),
        payload: d.payload,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.createdAt, id: last.id }) : null,
    };
  }

  /** Reads achievement condition values from a snapshot, as of `now`. */
  private snapshotReader(config: ResolvedConfig, userId: string, snap: Awaited<ReturnType<Store["snapshot"]>>, now: number) {
    const timezone = snap.profile.timezone ?? config.defaultTimezone;
    return async (leaf: AchievementLeaf): Promise<number> => {
      if ("streak" in leaf) {
        const rule = config.streaks.find((r) => r.id === leaf.streak)!;
        const state = snap.streaks[rule.id];
        return state ? streakStatus(rule, state, streakPeriodKey(rule, now, timezone)).current : 0;
      }
      if (leaf.within) {
        const { from, to } = leaderboardWindow(WINDOW_PERIOD[leaf.within], now, timezone);
        const kind = "metric" in leaf ? "event" : "points";
        return this.store.communityTotal({ kind, key: "metric" in leaf ? leaf.metric : leaf.points, from: from!, to: to!, userId });
      }
      return "metric" in leaf ? (snap.metrics[leaf.metric] ?? 0) : (snap.balances[leaf.points] ?? 0);
    };
  }

  /**
   * What a new config would change for existing users, without changing
   * anything: who would move up or down a level, and who would newly
   * unlock each achievement (on their next event) or no longer qualify for
   * one they have. Scans up to `maxUsers` users (default 100000).
   */
  async previewConfig(input: unknown, options: { maxUsers?: number } = {}): Promise<ConfigPreview> {
    let next: ResolvedConfig;
    try {
      next = resolveConfig(input as OnstreakConfig);
    } catch (err) {
      if (err instanceof Error && err.name === "ConfigError") throw new EngineError(err.message);
      throw err;
    }
    const maxUsers = options.maxUsers ?? 100_000;
    const now = this.now();
    const levelOf = (cfg: ResolvedConfig, snap: Awaited<ReturnType<Store["snapshot"]>>) =>
      cfg.levels ? levelFor(cfg.levels, (snap.balances[cfg.levels.currency] ?? 0) - (cfg.levels.prestige ? snap.prestige.base : 0)) : null;
    const levels = { up: 0, down: 0, same: 0 };
    const achievements: ConfigPreview["achievements"] = {};
    for (const a of next.achievements) for (const l of achievementLevels(a)) achievements[l.key] = { wouldUnlock: 0, noLongerQualify: 0 };
    let users = 0;
    let after: string | null = null;
    let truncated = false;
    for (;;) {
      const ids = await this.store.userIds(after, 500);
      if (ids.length === 0) break;
      for (const userId of ids) {
        if (users >= maxUsers) {
          truncated = true;
          break;
        }
        users++;
        const snap = await this.store.snapshot(userId);
        const before = levelOf(this.config, snap);
        const afterLevel = levelOf(next, snap);
        if (before !== null && afterLevel !== null) {
          if (afterLevel > before) levels.up++;
          else if (afterLevel < before) levels.down++;
          else levels.same++;
        }
        const have = new Set(snap.achievements.map((x) => x.id));
        const read = this.snapshotReader(next, userId, snap, now);
        for (const a of next.achievements) {
          const { current } = await conditionProgress(a.when, read);
          for (const l of achievementLevels(a)) {
            const qualifies = current >= l.gte;
            if (qualifies && !have.has(l.key)) achievements[l.key]!.wouldUnlock++;
            if (!qualifies && have.has(l.key)) achievements[l.key]!.noLongerQualify++;
          }
        }
      }
      if (truncated) break;
      after = ids[ids.length - 1]!;
    }
    return { users, truncated, levels: this.config.levels && next.levels ? levels : null, achievements };
  }

  /**
   * Top entries for the current window. With `scope: "friends"`, only the user
   * and their friends are ranked, and friends with no points yet are included.
   */
  async leaderboard(
    id: string,
    options: { limit?: number; userId?: string; scope?: LeaderboardScope; around?: number; segment?: { key: string; value: string } } = {},
  ): Promise<LeaderboardResult> {
    const rule = this.config.leaderboards.find((l) => l.id === id);
    if (!rule) throw new EngineError(`unknown leaderboard "${id}"`, 404);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const scope = options.scope ?? "all";
    if (scope !== "all" && scope !== "friends") throw new EngineError('scope must be "all" or "friends"');
    if (scope === "friends" && !options.userId) throw new EngineError("a friends leaderboard needs userId");
    const { around, segment } = options;
    if (around !== undefined) {
      if (!Number.isInteger(around) || around < 1 || around > 50) throw new EngineError("around must be a whole number from 1 to 50");
      if (!options.userId) throw new EngineError("around needs userId");
    }
    if (segment !== undefined) {
      if (!segment || typeof segment.key !== "string" || !PROPERTY_KEY.test(segment.key) || typeof segment.value !== "string" || segment.value.length < 1 || segment.value.length > 200) {
        throw new EngineError('segment must be "key:value", with a key of letters, digits or _');
      }
    }
    if (scope === "friends" && (around !== undefined || segment !== undefined)) throw new EngineError("around and segment work with scope all only");
    const { from, to } = leaderboardWindow(rule.period, this.now(), rule.timezone ?? "UTC");

    let entries: LeaderboardEntry[];
    let user: LeaderboardEntry | null;
    if (scope === "friends") {
      const userId = options.userId as string;
      const ids = [userId, ...(await this.store.friends(userId)).map((f) => f.userId)];
      const scored = await this.store.leaderboard({ currency: rule.currency, from, to, limit: ids.length, userIds: ids });
      const scores = new Map(scored.entries.map((e) => [e.userId, e.score]));
      const ranked = rankScores(ids.map((u) => ({ userId: u, score: scores.get(u) ?? 0 })));
      entries = ranked.slice(0, limit);
      user = ranked.find((e) => e.userId === userId) ?? null;
    } else {
      ({ entries, user } = await this.store.leaderboard({
        currency: rule.currency,
        from,
        to,
        limit,
        ...(options.userId ? { userId: options.userId } : {}),
        ...(around !== undefined ? { around } : {}),
        ...(segment ? { segment } : {}),
      }));
    }
    const names = await this.store.profiles([...new Set([...entries, ...(user ? [user] : [])].map((e) => e.userId))]);
    return {
      id: rule.id,
      currency: rule.currency,
      period: rule.period,
      scope,
      from: from === null ? null : new Date(from).toISOString(),
      to: to === null ? null : new Date(to).toISOString(),
      ...(around !== undefined ? { around } : {}),
      ...(segment ? { segment: { ...segment } } : {}),
      entries: entries.map((e) => withProfile(e, names)),
      user: user ? withProfile(user, names) : null,
    };
  }

  /**
   * Reverse an event (a mistake, fraud, a refunded lesson): take back every
   * point it awarded, dated at the event's own time so leaderboard windows
   * and league rounds correct themselves, and undo its count in metrics.
   * Streaks, quests and achievements it unlocked are left as they are (revoke
   * achievements separately). 409 with code "already_reversed" on repeat.
   */
  async reverseEvent(userId: string, eventId: string): Promise<ReversalResult> {
    checkUserId(userId);
    return this.store.withUser(userId, async (tx) => {
      const e = typeof eventId === "string" ? await tx.getEvent(eventId) : null;
      if (!e) throw new EngineError(`${userId} has no event "${String(eventId)}"`, 404);
      if (e.reversedAt != null) throw new EngineError("this event was already reversed", 409, "already_reversed");
      const now = this.now();
      const taken: Record<string, number> = {};
      const totals: Record<string, number> = {};
      for (const [currency, p] of Object.entries(e.result?.points ?? {})) {
        if (p.awarded === 0) continue;
        totals[currency] = await tx.addPoints(currency, -p.awarded, e.ts, e.id, now);
        taken[currency] = p.awarded;
      }
      if (e.result && !e.result.duplicate) await tx.addMetric(e.key, -e.value);
      await tx.markReversed(e.id, now);
      for (const c of this.config.currencies) totals[c] ??= await tx.getBalance(c);
      return { userId, eventId: e.id, points: taken, totals };
    });
  }

  /** Take back an achievement (or one tier, "id#2"). Returns whether it was unlocked. Points it paid stay unless you reverse them. */
  async revokeAchievement(userId: string, achievementId: string): Promise<{ userId: string; achievementId: string; revoked: boolean }> {
    checkUserId(userId);
    const [id, level] = String(achievementId).split("#");
    const rule = this.config.achievements.find((a) => a.id === id);
    if (!rule || (level !== undefined && !rule.tiers?.[Number(level) - 1])) throw new EngineError(`unknown achievement "${String(achievementId)}"`, 404);
    return this.store.withUser(userId, async (tx) => ({ userId, achievementId, revoked: await tx.revokeAchievement(achievementId) }));
  }

  /**
   * Start levels over: a user at the top level goes back to level 1 with
   * their prestige rank one higher, and is paid levels.prestige.rewards.
   * Earned points are kept; only the level counts from here. 409 with code
   * "not_max_level" before the top level.
   */
  async prestige(userId: string): Promise<{ userId: string; prestige: number; level: number; rewards: QuestReward[] }> {
    checkUserId(userId);
    const levels = this.config.levels;
    if (!levels?.prestige) throw new EngineError("prestige is not configured", 404);
    const prestigeRewards = levels.prestige.rewards;
    return this.store.withUser(userId, async (tx) => {
      const { rank, base } = await tx.getPrestige();
      const balance = await tx.getBalance(levels.currency);
      const max = levels.thresholds.length + 1;
      if (levelFor(levels, balance - base) < max) throw new EngineError(`${userId} needs to reach level ${max} first`, 409, "not_max_level");
      const now = this.now();
      await tx.setPrestige(rank + 1, balance, now);
      const eventId = randomUUID();
      for (const r of prestigeRewards) await tx.addPoints(r.currency, r.amount, now, eventId, now);
      // A reward in the level currency already counts toward the new climb.
      const after = levelFor(levels, (await tx.getBalance(levels.currency)) - balance);
      return { userId, prestige: rank + 1, level: after, rewards: prestigeRewards.map((r) => ({ ...r })) };
    });
  }

  /**
   * Users who have a streak going but have not done this period's activity
   * yet, for reminders ("your 12-day streak ends at midnight"). Each user's
   * own time zone decides when their period ends. Pages by user id.
   */
  async streaksAtRisk(streakId: string, options: { limit?: number; cursor?: string; endingWithinHours?: number } = {}): Promise<StreaksAtRisk> {
    const rule = this.config.streaks.find((s) => s.id === streakId);
    if (!rule) throw new EngineError(`unknown streak "${String(streakId)}"`, 404);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new EngineError("limit must be a whole number from 1 to 500");
    const within = options.endingWithinHours;
    if (within !== undefined && !(typeof within === "number" && within > 0 && within <= 24 * 31)) throw new EngineError("endingWithinHours must be above 0 and at most 744");
    let after: string | null = null;
    if (options.cursor !== undefined) {
      try {
        after = Buffer.from(options.cursor, "base64url").toString("utf8");
      } catch {
        after = null;
      }
      if (!after || !USER_ID.test(after)) throw new EngineError("cursor is not valid");
    }
    const now = this.now();
    const found: Array<Omit<StreaksAtRisk["users"][number], "displayName">> = [];
    let lastSeen: string | null = after;
    let exhausted = false;
    // Scan in pages until the page is full; at most 20 pages per call.
    for (let page = 0; page < 20 && found.length < limit; page++) {
      const rows = await this.store.activeStreaks(rule.id, lastSeen, 500);
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      for (const row of rows) {
        lastSeen = row.userId;
        const zone = row.timezone ?? this.config.defaultTimezone;
        const period = streakPeriodKey(rule, now, zone);
        const status = streakStatus(rule, row.state, period);
        if (status.status !== "pending") continue;
        const next = shiftPeriod(rule, period, 1);
        // Skipping a period that is not required (a weekend with skipWeekends) costs nothing.
        if (missedBetween(rule, row.state.lastPeriod!, next) === missedBetween(rule, row.state.lastPeriod!, period)) continue;
        const endsAt = startOfDay(next, zone);
        if (within !== undefined && endsAt - now > within * 3_600_000) continue;
        found.push({ userId: row.userId, current: status.current, freezes: status.freezes - missedBetween(rule, row.state.lastPeriod!, period), endsAt: new Date(endsAt).toISOString(), lastChance: breakPeriod(rule, row.state.lastPeriod!, row.state.freezes) === next });
        if (found.length === limit) break;
      }
      if (rows.length < 500 && found.length < limit) {
        exhausted = true;
        break;
      }
    }
    const names = await this.store.profiles(found.map((f) => f.userId));
    return {
      streak: rule.id,
      users: found.map((f) => ({ ...f, displayName: names[f.userId]?.displayName ?? null })),
      nextCursor: exhausted || lastSeen === null ? null : Buffer.from(lastSeen).toString("base64url"),
    };
  }

  /**
   * Winners of the last `periods` finished windows, newest first: the top
   * `top` of each, fixed as they stood when the window closed.
   */
  async leaderboardHistory(id: string, options: { periods?: number; top?: number } = {}): Promise<LeaderboardHistory> {
    const rule = this.config.leaderboards.find((l) => l.id === id);
    if (!rule) throw new EngineError(`unknown leaderboard "${id}"`, 404);
    if (rule.period === "all") throw new EngineError("an all-time leaderboard has no past windows");
    const periods = options.periods ?? 5;
    const top = options.top ?? 3;
    if (!Number.isInteger(periods) || periods < 1 || periods > 52) throw new EngineError("periods must be a whole number from 1 to 52");
    if (!Number.isInteger(top) || top < 1 || top > 10) throw new EngineError("top must be a whole number from 1 to 10");
    const zone = rule.timezone ?? "UTC";
    let edge = leaderboardWindow(rule.period, this.now(), zone).from as number;
    const windows: LeaderboardHistory["windows"] = [];
    for (let i = 0; i < periods; i++) {
      const w = leaderboardWindow(rule.period, edge - 1, zone);
      const from = w.from as number;
      const to = w.to as number;
      const { entries } = await this.store.leaderboard({ currency: rule.currency, from, to, limit: top, recordedBefore: to });
      const names = await this.store.profiles(entries.map((e) => e.userId));
      windows.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), entries: entries.map((e) => withProfile(e, names)) });
      edge = from;
    }
    return { id: rule.id, currency: rule.currency, period: rule.period, windows };
  }

  /** Make two users friends. Friendship is mutual. Users that do not exist yet are created. */
  async addFriend(userId: string, friendId: string): Promise<{ userId: string; friendId: string; created: boolean }> {
    this.checkPair(userId, friendId);
    try {
      const created = await this.store.addFriendship(userId, friendId, this.now(), this.config.friends.max);
      return { userId, friendId, created };
    } catch (err) {
      if (err instanceof FriendLimitError) {
        throw new EngineError(`${err.userId} already has the maximum of ${this.config.friends.max} friends`, 409);
      }
      throw err;
    }
  }

  /** End a friendship, for both users. */
  async removeFriend(userId: string, friendId: string): Promise<{ userId: string; friendId: string; removed: boolean }> {
    this.checkPair(userId, friendId);
    return { userId, friendId, removed: await this.store.removeFriendship(userId, friendId) };
  }

  /** A user's friends, newest first, with their names and avatars. */
  /** Every quest for the period running now, with the user's progress. */
  async quests(userId: string, options: { timezone?: string; locale?: string } = {}): Promise<QuestList> {
    checkLocale(options.locale);
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    if (options.timezone !== undefined && !isValidTimeZone(options.timezone)) throw new EngineError(`unknown timezone "${options.timezone}"`);
    const now = this.now();
    let userZone = options.timezone;
    if (userZone === undefined && this.config.quests.some((q) => !q.timezone && questRunsAt(q, now))) {
      userZone = (await this.store.snapshot(userId)).profile.timezone ?? this.config.defaultTimezone;
    }
    const once = this.config.quests.filter((q) => q.period === "once").map((q) => ({ questId: q.id, periodKey: "once" }));
    const candidates = this.config.quests.filter((q) => questRunsAt(q, now));
    const candidateRounds = candidates.map((q) => questRound(q, q.timezone ?? userZone!, now));
    const missionParts = candidates.flatMap((q, i) => (q.goals ?? []).map((_, g) => ({ questId: `${q.id}#${g}`, periodKey: candidateRounds[i]!.key })));
    const stored = await this.store.quests(userId, [
      ...candidates.map((q, i) => ({ questId: q.id, periodKey: candidateRounds[i]!.key })).filter((k) => k.periodKey !== "once"),
      ...once,
      ...missionParts,
    ]);
    const byId = new Map(stored.map((s) => [`${s.questId}|${s.periodKey}`, s]));
    const doneOnce = (id: string) => byId.get(`${id}|once`)?.completedAt != null;
    // Locked quests (their "after" quest is not done yet) are left out.
    const running = candidates.filter((q) => q.after === undefined || doneOnce(q.after));
    const rounds = running.map((q) => candidateRounds[candidates.indexOf(q)]!);
    return {
      userId,
      quests: running.map((q, i) => {
        const round = rounds[i]!;
        const s = byId.get(`${q.id}|${round.key}`);
        return {
          id: q.id,
          ...localize(q, options.locale),
          period: q.period,
          ...(q.after ? { after: q.after } : {}),
          ...(q.goal ? { goal: { ...q.goal } } : {}),
          ...(q.goals ? { goals: q.goals.map((g, gi) => ({ ...g, progress: byId.get(`${q.id}#${gi}|${round.key}`)?.progress ?? 0 })) } : {}),
          progress: s?.progress ?? 0,
          target: q.goals ? q.goals.length : q.goal!.target,
          completed: s?.completedAt != null,
          completedAt: s?.completedAt != null ? new Date(s.completedAt).toISOString() : null,
          rewards: (q.rewards ?? []).map((r) => ({ ...r })),
          startsAt: q.period === "once" ? null : new Date(round.from!).toISOString(),
          endsAt: round.to === null ? null : new Date(round.to).toISOString(),
          until: q.to === undefined ? null : new Date(Date.parse(q.to)).toISOString(),
        };
      }),
    };
  }

  /** Every reward calendar with the user's place in it: what is claimed, what today pays, and what comes next. */
  async calendars(userId: string, options: { timezone?: string; locale?: string } = {}): Promise<CalendarList> {
    checkLocale(options.locale);
    checkUserId(userId);
    if (options.timezone !== undefined && !isValidTimeZone(options.timezone)) throw new EngineError(`unknown timezone "${options.timezone}"`);
    const now = this.now();
    const snap = await this.store.snapshot(userId);
    const userZone = options.timezone ?? snap.profile.timezone ?? this.config.defaultTimezone;
    return {
      userId,
      calendars: this.config.calendars.map((cal): CalendarStatus => {
        const zone = cal.timezone ?? userZone;
        const today = periodKey(now, "daily", zone);
        const state = snap.calendars[cal.id] ?? null;
        const next = nextCalendarDay(cal, state, today);
        const claimedToday = next === null;
        const day = claimedToday ? state!.day : next;
        return {
          id: cal.id,
          ...(cal.name ? { name: localize(cal, options.locale).name } : {}),
          event: cal.event,
          day,
          claimedToday,
          days: cal.days.map((d, i) => ({
            day: i + 1,
            rewards: d.rewards.map((r) => ({ ...r })),
            status: i + 1 < day || (claimedToday && i + 1 === day) ? "claimed" : i + 1 === day ? "today" : "upcoming",
          })),
          nextClaimAt: new Date(currentRound({ period: "daily", timezone: zone }, now).to).toISOString(),
        };
      }),
    };
  }

  /**
   * Record that `referrerId` brought `userId` in. Once per user: a second call
   * with the same referrer is a no-op, another referrer is a 409 with code
   * "already_referred". The new user is paid when they qualify (at once
   * without `referrals.qualify`), and the referrer right after.
   */
  async addReferral(userId: string, referrerId: string): Promise<ReferralResult> {
    checkUserId(userId);
    checkUserId(referrerId);
    const rules = this.config.referrals;
    if (!rules) throw new EngineError("referrals are not configured", 404);
    if (userId === referrerId) throw new EngineError("a user cannot refer themselves");
    const theirs = (await this.store.referrals(referrerId)).referredBy;
    if (theirs?.referrerId === userId) throw new EngineError(`${referrerId} was referred by ${userId}, so ${userId} cannot be referred by them`);

    const result = await this.store.withUser(userId, async (tx): Promise<ReferralResult> => {
      const existing = await tx.getReferral();
      if (existing) {
        if (existing.referrerId !== referrerId) throw new EngineError(`${userId} was already referred by someone else`, 409, "already_referred");
        return { userId, referrerId, created: false, qualified: existing.qualifiedAt !== null, rewards: [] };
      }
      const now = this.now();
      const qualified = !rules.qualify || (await tx.getMetric(rules.qualify.event)) >= rules.qualify.target;
      const record: ReferralRecord = { id: randomUUID(), referrerId, referredId: userId, createdAt: now, qualifiedAt: qualified ? now : null, settledAt: null, rewarded: false };
      await tx.addReferral(record);
      const rewards = qualified ? (rules.referred ?? []).map((r) => ({ ...r })) : [];
      for (const r of rewards) await tx.addPoints(r.currency, r.amount, now, record.id, now);
      return { userId, referrerId, created: true, qualified, rewards };
    });
    if (result.created && result.qualified) await this.settleReferrer(referrerId);
    return result;
  }

  /** Who referred a user and whom they referred. Pays the user for any referral that qualified but was not paid yet. */
  async referrals(userId: string): Promise<ReferralList> {
    checkUserId(userId);
    const rules = this.config.referrals;
    if (!rules) throw new EngineError("referrals are not configured", 404);
    await this.settleReferrer(userId);
    const { referredBy, referred } = await this.store.referrals(userId);
    const profiles = await this.store.profiles(referred.map((r) => r.referredId));
    return {
      userId,
      referredBy: referredBy ? { userId: referredBy.referrerId, qualified: referredBy.qualifiedAt !== null } : null,
      referred: referred.map((r) => ({
        userId: r.referredId,
        displayName: profiles[r.referredId]?.displayName ?? null,
        avatarUrl: profiles[r.referredId]?.avatarUrl ?? null,
        since: new Date(r.createdAt).toISOString(),
        qualified: r.qualifiedAt !== null,
        rewarded: r.rewarded,
      })),
      rewarded: referred.filter((r) => r.rewarded).length,
      max: rules.max ?? null,
    };
  }

  /** Pay a referrer for referrals that qualified since last time, up to the limit. Safe to call any time. */
  private async settleReferrer(referrerId: string): Promise<void> {
    const rules = this.config.referrals;
    if (!rules) return;
    await this.store.withUser(referrerId, async (tx) => {
      const now = this.now();
      for (const r of await tx.settleReferrals(rules.max ?? null, now)) {
        if (!r.rewarded) continue;
        for (const reward of rules.referrer ?? []) await tx.addPoints(reward.currency, reward.amount, now, r.id, now);
      }
    });
  }

  /**
   * Community goals with everyone's progress. With a userId, also that user's
   * contribution; an eligible user is paid the rewards the first time they
   * look after the goal is reached.
   */
  async communityGoals(options: { userId?: string } = {}): Promise<CommunityGoalList> {
    const userId = options.userId;
    if (userId !== undefined) checkUserId(userId);
    const now = this.now();
    const claimed = userId ? await this.store.communityClaims(userId) : new Set<string>();
    const goals: CommunityGoalStatus[] = [];
    for (const g of this.config.communityGoals) {
      const kind = "event" in g.goal ? "event" : "points";
      const key = "event" in g.goal ? g.goal.event : g.goal.points;
      const progress = round6(await this.store.communityTotal({ kind, key, from: g.from, to: g.to }));
      const target = g.goal.target;
      const completed = progress >= target;
      const rewards = (g.rewards ?? []).map((r) => ({ ...r }));
      let you: CommunityGoalStatus["you"] = null;
      if (userId) {
        const contribution = round6(await this.store.communityTotal({ kind, key, from: g.from, to: g.to, userId }));
        const eligible = g.minContribution === undefined ? contribution > 0 : contribution >= g.minContribution;
        let rewarded = claimed.has(g.id);
        let paidNow: QuestReward[] = [];
        if (completed && eligible && !rewarded) {
          const won = await this.store.withUser(userId, async (tx) => {
            if (!(await tx.claimCommunityReward(g.id, now))) return false;
            const eventId = randomUUID();
            for (const r of rewards) await tx.addPoints(r.currency, r.amount, now, eventId, now);
            return true;
          });
          rewarded = true;
          if (won) paidNow = rewards.map((r) => ({ ...r }));
        }
        you = { contribution, eligible, rewarded, paidNow };
      }
      goals.push({
        id: g.id,
        name: g.name,
        ...(g.description ? { description: g.description } : {}),
        goal: { ...g.goal },
        progress,
        target,
        completed,
        status: now < g.from ? "upcoming" : now < g.to ? "active" : "ended",
        startsAt: new Date(g.from).toISOString(),
        endsAt: new Date(g.to).toISOString(),
        rewards,
        minContribution: g.minContribution ?? 0,
        you,
      });
    }
    return { goals };
  }

  /**
   * Every season with its status. With a userId, that user's score, rank and
   * award; after a season ends, their award is paid the first time they look.
   */
  async seasons(options: { userId?: string } = {}): Promise<SeasonList> {
    const userId = options.userId;
    if (userId !== undefined) checkUserId(userId);
    const now = this.now();
    const awards = userId ? await this.store.seasonAwards(userId) : {};
    const seasons: SeasonStatus[] = [];
    for (const s of this.config.seasons) {
      const status = now < s.from ? "upcoming" : now < s.to ? "active" : "ended";
      let you: SeasonStatus["you"] = null;
      if (userId) {
        const { user } = await this.store.leaderboard({ currency: s.currency, from: s.from, to: s.to, limit: 1, userId, recordedBefore: status === "ended" ? s.to : null });
        const rank = user?.rank ?? null;
        const award = rank === null ? null : (s.rewards.find((tier) => rank <= tier.top) ?? null);
        let rewarded = awards[s.id] !== undefined;
        let paidNow: QuestReward[] = [];
        if (status === "ended" && award && !rewarded) {
          const won = await this.store.withUser(userId, async (tx) => {
            if (!(await tx.claimSeasonAward(s.id, rank!, now))) return false;
            const eventId = randomUUID();
            for (const r of award.rewards) await tx.addPoints(r.currency, r.amount, now, eventId, now);
            return true;
          });
          rewarded = true;
          if (won) paidNow = award.rewards.map((r) => ({ ...r }));
        }
        you = { score: user?.score ?? 0, rank, award: award ? cloneTier(award) : null, rewarded, paidNow };
      }
      seasons.push({
        id: s.id,
        name: s.name,
        currency: s.currency,
        status,
        startsAt: new Date(s.from).toISOString(),
        endsAt: new Date(s.to).toISOString(),
        rewards: s.rewards.map(cloneTier),
        you,
      });
    }
    return { seasons };
  }

  /** A season's standings: live while it runs, fixed once it ends. */
  async seasonStandings(id: string, options: { limit?: number; userId?: string } = {}): Promise<SeasonStandings> {
    const s = this.config.seasons.find((x) => x.id === id);
    if (!s) throw new EngineError(`unknown season "${String(id)}"`, 404);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    if (options.userId !== undefined) checkUserId(options.userId);
    const now = this.now();
    const status = now < s.from ? "upcoming" : now < s.to ? "active" : "ended";
    const { entries, user } = await this.store.leaderboard({
      currency: s.currency,
      from: s.from,
      to: s.to,
      limit,
      ...(options.userId ? { userId: options.userId } : {}),
      recordedBefore: status === "ended" ? s.to : null,
    });
    const names = await this.store.profiles([...new Set([...entries, ...(user ? [user] : [])].map((e) => e.userId))]);
    return {
      id: s.id,
      name: s.name,
      currency: s.currency,
      status,
      startsAt: new Date(s.from).toISOString(),
      endsAt: new Date(s.to).toISOString(),
      final: status === "ended",
      entries: entries.map((e) => withProfile(e, names)),
      user: user ? withProfile(user, names) : null,
    };
  }

  /** Create a team or rename it. */
  async saveTeam(teamId: string, input: { name?: unknown }): Promise<{ team: Team; created: boolean }> {
    if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) throw new EngineError("team id must be 1-64 letters, digits, _ . : -");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new EngineError("body must be a JSON object");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length < 1 || name.length > 80) throw new EngineError("name must be 1-80 characters");
    const created = await this.store.saveTeam({ id: teamId, name, createdAt: this.now() });
    const team = (await this.store.getTeam(teamId))!;
    return { team: { id: team.id, name: team.name, createdAt: new Date(team.createdAt).toISOString() }, created };
  }

  /** A team with its members; with a leaderboard id, each member's points for the team and the team's rank. */
  async team(teamId: string, options: { leaderboard?: string } = {}): Promise<TeamStatus> {
    const team = await this.requireTeam(teamId);
    const members = await this.store.teamMembers(team.id);
    const names = await this.store.profiles(members.map((m) => m.userId));
    let scores: Record<string, number> | null = null;
    let leaderboard: TeamStatus["leaderboard"] = null;
    if (options.leaderboard !== undefined) {
      const rule = this.config.leaderboards.find((l) => l.id === options.leaderboard);
      if (!rule) throw new EngineError(`unknown leaderboard "${String(options.leaderboard)}"`, 404);
      const { from, to } = leaderboardWindow(rule.period, this.now(), rule.timezone ?? "UTC");
      scores = await this.store.teamMemberScores(team.id, rule.currency, from, to);
      const placed = (await this.store.teamScores({ currency: rule.currency, from, to, limit: 1, teamId: team.id })).team;
      leaderboard = { id: rule.id, score: placed?.score ?? 0, rank: placed?.rank ?? 1 };
    }
    return {
      id: team.id,
      name: team.name,
      createdAt: new Date(team.createdAt).toISOString(),
      maxMembers: this.config.teams.maxMembers,
      members: members.map((m) => ({
        userId: m.userId,
        displayName: names[m.userId]?.displayName ?? null,
        avatarUrl: names[m.userId]?.avatarUrl ?? null,
        joinedAt: new Date(m.joinedAt).toISOString(),
        ...(scores ? { score: scores[m.userId] ?? 0 } : {}),
      })),
      leaderboard,
    };
  }

  /**
   * Put a user in a team. A user is in one team at a time: 409 with code
   * "already_in_team" if they are in another (remove them first), and
   * "team_full" past teams.maxMembers. Points count for the team from now on.
   */
  async addTeamMember(teamId: string, userId: string): Promise<{ teamId: string; userId: string; created: boolean }> {
    checkUserId(userId);
    const team = await this.requireTeam(teamId);
    try {
      const created = await this.store.addTeamMember(team.id, userId, this.now(), this.config.teams.maxMembers);
      return { teamId: team.id, userId, created };
    } catch (err) {
      if (err instanceof TeamFullError) throw new EngineError(`team "${team.id}" already has the maximum of ${this.config.teams.maxMembers} members`, 409, "team_full");
      if (err instanceof AlreadyInTeamError) throw new EngineError(`${userId} is already in team "${err.teamId}"`, 409, "already_in_team");
      throw err;
    }
  }

  /** Take a user out of a team. Points they earned for it stop counting. */
  async removeTeamMember(teamId: string, userId: string): Promise<{ teamId: string; userId: string; removed: boolean }> {
    checkUserId(userId);
    const team = await this.requireTeam(teamId);
    return { teamId: team.id, userId, removed: await this.store.removeTeamMember(team.id, userId) };
  }

  /** The team a user is in, if any. */
  async userTeam(userId: string): Promise<{ userId: string; team: (Team & { joinedAt: string }) | null }> {
    checkUserId(userId);
    const m = await this.store.userTeam(userId);
    if (!m) return { userId, team: null };
    const team = (await this.store.getTeam(m.teamId))!;
    return { userId, team: { id: team.id, name: team.name, createdAt: new Date(team.createdAt).toISOString(), joinedAt: new Date(m.joinedAt).toISOString() } };
  }

  /** Teams ranked on a leaderboard by their members' points, each counted from when they joined. */
  async teamLeaderboard(id: string, options: { limit?: number; teamId?: string } = {}): Promise<TeamLeaderboard> {
    const rule = this.config.leaderboards.find((l) => l.id === id);
    if (!rule) throw new EngineError(`unknown leaderboard "${String(id)}"`, 404);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const { from, to } = leaderboardWindow(rule.period, this.now(), rule.timezone ?? "UTC");
    const { entries, team } = await this.store.teamScores({ currency: rule.currency, from, to, limit, ...(options.teamId ? { teamId: options.teamId } : {}) });
    const ids = [...new Set([...entries, ...(team ? [team] : [])].map((e) => e.teamId))];
    const teams = new Map((await Promise.all(ids.map((tid) => this.store.getTeam(tid)))).filter((x): x is NonNullable<typeof x> => x !== null).map((x) => [x.id, x.name]));
    const named = (e: { rank: number; teamId: string; score: number }) => ({ ...e, name: teams.get(e.teamId) ?? e.teamId });
    return {
      id: rule.id,
      currency: rule.currency,
      period: rule.period,
      from: from === null ? null : new Date(from).toISOString(),
      to: to === null ? null : new Date(to).toISOString(),
      entries: entries.map(named),
      team: team ? named(team) : null,
    };
  }

  /**
   * The team's goals for the current day or week. With a userId of a member,
   * also their part; a member who contributed is paid the rewards the first
   * time they look after the goal is reached.
   */
  async teamGoals(teamId: string, options: { userId?: string } = {}): Promise<TeamGoalList> {
    const team = await this.requireTeam(teamId);
    const userId = options.userId;
    if (userId !== undefined) checkUserId(userId);
    const member = userId ? (await this.store.userTeam(userId))?.teamId === team.id : false;
    const claims = userId && member ? await this.store.teamGoalClaims(userId) : new Set<string>();
    const now = this.now();
    const goals: TeamGoalStatus[] = [];
    for (const g of this.config.teamGoals) {
      const round = currentRound({ period: g.period, timezone: g.timezone ?? this.config.defaultTimezone }, now);
      const kind = "event" in g.goal ? "event" : "points";
      const key = "event" in g.goal ? g.goal.event : g.goal.points;
      const by = await this.store.teamContributions(team.id, kind, key, round.from, round.to);
      const progress = round6(Object.values(by).reduce((a, b) => a + b, 0));
      const completed = progress >= g.goal.target;
      const rewards = (g.rewards ?? []).map((r) => ({ ...r }));
      let you: TeamGoalStatus["you"] = null;
      if (userId) {
        const contribution = round6(by[userId] ?? 0);
        let rewarded = claims.has(`${g.id}|${round.key}`);
        let paidNow: QuestReward[] = [];
        if (member && completed && contribution > 0 && !rewarded) {
          const won = await this.store.withUser(userId, async (tx) => {
            if (!(await tx.claimTeamGoalReward(g.id, round.key, team.id, now))) return false;
            const eventId = randomUUID();
            for (const r of rewards) await tx.addPoints(r.currency, r.amount, now, eventId, now);
            return true;
          });
          rewarded = true;
          if (won) paidNow = rewards.map((r) => ({ ...r }));
        }
        you = { contribution, rewarded, paidNow };
      }
      goals.push({
        id: g.id,
        name: g.name,
        ...(g.description ? { description: g.description } : {}),
        period: g.period,
        goal: { ...g.goal },
        progress,
        target: g.goal.target,
        completed,
        rewards,
        startsAt: new Date(round.from).toISOString(),
        endsAt: new Date(round.to).toISOString(),
        contributions: Object.entries(by)
          .map(([u, amount]) => ({ userId: u, amount: round6(amount) }))
          .sort((a, b) => b.amount - a.amount || (a.userId < b.userId ? -1 : 1)),
        you,
      });
    }
    return { teamId: team.id, goals };
  }

  private async requireTeam(teamId: string) {
    if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) throw new EngineError("team id must be 1-64 letters, digits, _ . : -");
    const team = await this.store.getTeam(teamId);
    if (!team) throw new EngineError(`unknown team "${teamId}"`, 404);
    return team;
  }

  async friends(userId: string): Promise<FriendList> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const friends = await this.store.friends(userId);
    return {
      userId,
      friends: friends.map((f) => ({ userId: f.userId, displayName: f.displayName, avatarUrl: f.avatarUrl, since: new Date(f.since).toISOString() })),
    };
  }

  /** Start a rivalry between two users (mutual, safe to repeat). Counting starts with the current round. */
  async addRival(rivalryId: string, userId: string, rivalId: string): Promise<{ rivalryId: string; userId: string; rivalId: string; created: boolean }> {
    const rule = this.rivalry(rivalryId);
    this.checkPair(userId, rivalId, "rivalId", "rival");
    const now = this.now();
    try {
      const created = await this.store.addRivalry(rule.id, userId, rivalId, currentRound(rule, now).key, now, rule.max);
      return { rivalryId: rule.id, userId, rivalId, created };
    } catch (err) {
      if (err instanceof RivalLimitError) throw new EngineError(`${err.userId} already has the maximum of ${rule.max} rivals in "${rule.id}"`, 409);
      throw err;
    }
  }

  /** End a rivalry for both users. Its history is dropped. */
  async removeRival(rivalryId: string, userId: string, rivalId: string): Promise<{ rivalryId: string; userId: string; rivalId: string; removed: boolean }> {
    const rule = this.rivalry(rivalryId);
    this.checkPair(userId, rivalId, "rivalId", "rival");
    return { rivalryId: rule.id, userId, rivalId, removed: await this.store.removeRivalry(rule.id, userId, rivalId) };
  }

  /**
   * A user's rivals with this round's live score, their record and streak.
   * Finished rounds are settled here, on first look, then stored.
   */
  async rivals(rivalryId: string, userId: string): Promise<RivalryStatus> {
    const rule = this.rivalry(rivalryId);
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const now = this.now();
    const round = currentRound(rule, now);
    const records = await this.store.rivalries(rule.id, userId);

    const rivals: RivalryStatus["rivals"] = [];
    for (const r of records) {
      const rounds = [...r.rounds];
      const known = new Set(rounds.map((x) => x.roundKey));
      let key = r.startedRound;
      for (let i = 0; key < round.key && i < MAX_SETTLE_ROUNDS; i++, key = nextRoundKey(rule, key)) {
        if (known.has(key)) continue;
        const win = roundFromKey(rule, key);
        // Final: only points recorded before the round ended count, so late events cannot change it.
        const s = await this.store.windowScores({ currency: rule.currency, from: win.from, to: win.to, recordedBefore: win.to, userIds: [userId, r.rivalId] });
        const you = s[userId] ?? 0;
        const them = s[r.rivalId] ?? 0;
        await this.store.recordRivalryRound(rule.id, userId, r.rivalId, key, you, them);
        rounds.push({ roundKey: key, you, them });
      }
      rounds.sort((a, b) => (a.roundKey < b.roundKey ? -1 : 1));

      const live = await this.store.windowScores({ currency: rule.currency, from: round.from, to: round.to, recordedBefore: null, userIds: [userId, r.rivalId] });
      const you = live[userId] ?? 0;
      const them = live[r.rivalId] ?? 0;

      // Rounds where neither side scored are not contests: they count for nothing and break nothing.
      const counted = rounds.filter((x) => x.you > 0 || x.them > 0).map((x) => ({ ...x, outcome: rivalOutcome(x.you, x.them) }));
      const record = { wins: 0, losses: 0, draws: 0 };
      for (const x of counted) record[x.outcome === "won" ? "wins" : x.outcome === "lost" ? "losses" : "draws"]++;
      const last = counted[counted.length - 1];
      let streak: RivalryStatus["rivals"][number]["streak"] = null;
      if (last) {
        let length = 0;
        for (let i = counted.length - 1; i >= 0 && counted[i]!.outcome === last.outcome; i--) length++;
        streak = { outcome: last.outcome, length };
      }

      rivals.push({
        rivalId: r.rivalId,
        displayName: null,
        avatarUrl: null,
        since: new Date(r.since).toISOString(),
        current: { you, them, leading: you > them ? "you" : them > you ? "them" : "tied" },
        record,
        streak,
        last: last ? { round: last.roundKey, you: last.you, them: last.them, outcome: last.outcome } : null,
      });
    }

    const names = await this.store.profiles(rivals.map((r) => r.rivalId));
    for (const r of rivals) {
      r.displayName = names[r.rivalId]?.displayName ?? null;
      r.avatarUrl = names[r.rivalId]?.avatarUrl ?? null;
    }
    return {
      rivalryId: rule.id,
      userId,
      round: { key: round.key, startsAt: new Date(round.from).toISOString(), endsAt: new Date(round.to).toISOString() },
      rivals,
    };
  }

  private rivalry(id: string): ResolvedRivalry {
    const rule = this.config.rivalries.find((r) => r.id === id);
    if (!rule) throw new EngineError(`unknown rivalry "${id}"`, 404);
    return rule;
  }

  private checkPair(userId: string, friendId: string, field = "friendId", noun = "friend"): void {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    if (typeof friendId !== "string" || !USER_ID.test(friendId)) throw new EngineError(`${field} must be a non-empty string without spaces`);
    if (userId === friendId) throw new EngineError(`a user cannot be their own ${noun}`);
  }

  /** Throws if the store (database) cannot be reached. */
  async ping(): Promise<void> {
    await this.store.ping();
  }

  /** Release the store's connections. Call once, when shutting down. */
  async close(): Promise<void> {
    await this.store.close();
  }

  /** A user's tier, their group's live standings this round, and how last round ended. */
  async league(id: string, userId: string): Promise<LeagueStatus> {
    const league = this.config.leagues.find((l) => l.id === id);
    if (!league) throw new EngineError(`unknown league "${id}"`, 404);
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const now = this.now();

    const status = await this.store.withUser(userId, async (tx): Promise<LeagueStatus> => {
      const seat = await this.seat(tx, userId, league, now, null);
      let group: LeagueStatus["group"] = null;
      if (seat.current) {
        const standings = await tx.groupStandings({
          leagueId: league.id,
          roundKey: seat.round.key,
          tier: seat.current.tier,
          group: seat.current.group,
          currency: league.currency,
          from: seat.round.from,
          to: seat.round.to,
          recordedBefore: null,
        });
        const tierIndex = league.tiers.indexOf(seat.current.tier);
        group = {
          number: seat.current.group,
          size: standings.length,
          entries: standings.map((m, i) => ({
            rank: i + 1,
            userId: m.userId,
            score: m.score,
            displayName: null,
            avatarUrl: null,
            zone: zoneFor(league, tierIndex, i + 1, standings.length),
          })),
        };
      }
      return {
        id: league.id,
        tier: seat.tier,
        tiers: league.tiers,
        round: { key: seat.round.key, startsAt: new Date(seat.round.from).toISOString(), endsAt: new Date(seat.round.to).toISOString() },
        group,
        you: null,
        previous: seat.previous,
      };
    });
    // Names are looked up after the transaction: they are not part of the lock.
    if (status.group) {
      const names = await this.store.profiles(status.group.entries.map((e) => e.userId));
      status.group.entries = status.group.entries.map((e) => withProfile(e, names));
      status.you = status.group.entries.find((e) => e.userId === userId) ?? null;
    }
    return status;
  }

  /** Set a user's display name, avatar, metadata or time zone. Returns the full profile. */
  async updateUser(userId: string, patch: unknown): Promise<UserProfile> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const clean = validateProfilePatch(patch);
    await this.store.withUser(userId, (tx) => tx.updateProfile(clean));
    return this.getUser(userId);
  }

  /** The reward store as one user sees it: their spendable balances, and what they own and can buy. */
  async rewardStore(userId: string, options: { locale?: string } = {}): Promise<RewardStore> {
    checkLocale(options.locale);
    checkUserId(userId);
    const snap = await this.store.snapshot(userId);
    const wallet: Record<string, number> = {};
    for (const c of this.config.currencies) wallet[c] = round6((snap.balances[c] ?? 0) - (snap.spent[c] ?? 0));
    const items = this.config.items.map((item): StoreItemStatus => {
      const owned = snap.inventory[item.id] ?? 0;
      const limit = item.limit ?? null;
      return {
        id: item.id,
        ...localize(item, options.locale),
        price: { ...item.price },
        limit,
        ...(item.metadata ? { metadata: structuredClone(item.metadata) } : {}),
        owned,
        canBuy: (limit === null || owned < limit) && (wallet[item.price.currency] ?? 0) >= item.price.amount,
      };
    });
    return { userId, wallet, items };
  }

  /**
   * Buy an item with points. Fails with 409 and code "insufficient_funds" when
   * the user cannot afford it, or "limit_reached" when they would own more
   * than the item's limit. Spending lowers the wallet, never earned points.
   */
  async purchase(userId: string, input: PurchaseInput): Promise<PurchaseResult> {
    checkUserId(userId);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new EngineError("body must be a JSON object");
    const item = this.config.items.find((i) => i.id === input.item);
    if (!item) throw new EngineError(`unknown item "${String(input.item)}"`, 404);
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new EngineError(`quantity must be a whole number from 1 to ${MAX_QUANTITY}`);
    const idempotencyKey = input.idempotencyKey ?? null;
    if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
      throw new EngineError("idempotencyKey must be a string of 1-200 characters");
    }

    return this.store.withUser(userId, async (tx) => {
      const walletOf = async () => {
        const wallet: Record<string, number> = {};
        for (const c of this.config.currencies) wallet[c] = round6((await tx.getBalance(c)) - (await tx.getSpent(c)));
        return wallet;
      };
      if (idempotencyKey) {
        const previous = await tx.findPurchase(idempotencyKey);
        if (previous) {
          return { userId, purchase: this.toPurchase(previous), duplicate: true, wallet: await walletOf(), owned: await tx.getInventory(previous.itemId) };
        }
      }
      const owned = await tx.getInventory(item.id);
      if (item.limit !== undefined && owned + quantity > item.limit) {
        throw new EngineError(`${userId} can own at most ${item.limit} of "${item.id}" and has ${owned}`, 409, "limit_reached");
      }
      const { currency } = item.price;
      const cost = round6(item.price.amount * quantity);
      const available = round6((await tx.getBalance(currency)) - (await tx.getSpent(currency)));
      if (available < cost) {
        throw new EngineError(`"${item.id}" costs ${cost} ${currency} and ${userId} has ${available}`, 409, "insufficient_funds");
      }
      const record: PurchaseRecord = { id: randomUUID(), itemId: item.id, quantity, currency, cost, purchasedAt: this.now(), idempotencyKey, refunded: 0 };
      const nowOwned = await tx.recordPurchase(record);
      return { userId, purchase: this.toPurchase(record), duplicate: false, wallet: await walletOf(), owned: nowOwned };
    });
  }

  /**
   * Use owned items. Fails with 409 and code "not_owned" when the user has
   * fewer than `quantity`. A streak-freeze item fails with "limit_reached"
   * past the streak's freezes.max, and "streak_broken" when the streak has
   * already lapsed (a freeze cannot bring it back).
   */
  async useItem(userId: string, itemId: string, input: ItemUseInput = {}): Promise<ItemUseResult> {
    checkUserId(userId);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new EngineError("body must be a JSON object");
    const item = this.config.items.find((i) => i.id === itemId);
    if (!item) throw new EngineError(`unknown item "${String(itemId)}"`, 404);
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new EngineError(`quantity must be a whole number from 1 to ${MAX_QUANTITY}`);
    const idempotencyKey = input.idempotencyKey ?? null;
    if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
      throw new EngineError("idempotencyKey must be a string of 1-200 characters");
    }

    return this.store.withUser(userId, async (tx) => {
      if (idempotencyKey) {
        const previous = await tx.findItemUse(idempotencyKey);
        if (previous) return { ...previous, duplicate: true };
      }
      const owned = await tx.getInventory(item.id);
      if (owned < quantity) throw new EngineError(`${userId} has ${owned} of "${item.id}", not ${quantity}`, 409, "not_owned");

      const usedAt = this.now();
      const effects: ItemUseResult["effects"] = {};
      const effect = item.effect;
      if (effect && "boost" in effect) {
        let first: BoostRecord | null = null;
        let last: BoostRecord | null = null;
        for (let i = 0; i < quantity; i++) {
          last = await queueBoost(tx, effect.boost, usedAt, `item:${item.id}`, null);
          first ??= last;
        }
        effects.boost = { factor: effect.boost.factor, currency: effect.boost.currency ?? null, startsAt: toBoost(first!).startsAt, endsAt: toBoost(last!).endsAt };
      } else if (effect) {
        const rule = this.config.streaks.find((s) => s.id === effect.streakFreeze)!;
        const state = (await tx.getStreak(rule.id)) ?? initialStreak(rule);
        const timezone = (await tx.getProfile()).timezone ?? this.config.defaultTimezone;
        if (streakStatus(rule, state, streakPeriodKey(rule, usedAt, timezone)).status === "broken") {
          throw new EngineError(`the "${rule.id}" streak is already broken; a freeze cannot bring it back`, 409, "streak_broken");
        }
        const max = rule.freezes?.max ?? 0;
        if (state.freezes + quantity > max) {
          throw new EngineError(`"${rule.id}" holds at most ${max} freezes and ${userId} has ${state.freezes}`, 409, "limit_reached");
        }
        await tx.setStreak(rule.id, { ...state, freezes: state.freezes + quantity });
        effects.streakFreeze = { streak: rule.id, freezes: state.freezes + quantity };
      }

      const result: ItemUseResult = { userId, item: item.id, used: quantity, owned: owned - quantity, duplicate: false, effects };
      const record: ItemUseRecord = { id: randomUUID(), itemId: item.id, quantity, usedAt, idempotencyKey, result };
      await tx.recordItemUse(record);
      return result;
    });
  }

  /**
   * Give one user a multiplier for a while ("2x XP for an hour"), e.g. as a
   * reward or a welcome-back gift. Boosts apply to points from point rules
   * for events that happen while they run, and multiply with other
   * multipliers. The same factor and currency queue back to back.
   */
  async grantBoost(userId: string, input: BoostInput): Promise<BoostResult> {
    checkUserId(userId);
    const problem = boostSpecProblem(input, this.config.currencies);
    if (problem) throw new EngineError(problem);
    const reason = input.reason ?? "boost";
    if (typeof reason !== "string" || !REASON.test(reason)) throw new EngineError("reason must be 1-64 letters, digits, _ . : -");
    const idempotencyKey = input.idempotencyKey ?? null;
    if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
      throw new EngineError("idempotencyKey must be a string of 1-200 characters");
    }
    const spec: BoostSpec = { factor: input.factor, minutes: input.minutes, ...(input.currency !== undefined ? { currency: input.currency } : {}) };
    return this.store.withUser(userId, async (tx) => {
      const now = this.now();
      const previous = idempotencyKey ? await tx.findBoost(idempotencyKey) : null;
      const boost = previous ?? (await queueBoost(tx, spec, now, reason, idempotencyKey));
      return { userId, boost: toBoost(boost), duplicate: previous !== null, boosts: (await tx.getBoosts(now)).map(toBoost) };
    });
  }

  /**
   * Refund some or all of a purchase (default: everything not refunded yet).
   * The price goes back to the wallet and the items leave the inventory, so
   * the user must still own them: 409 "not_owned" if they used them, and
   * 409 "already_refunded" when nothing is left to refund.
   */
  async refundPurchase(userId: string, purchaseId: string, options: { quantity?: number } = {}): Promise<RefundResult> {
    checkUserId(userId);
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new EngineError("body must be a JSON object");
    return this.store.withUser(userId, async (tx) => {
      const p = typeof purchaseId === "string" ? await tx.getPurchase(purchaseId) : null;
      if (!p) throw new EngineError(`${userId} has no purchase "${String(purchaseId)}"`, 404);
      const left = p.quantity - p.refunded;
      if (left <= 0) throw new EngineError("this purchase was already refunded in full", 409, "already_refunded");
      const quantity = options.quantity ?? left;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > left) throw new EngineError(`quantity must be a whole number from 1 to ${left}`);
      const owned = await tx.getInventory(p.itemId);
      if (owned < quantity) throw new EngineError(`${userId} owns ${owned} of "${p.itemId}", so ${quantity} cannot be refunded`, 409, "not_owned");
      const amount = round6((p.cost / p.quantity) * quantity);
      await tx.refundPurchase(p.id, quantity, amount);
      const wallet: Record<string, number> = {};
      for (const c of this.config.currencies) wallet[c] = round6((await tx.getBalance(c)) - (await tx.getSpent(c)));
      return {
        userId,
        purchase: this.toPurchase({ ...p, refunded: p.refunded + quantity }),
        refund: { quantity, amount, currency: p.currency },
        wallet,
        owned: owned - quantity,
      };
    });
  }

  /**
   * Repair a broken streak, if its rule allows repairs and it broke less than
   * `repair.withinHours` ago. The streak resumes as if yesterday's activity
   * was done; the user still needs to act today. 409 with code "not_broken"
   * (including once a new streak was started), "repair_expired" or
   * "insufficient_funds".
   */
  async repairStreak(userId: string, streakId: string): Promise<StreakRepairResult> {
    checkUserId(userId);
    const rule = this.config.streaks.find((s) => s.id === streakId);
    if (!rule) throw new EngineError(`unknown streak "${String(streakId)}"`, 404);
    if (!rule.repair) throw new EngineError(`streak "${rule.id}" cannot be repaired`);
    const repair = rule.repair;
    return this.store.withUser(userId, async (tx) => {
      const now = this.now();
      const timezone = (await tx.getProfile()).timezone ?? this.config.defaultTimezone;
      const state = (await tx.getStreak(rule.id)) ?? initialStreak(rule);
      const nowPeriod = streakPeriodKey(rule, now, timezone);
      if (streakStatus(rule, state, nowPeriod).status !== "broken") {
        throw new EngineError(`the "${rule.id}" streak is not broken`, 409, "not_broken");
      }
      const deadline = repairDeadline(rule, state, timezone);
      if (deadline === null || now >= deadline) throw new EngineError(`the "${rule.id}" streak broke too long ago to repair`, 409, "repair_expired");
      const cost = repair.cost && repair.cost.amount > 0 ? { ...repair.cost } : null;
      if (cost) {
        const available = round6((await tx.getBalance(cost.currency)) - (await tx.getSpent(cost.currency)));
        if (available < cost.amount) throw new EngineError(`repairing costs ${cost.amount} ${cost.currency} and ${userId} has ${available}`, 409, "insufficient_funds");
        await tx.spend(cost.currency, cost.amount);
      }
      const repaired: StreakState = { ...state, lastPeriod: shiftPeriod(rule, nowPeriod, -1), freezes: 0 };
      await tx.setStreak(rule.id, repaired);
      const wallet: Record<string, number> = {};
      for (const c of this.config.currencies) wallet[c] = round6((await tx.getBalance(c)) - (await tx.getSpent(c)));
      const after = streakStatus(rule, repaired, nowPeriod);
      return { userId, streak: rule.id, current: after.current, status: after.status, cost, wallet };
    });
  }

  /** A user's purchases, newest first. */
  async purchases(userId: string, options: { limit?: number; cursor?: string } = {}): Promise<PurchaseHistory> {
    checkUserId(userId);
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const before = options.cursor ? decodeCursor(options.cursor) : undefined;
    const rows = await this.store.purchases(userId, { limit: limit + 1, ...(before ? { before } : {}) });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      purchases: page.map((p) => this.toPurchase(p)),
      nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.purchasedAt, id: last.id }) : null,
    };
  }

  private toPurchase(p: PurchaseRecord): Purchase {
    const item: ItemRule | undefined = this.config.items.find((i) => i.id === p.itemId);
    return {
      id: p.id,
      item: p.itemId,
      name: item?.name ?? null,
      quantity: p.quantity,
      cost: { currency: p.currency, amount: p.cost },
      purchasedAt: new Date(p.purchasedAt).toISOString(),
      refunded: p.refunded,
    };
  }

  /** A user's events, newest first, with what each one awarded. */
  async events(userId: string, options: { limit?: number; cursor?: string } = {}): Promise<EventHistory> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const before = options.cursor ? decodeCursor(options.cursor) : undefined;
    // Fetch one extra to know whether another page exists.
    const rows = await this.store.events(userId, { limit: limit + 1, ...(before ? { before } : {}) });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page.map((e: EventRecord) => ({
        id: e.id,
        event: e.key,
        value: e.value,
        timestamp: new Date(e.ts).toISOString(),
        recordedAt: new Date(e.recordedAt).toISOString(),
        properties: e.properties ?? {},
        reversedAt: e.reversedAt ? new Date(e.reversedAt).toISOString() : null,
        result: e.result,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  /**
   * Track up to 100 events in order. Each is its own transaction: a bad item
   * is reported in place and the rest still count. Use idempotency keys if
   * you might retry a batch.
   */
  async trackBatch(inputs: unknown): Promise<BatchItemResult[]> {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_BATCH) {
      throw new EngineError(`events must be an array of 1 to ${MAX_BATCH} events`);
    }
    const results: BatchItemResult[] = [];
    for (const input of inputs) {
      try {
        results.push({ ok: true, result: await this.track(input as TrackInput) });
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        results.push({ ok: false, status: err.status, error: err.message });
      }
    }
    return results;
  }

  /**
   * Work out where a user sits in a league right now. Settles their last
   * finished round on the way (no background job needed), and when
   * `joinAt` is given, seats them in a group for the current round.
   */
  private async seat(
    tx: UserTx,
    userId: string,
    league: ResolvedLeague,
    now: number,
    joinAt: number | null,
  ): Promise<{ round: LeagueRound; tier: string; current: Membership | null; previous: LeaguePrevious | null; joined: boolean }> {
    const round = currentRound(league, now);
    const [latest, before] = await tx.getMemberships(league.id, 2);

    if (latest && latest.roundKey >= round.key) {
      const previous = before ? await this.settle(tx, userId, league, before) : null;
      return { round, tier: latest.tier, current: latest, previous, joined: false };
    }

    const previous = latest ? await this.settle(tx, userId, league, latest) : null;
    let tier = previous ? previous.nextTier : (league.tiers[0] as string);
    // A season that started since the user's last round moves them back.
    if (latest && league.seasonReset) {
      const lastStart = roundFromKey(league, latest.roundKey).from;
      if (this.config.seasons.some((s) => s.from > lastStart && s.from <= round.from)) {
        const drop = league.seasonReset.dropTiers;
        tier = league.tiers[drop === null ? 0 : Math.max(0, league.tiers.indexOf(tier) - drop)] as string;
      }
    }
    if (joinAt === null) return { round, tier, current: null, previous, joined: false };

    const group = await tx.joinLeague(league.id, round.key, tier, league.groupSize, joinAt);
    const current: Membership = { leagueId: league.id, roundKey: round.key, tier, group, joinedAt: joinAt, outcome: null, finalRank: null, nextTier: null };
    return { round, tier, current, previous, joined: true };
  }

  /** Final result of a finished round, computed once and then stored. */
  private async settle(tx: UserTx, userId: string, league: ResolvedLeague, m: Membership): Promise<LeaguePrevious> {
    const finishRewards = (rank: number) => (league.rewards.find((t) => rank <= t.top)?.rewards ?? []).map((x) => ({ ...x }));
    if (m.outcome && m.finalRank !== null && m.nextTier) {
      return { round: m.roundKey, tier: m.tier, rank: m.finalRank, outcome: m.outcome, nextTier: m.nextTier, rewards: finishRewards(m.finalRank) };
    }
    const r = roundFromKey(league, m.roundKey);
    const standings = await tx.groupStandings({
      leagueId: league.id,
      roundKey: m.roundKey,
      tier: m.tier,
      group: m.group,
      currency: league.currency,
      from: r.from,
      to: r.to,
      // Points recorded after the round ended (backfilled events) never change its result.
      recordedBefore: r.to,
    });
    const index = standings.findIndex((s) => s.userId === userId);
    const rank = index === -1 ? standings.length + 1 : index + 1;
    const size = Math.max(standings.length, rank);
    const outcome = outcomeFor(league, league.tiers.indexOf(m.tier), rank, size);
    const next = nextTier(league, m.tier, outcome);
    await tx.settleMembership(league.id, m.roundKey, { outcome, finalRank: rank, nextTier: next });
    // Settlement happens once (it is stored), so finish rewards are paid once. They are dated in the
    // finished round, so they never count toward the next one (and, recorded after it closed, not toward it either).
    const rewards = finishRewards(rank);
    if (rewards.length > 0) {
      const eventId = randomUUID();
      for (const x of rewards) await tx.addPoints(x.currency, x.amount, r.to - 1, eventId, this.now());
    }
    return { round: m.roundKey, tier: m.tier, rank, outcome, nextTier: next, rewards };
  }
}

function cloneTier(t: SeasonAward): SeasonAward {
  return { top: t.top, ...(t.title ? { title: t.title } : {}), rewards: t.rewards.map((r) => ({ ...r })) };
}

function withProfile<T extends LeaderboardEntry>(entry: T, names: Record<string, PublicProfile>): T & RankedUser {
  const p = names[entry.userId];
  return { ...entry, displayName: p?.displayName ?? null, avatarUrl: p?.avatarUrl ?? null };
}

/** Highest first, ties share a rank (1, 2, 2, 4), then by user id for a stable order. */
function rankScores(rows: Array<{ userId: string; score: number }>): LeaderboardEntry[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score || (a.userId < b.userId ? -1 : 1));
  const ranked: LeaderboardEntry[] = [];
  sorted.forEach((r, i) => {
    const prev = ranked[i - 1];
    ranked.push({ ...r, rank: prev && prev.score === r.score ? prev.rank : i + 1 });
  });
  return ranked;
}

function rivalOutcome(you: number, them: number): RivalOutcome {
  return you > them ? "won" : you < them ? "lost" : "draw";
}
