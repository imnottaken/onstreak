/** Tiny client for an onstreak server. Works in Node 18+, Deno, Bun and edge runtimes. */

export interface TrackInput {
  userId: string;
  event: string;
  value?: number;
  timestamp?: string | number;
  timezone?: string;
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
  streaks: Record<string, { current: number; longest: number; freezes: number; extended: boolean; freezesUsed: number; reset: boolean }>;
  achievements: Array<{ id: string; name: string; description?: string }>;
  leagues: Record<string, { tier: string; group: number; joined: boolean; previous: LeaguePrevious | null }>;
  /** Quests this event moved forward. Rewards of a quest it completed are already in `points`. */
  quests: Record<string, { progress: number; target: number; completed: boolean; rewards: QuestReward[] }>;
  /** Reward calendar days this event claimed. Their rewards are already in `points`. */
  calendars: Record<string, { day: number; rewards: QuestReward[] }>;
  /** Set when this event qualified the user's referral. The referrer is paid separately. */
  referral: { referrerId: string; rewards: QuestReward[] } | null;
  /** Multipliers applied to points from point rules. A null currency means every currency. */
  multipliers: Record<string, { factor: number; currency: string | null }>;
}

export interface LeaguePrevious {
  round: string;
  tier: string;
  rank: number;
  outcome: "promoted" | "demoted" | "stayed";
  nextTier: string;
}

export type LeagueZone = "promotion" | "demotion" | "safe";

export interface LeagueStatus {
  id: string;
  tier: string;
  tiers: string[];
  round: { key: string; startsAt: string; endsAt: string };
  group: { number: number; size: number; entries: Array<LeaderboardEntry & { zone: LeagueZone }> } | null;
  you: (LeaderboardEntry & { zone: LeagueZone }) | null;
  previous: LeaguePrevious | null;
}

export interface Profile {
  displayName: string | null;
  avatarUrl: string | null;
  metadata: Record<string, unknown>;
  /** IANA zone used for this user's streak days. */
  timezone: string | null;
}

/** Fields to change. Omitted fields stay as they are; null clears one. */
export interface ProfilePatch {
  displayName?: string | null;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  timezone?: string | null;
}

