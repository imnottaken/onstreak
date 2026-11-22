import { randomUUID } from "node:crypto";
import { levelFor, resolveConfig, type ResolvedConfig, type ResolvedLeague, type ResolvedRivalry, type OnstreakConfig, type QuestRule, type QuestReward, type ItemRule, type BoostSpec, type CalendarRule, type StreakRule, boostSpecProblem, questRunsAt } from "./config.js";
import { currentRound, nextRoundKey, nextTier, outcomeFor, roundFromKey, zoneFor, type LeagueOutcome, type LeagueRound, type LeagueZone } from "./leagues.js";
import { breakPeriod, initialStreak, recordActivity, streakStatus, type StreakState, type StreakStatus } from "./streaks.js";
import { FriendLimitError, RivalLimitError, type EventRecord, type LeaderboardEntry, type Membership, type ProfileData, type ProfilePatch, type PublicProfile, type BoostRecord, type CalendarState, type ItemUseRecord, type ReferralRecord, type PurchaseRecord, type Store, type UserTx } from "./store/types.js";
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
}

export interface TrackResult {
  eventId: string;
  userId: string;
  event: string;
  value: number;
  duplicate: boolean;
  points: Record<string, { awarded: number; total: number }>;
  level: { current: number; previous: number; leveledUp: boolean } | null;
  /** `progress` is this period's total so far, for streaks with a minimum. */
  streaks: Record<string, { current: number; longest: number; freezes: number; extended: boolean; freezesUsed: number; reset: boolean; progress?: number }>;
  achievements: Array<{ id: string; name: string; description?: string }>;
  /** Leagues this event counted toward. `joined` is true the first time in a round. */
  leagues: Record<string, { tier: string; group: number; joined: boolean; previous: LeaguePrevious | null }>;
  /** Quests this event moved forward. `completed` is true on the event that finished one; its rewards are already in `points`. */
  quests: Record<string, { progress: number; target: number; completed: boolean; rewards: QuestReward[] }>;
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
  level: { current: number; points: number; startsAt: number; nextAt: number | null } | null;
  metrics: Record<string, number>;
  /** `repairableUntil` is set while a broken streak can still be repaired. */
  streaks: Record<string, { current: number; longest: number; freezes: number; lastPeriod: string | null; status: StreakStatus; repairableUntil?: string; progress?: number }>;
  achievements: Array<{ id: string; name: string; description?: string; unlockedAt: string }>;
}

export type LeaderboardScope = "all" | "friends";

export interface LeaderboardResult {
  id: string;
  currency: string;
  period: LeaderboardPeriod;
  scope: LeaderboardScope;
  from: string | null;
  to: string | null;
  entries: RankedUser[];
  user: RankedUser | null;
}