export interface UserProfile {
  userId: string;
  profile: Profile;
  /** Points earned. Spending does not lower these. */
  points: Record<string, number>;
  /** Points left to spend in the reward store: earned minus spent. */
  wallet: Record<string, number>;
  /** Items owned, by item id. */
  inventory: Record<string, number>;
  /** Personal boosts running now or queued, soonest first. */
  boosts: Boost[];
  /** startsAt: points where the current level began; nextAt: points for the next one (null at max). */
  level: { current: number; points: number; startsAt: number; nextAt: number | null } | null;
  metrics: Record<string, number>;
  /** `repairableUntil` is set while a broken streak can still be repaired. */
  streaks: Record<string, { current: number; longest: number; freezes: number; lastPeriod: string | null; status: "none" | "done" | "pending" | "broken"; repairableUntil?: string }>;
  achievements: Array<{ id: string; name: string; description?: string; unlockedAt: string }>;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  score: number;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface EventHistory {
  events: Array<{ id: string; event: string; value: number; timestamp: string; recordedAt: string; result: TrackResult | null }>;
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

export interface FriendList {
  userId: string;
  friends: Array<{ userId: string; displayName: string | null; avatarUrl: string | null; since: string }>;
}

export interface QuestReward {
  currency: string;
  amount: number;
}

export interface QuestList {
  userId: string;
  quests: Array<{
    id: string;
    name: string;
    description?: string;
    period: "daily" | "weekly";
    goal: { event: string; target: number } | { points: string; target: number };
    progress: number;
    target: number;
    completed: boolean;
    completedAt: string | null;
    rewards: QuestReward[];
    startsAt: string;
    endsAt: string;
    /** When a limited-time quest stops running, or null if it always runs. */
    until: string | null;
  }>;
}

export interface Price {
  currency: string;
  amount: number;
}

export interface RewardStore {
  userId: string;
  wallet: Record<string, number>;
  items: Array<{
    id: string;
    name: string;
    description?: string;
    price: Price;
    /** Most a user can own, or null for no limit. */
    limit: number | null;
    metadata?: Record<string, unknown>;
    owned: number;
    /** The user can afford one more and is under the limit. */
    canBuy: boolean;
  }>;
}

export interface PurchaseInput {
  item: string;
  quantity?: number;
  /** Retries with the same key return the first purchase instead of charging twice. */
  idempotencyKey?: string;
}

export interface Purchase {
  id: string;
  item: string;
  /** Null if the item is no longer in the server's config. */
  name: string | null;
  quantity: number;
  cost: Price;
  purchasedAt: string;
  /** How many of `quantity` were refunded. */
  refunded: number;
}

export interface PurchaseResult {
  userId: string;
  purchase: Purchase;
  duplicate: boolean;
  wallet: Record<string, number>;
  owned: number;
}

export interface CalendarList {
  userId: string;
  calendars: Array<{
    id: string;
    name?: string;
    /** Tracking this event claims the day. */
    event: string;
    /** The day claimed today, or the day the next claim pays. */
    day: number;
    claimedToday: boolean;
    days: Array<{ day: number; rewards: QuestReward[]; status: "claimed" | "today" | "upcoming" }>;
    nextClaimAt: string;
  }>;
}

export interface ReferralResult {
  userId: string;
  referrerId: string;
  /** False if this referral was already recorded. */
  created: boolean;
  /** Whether both sides are paid. */
  qualified: boolean;
  /** What the new user was paid by this call. */
  rewards: QuestReward[];
}

export interface ReferralList {
  userId: string;
  referredBy: { userId: string; qualified: boolean } | null;
  referred: Array<{ userId: string; displayName: string | null; avatarUrl: string | null; since: string; qualified: boolean; rewarded: boolean }>;
  rewarded: number;
  max: number | null;
}

export interface CommunityGoalList {
  goals: Array<{
    id: string;
    name: string;
    description?: string;
    goal: { event: string; target: number } | { points: string; target: number };
    progress: number;
    target: number;
    completed: boolean;
    status: "upcoming" | "active" | "ended";
    startsAt: string;
    endsAt: string;
    rewards: QuestReward[];
    minContribution: number;
    you: { contribution: number; eligible: boolean; rewarded: boolean; paidNow: QuestReward[] } | null;
  }>;
}

export interface Boost {
  id: string;
  factor: number;
  /** Null: every currency. */
  currency: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface BoostInput {
  factor: number;
  minutes: number;
  /** Omit to boost every currency. */
  currency?: string;
  reason?: string;
  idempotencyKey?: string;
}

export interface ItemUseResult {
  userId: string;
  item: string;
  used: number;
  /** How many the user has left. */
  owned: number;
  duplicate: boolean;
  effects: {
    streakFreeze?: { streak: string; freezes: number };
    boost?: { factor: number; currency: string | null; startsAt: string; endsAt: string };
  };
}

export interface RefundResult {
  userId: string;
  purchase: Purchase;
  refund: { quantity: number; amount: number; currency: string };
  wallet: Record<string, number>;
  owned: number;
}

export interface PurchaseHistory {
  purchases: Purchase[];
  nextCursor: string | null;
}

export type RivalOutcome = "won" | "lost" | "draw";

export interface RivalryStatus {
  rivalryId: string;
  userId: string;
  round: { key: string; startsAt: string; endsAt: string };
  rivals: Array<{
    rivalId: string;
    displayName: string | null;
    avatarUrl: string | null;
    since: string;
    current: { you: number; them: number; leading: "you" | "them" | "tied" };
    record: { wins: number; losses: number; draws: number };
    streak: { outcome: RivalOutcome; length: number } | null;
    last: { round: string; you: number; them: number; outcome: RivalOutcome } | null;
  }>;
}

export type BatchItemResult = { ok: true; result: TrackResult } | { ok: false; status: number; error: string };

export interface Health {
  ok: boolean;
  database?: "ok" | "unreachable";
  status?: "shutting_down";
}

export interface LeaderboardResult {
  id: string;
  currency: string;
  period: "daily" | "weekly" | "monthly" | "all";
  /** "friends" when only the user and their friends were ranked. */
  scope: "all" | "friends";
  from: string | null;
  to: string | null;
  entries: LeaderboardEntry[];
  user: LeaderboardEntry | null;
}

export interface ClientOptions {
  /** e.g. "http://localhost:8787" */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class OnstreakError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's x-request-id, to find this request in its logs. */
    readonly requestId: string | null = null,
    /** A stable reason when the server gives one, e.g. "insufficient_funds" or "limit_reached". */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "OnstreakError";
  }
}

export function createClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; requestId?: string; code?: string };
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new OnstreakError(
        res.status,
        data.error ?? `onstreak request failed with ${res.status}`,
        data.requestId ?? res.headers.get("x-request-id"),
        data.code ?? null,
      );
    }
    return data as T;
  }
  const user = (userId: string) => `/v1/users/${encodeURIComponent(userId)}`;

  return {
    /** Record that a user did something. Returns points, streaks and achievements it triggered. */
    track: (input: TrackInput) => call<TrackResult>("POST", "/v1/events", input),
    /** A user's points, level, streaks and achievements. */
    getUser: (userId: string, opts: { timezone?: string } = {}) =>
      call<UserProfile>("GET", `${user(userId)}${opts.timezone ? `?timezone=${encodeURIComponent(opts.timezone)}` : ""}`),
    /** Track up to 100 events in order. Bad items are reported in place; the rest still count. */
    trackBatch: (events: TrackInput[]) => call<{ results: BatchItemResult[] }>("POST", "/v1/events/batch", { events }).then((r) => r.results),
    /** Set a user's display name, avatar, metadata or time zone. Returns the full profile. */
    updateUser: (userId: string, patch: ProfilePatch) => call<UserProfile>("PATCH", user(userId), patch),
    /** A user's events, newest first, with what each awarded. Pass `nextCursor` back to page. */
    events: (userId: string, opts: { limit?: number; cursor?: string } = {}) => {
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const qs = params.toString();
      return call<EventHistory>("GET", `${user(userId)}/events${qs ? `?${qs}` : ""}`);
    },
    /** Make two users friends (mutual). `created` is false if they already were. */
    addFriend: (userId: string, friendId: string) =>
      call<{ userId: string; friendId: string; created: boolean }>("PUT", `${user(userId)}/friends/${encodeURIComponent(friendId)}`),
    /** End a friendship for both users. `removed` is false if they were not friends. */
    removeFriend: (userId: string, friendId: string) =>
      call<{ userId: string; friendId: string; removed: boolean }>("DELETE", `${user(userId)}/friends/${encodeURIComponent(friendId)}`),
    /** A user's friends, newest first. */
    friends: (userId: string) => call<FriendList>("GET", `${user(userId)}/friends`),
    /** Every quest for the current day or week, with the user's progress. */
    quests: (userId: string, options: { timezone?: string } = {}) =>
      call<QuestList>("GET", `${user(userId)}/quests${options.timezone ? `?timezone=${encodeURIComponent(options.timezone)}` : ""}`),
    /** The reward store for one user: their spendable balances, and what they own and can buy. */
    store: (userId: string) => call<RewardStore>("GET", `${user(userId)}/store`),
    /**
     * Buy an item with points. Throws OnstreakError with status 409 and code
     * "insufficient_funds" or "limit_reached" when the purchase is refused.
     */
    purchase: (userId: string, input: PurchaseInput) => call<PurchaseResult>("POST", `${user(userId)}/purchases`, input),
    /**
     * Use owned items, applying the item's effect (e.g. adding a streak freeze).
     * Throws OnstreakError 409 with code "not_owned", "limit_reached" or "streak_broken".
     */
    useItem: (userId: string, itemId: string, opts: { quantity?: number; idempotencyKey?: string } = {}) =>
      call<ItemUseResult>("POST", `${user(userId)}/inventory/${encodeURIComponent(itemId)}/use`, opts),
    /** Login reward calendars with the user's place in each. Track the calendar's event to claim a day. */
    calendars: (userId: string, options: { timezone?: string } = {}) =>
      call<CalendarList>("GET", `${user(userId)}/calendars${options.timezone ? `?timezone=${encodeURIComponent(options.timezone)}` : ""}`),
    /** Record that `referrerId` brought `userId` in. Throws 409 "already_referred" for a different referrer. */
    addReferral: (userId: string, referrerId: string) => call<ReferralResult>("PUT", `${user(userId)}/referred-by/${encodeURIComponent(referrerId)}`),
    /** Who referred a user and whom they referred. */
    referrals: (userId: string) => call<ReferralList>("GET", `${user(userId)}/referrals`),
    /** Community goals with everyone's progress; with userId, that user's part (and their rewards, once reached). */
    communityGoals: (opts: { userId?: string } = {}) =>
      call<CommunityGoalList>("GET", `/v1/community-goals${opts.userId ? `?userId=${encodeURIComponent(opts.userId)}` : ""}`),
    /** Give a user a personal multiplier for some minutes, e.g. 2x XP for an hour. */
    grantBoost: (userId: string, input: BoostInput) =>
      call<{ userId: string; boost: Boost; duplicate: boolean; boosts: Boost[] }>("POST", `${user(userId)}/boosts`, input),
    /** Repair a recently broken streak. Throws 409 "not_broken", "repair_expired" or "insufficient_funds". */
    repairStreak: (userId: string, streakId: string) =>
      call<{ userId: string; streak: string; current: number; status: "none" | "done" | "pending" | "broken"; cost: Price | null; wallet: Record<string, number> }>(
        "POST",
        `${user(userId)}/streaks/${encodeURIComponent(streakId)}/repair`,
      ),
    /** Refund some or all of a purchase. Throws 409 "not_owned" or "already_refunded". */
    refundPurchase: (userId: string, purchaseId: string, opts: { quantity?: number } = {}) =>
      call<RefundResult>("POST", `${user(userId)}/purchases/${encodeURIComponent(purchaseId)}/refund`, opts),
    /** A user's purchases, newest first. Pass `nextCursor` back to page. */
    purchases: (userId: string, opts: { limit?: number; cursor?: string } = {}) => {
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const qs = params.toString();
      return call<PurchaseHistory>("GET", `${user(userId)}/purchases${qs ? `?${qs}` : ""}`);
    },
    /** A user's rivals: this round's live score, record, streak and last result. */
    rivals: (rivalryId: string, userId: string) =>
      call<RivalryStatus>("GET", `/v1/rivalries/${encodeURIComponent(rivalryId)}/users/${encodeURIComponent(userId)}`),
    /** Start a rivalry (mutual). `created` is false if they already were rivals. */
    addRival: (rivalryId: string, userId: string, rivalId: string) =>
      call<{ rivalryId: string; userId: string; rivalId: string; created: boolean }>(
        "PUT",
        `/v1/rivalries/${encodeURIComponent(rivalryId)}/users/${encodeURIComponent(userId)}/rivals/${encodeURIComponent(rivalId)}`,
      ),
    /** End a rivalry and its history. `removed` is false if they were not rivals. */
    removeRival: (rivalryId: string, userId: string, rivalId: string) =>
      call<{ rivalryId: string; userId: string; rivalId: string; removed: boolean }>(
        "DELETE",
        `/v1/rivalries/${encodeURIComponent(rivalryId)}/users/${encodeURIComponent(userId)}/rivals/${encodeURIComponent(rivalId)}`,
      ),
    /** Whether the server and its database are up. Never throws for a 503. */
    health: () => call<Health>("GET", "/health", undefined, [503]),
    /** Top entries of a leaderboard, plus the given user's own rank. */
    leaderboard: (id: string, opts: { limit?: number; userId?: string; scope?: "all" | "friends" } = {}) => {
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.userId) params.set("userId", opts.userId);
      if (opts.scope) params.set("scope", opts.scope);
      const qs = params.toString();
      return call<LeaderboardResult>("GET", `/v1/leaderboards/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
    },
    /** The user's league tier, their group's live standings this round, and how last round ended. */
    league: (id: string, userId: string) =>
      call<LeagueStatus>("GET", `/v1/leagues/${encodeURIComponent(id)}/users/${encodeURIComponent(userId)}`),
  };
}

export type OnstreakClient = ReturnType<typeof createClient>;