export interface EventHistory {
  events: Array<{
    id: string;
    event: string;
    value: number;
    timestamp: string;
    recordedAt: string;
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
  period: "daily" | "weekly";
  /** Event or points goal, as configured. */
  goal: QuestRule["goal"];
  progress: number;
  target: number;
  completed: boolean;
  completedAt: string | null;
  rewards: QuestReward[];
  /** The current period: progress resets at endsAt. */
  startsAt: string;
  endsAt: string;
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
      await tx.insertEvent({ id: eventId, userId, key: event, value, ts, recordedAt, idempotencyKey });
      const metrics = new Map<string, number>([[event, await tx.addMetric(event, value)]]);

      const levelBefore = config.levels ? levelFor(config.levels, await tx.getBalance(config.levels.currency)) : null;

      const streaks: TrackResult["streaks"] = {};
      const streakStates = new Map<string, StreakState>();
      for (const rule of config.streaks) {
        if (rule.event !== event) continue;
        let prev = (await tx.getStreak(rule.id)) ?? initialStreak(rule);
        const period = periodKey(ts, rule.period, timezone);
        let progress: number | undefined;
        let enough = true;
        if (rule.minimum !== undefined) {
          const filling = prev.progressPeriod ?? null;
          if (filling !== null && periodsBetween(filling, period, rule.period) < 0) {
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
          const current = state ? streakStatus(rule, state, periodKey(ts, rule.period, timezone)).current : 0;
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
        if (rule.event !== event) continue;
        const base = rule.multiplyByValue ? rule.amount * value : rule.amount;
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
      for (const quest of config.quests) {
        if (!questRunsAt(quest, ts)) continue;
        const gain = "event" in quest.goal ? (quest.goal.event === event ? value : 0) : (earned.get(quest.goal.points) ?? 0);
        if (gain <= 0) continue;
        const rule = { period: quest.period, timezone: quest.timezone ?? timezone };
        const round = currentRound(rule, ts);
        if (round.key !== currentRound(rule, recordedAt).key) continue;
        const prev = await tx.getQuest(quest.id, round.key);
        if (prev?.completedAt != null) continue;
        const target = quest.goal.target;
        const progress = Math.min(target, (prev?.progress ?? 0) + gain);
        const completed = progress >= target;
        await tx.setQuest({ questId: quest.id, periodKey: round.key, progress, completedAt: completed ? recordedAt : null });
        const rewards = completed ? (quest.rewards ?? []).map((r) => ({ ...r })) : [];
        for (const r of rewards) {
          const total = await tx.addPoints(r.currency, r.amount, ts, eventId, recordedAt);
          const entry = points[r.currency] ?? { awarded: 0, total };
          entry.awarded += r.amount;
          entry.total = total;
          points[r.currency] = entry;
        }
        quests[quest.id] = { progress, target, completed, rewards };
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
          if (unlocked.has(a.id)) continue;
          let progress: number;
          if ("metric" in a.when) {
            progress = metrics.get(a.when.metric) ?? (await tx.getMetric(a.when.metric));
          } else if ("streak" in a.when) {
            progress = (streakStates.get(a.when.streak) ?? (await tx.getStreak(a.when.streak)))?.current ?? 0;
          } else {
            progress = await tx.getBalance(a.when.points);
          }
          if (progress >= a.when.gte) {
            await tx.unlock(a.id, ts);
            achievements.push({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}) });
          }
        }
      }

      let level: TrackResult["level"] = null;
      if (config.levels && levelBefore !== null) {
        const current = levelFor(config.levels, await tx.getBalance(config.levels.currency));
        level = { current, previous: levelBefore, leveledUp: current > levelBefore };
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
      await tx.setEventResult(eventId, result);
      return result;
    });
    if (tracked.referral && !tracked.duplicate) await this.settleReferrer(tracked.referral.referrerId);
    return tracked;
  }

  async getUser(userId: string, options: { timezone?: string } = {}): Promise<UserProfile> {
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
      const total = points[this.config.levels.currency] ?? 0;
      level = {
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
      const nowPeriod = periodKey(now, rule.period, timezone);
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
      .filter((a) => names.has(a.id))
      .map((a) => {
        const rule = names.get(a.id)!;
        return { id: a.id, name: rule.name, ...(rule.description ? { description: rule.description } : {}), unlockedAt: a.unlockedAt };
      });

    return { userId, profile: snap.profile, points, wallet, inventory: snap.inventory, boosts: boosts.map(toBoost), level, metrics: snap.metrics, streaks, achievements };
  }

  /**
   * Top entries for the current window. With `scope: "friends"`, only the user
   * and their friends are ranked, and friends with no points yet are included.
   */
  async leaderboard(id: string, options: { limit?: number; userId?: string; scope?: LeaderboardScope } = {}): Promise<LeaderboardResult> {
    const rule = this.config.leaderboards.find((l) => l.id === id);
    if (!rule) throw new EngineError(`unknown leaderboard "${id}"`, 404);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new EngineError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const scope = options.scope ?? "all";
    if (scope !== "all" && scope !== "friends") throw new EngineError('scope must be "all" or "friends"');
    if (scope === "friends" && !options.userId) throw new EngineError("a friends leaderboard needs userId");
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
      entries: entries.map((e) => withProfile(e, names)),
      user: user ? withProfile(user, names) : null,
    };
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
  async quests(userId: string, options: { timezone?: string } = {}): Promise<QuestList> {
    if (typeof userId !== "string" || !USER_ID.test(userId)) throw new EngineError("userId must be a non-empty string without spaces");
    if (options.timezone !== undefined && !isValidTimeZone(options.timezone)) throw new EngineError(`unknown timezone "${options.timezone}"`);
    const now = this.now();
    let userZone = options.timezone;
    if (userZone === undefined && this.config.quests.some((q) => !q.timezone && questRunsAt(q, now))) {
      userZone = (await this.store.snapshot(userId)).profile.timezone ?? this.config.defaultTimezone;
    }
    const running = this.config.quests.filter((q) => questRunsAt(q, now));
    const rounds = running.map((q) => currentRound({ period: q.period, timezone: q.timezone ?? userZone! }, now));
    const stored = await this.store.quests(
      userId,
      running.map((q, i) => ({ questId: q.id, periodKey: rounds[i]!.key })),
    );
    const byId = new Map(stored.map((s) => [s.questId, s]));
    return {
      userId,
      quests: running.map((q, i) => {
        const s = byId.get(q.id);
        const round = rounds[i]!;
        return {
          id: q.id,
          name: q.name,
          ...(q.description ? { description: q.description } : {}),
          period: q.period,
          goal: { ...q.goal },
          progress: s?.progress ?? 0,
          target: q.goal.target,
          completed: s?.completedAt != null,
          completedAt: s?.completedAt != null ? new Date(s.completedAt).toISOString() : null,
          rewards: (q.rewards ?? []).map((r) => ({ ...r })),
          startsAt: new Date(round.from).toISOString(),
          endsAt: new Date(round.to).toISOString(),
          until: q.to === undefined ? null : new Date(Date.parse(q.to)).toISOString(),
        };
      }),
    };
  }

  /** Every reward calendar with the user's place in it: what is claimed, what today pays, and what comes next. */
  async calendars(userId: string, options: { timezone?: string } = {}): Promise<CalendarList> {
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
          ...(cal.name ? { name: cal.name } : {}),
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
  async rewardStore(userId: string): Promise<RewardStore> {
    checkUserId(userId);
    const snap = await this.store.snapshot(userId);
    const wallet: Record<string, number> = {};
    for (const c of this.config.currencies) wallet[c] = round6((snap.balances[c] ?? 0) - (snap.spent[c] ?? 0));
    const items = this.config.items.map((item): StoreItemStatus => {
      const owned = snap.inventory[item.id] ?? 0;
      const limit = item.limit ?? null;
      return {
        id: item.id,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
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
        if (streakStatus(rule, state, periodKey(usedAt, rule.period, timezone)).status === "broken") {
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
      const nowPeriod = periodKey(now, rule.period, timezone);
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
      const repaired: StreakState = { ...state, lastPeriod: addDays(nowPeriod, rule.period === "daily" ? -1 : -7), freezes: 0 };
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
    const tier = previous ? previous.nextTier : (league.tiers[0] as string);
    if (joinAt === null) return { round, tier, current: null, previous, joined: false };

    const group = await tx.joinLeague(league.id, round.key, tier, league.groupSize, joinAt);
    const current: Membership = { leagueId: league.id, roundKey: round.key, tier, group, joinedAt: joinAt, outcome: null, finalRank: null, nextTier: null };
    return { round, tier, current, previous, joined: true };
  }

  /** Final result of a finished round, computed once and then stored. */
  private async settle(tx: UserTx, userId: string, league: ResolvedLeague, m: Membership): Promise<LeaguePrevious> {
    if (m.outcome && m.finalRank !== null && m.nextTier) {
      return { round: m.roundKey, tier: m.tier, rank: m.finalRank, outcome: m.outcome, nextTier: m.nextTier };
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
    return { round: m.roundKey, tier: m.tier, rank, outcome, nextTier: next };
  }
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
