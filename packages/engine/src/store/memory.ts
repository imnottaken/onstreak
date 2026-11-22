import type { TrackResult } from "../engine.js";
import type { StreakState } from "../streaks.js";
import { AlreadyInTeamError, FriendLimitError, RivalLimitError, TeamFullError } from "./types.js";
import type {
  EventPageQuery,
  FriendRecord,
  RivalRecord,
  WindowScoreQuery,
  EventRecord,
  GroupMember,
  LeaderboardEntry,
  LeaderboardQuery,
  Membership,
  MigrationReport,
  ProfileData,
  PublicProfile,
  Store,
  StoredEvent,
  UserSnapshot,
  QuestProgress,
  PurchasePageQuery,
  PurchaseRecord,
  ItemUseRecord,
  BoostRecord,
  CalendarState,
  ReferralRecord,
  CommunityTotalQuery,
  TeamRecord,
  TeamMemberRecord,
  TeamScoreQuery,
  UserTx,
} from "./types.js";

interface UserData {
  profile: ProfileData;
  events: Map<string, StoredEvent & { result: TrackResult | null }>;
  idempotency: Map<string, string>;
  metrics: Map<string, number>;
  balances: Map<string, number>;
  streaks: Map<string, StreakState>;
  achievements: Map<string, number>;
  /** Keyed by "questId|periodKey". */
  quests: Map<string, QuestProgress>;
  spent: Map<string, number>;
  inventory: Map<string, number>;
  /** Oldest first. */
  purchases: PurchaseRecord[];
  itemUses: ItemUseRecord[];
  boosts: BoostRecord[];
  calendars: Map<string, CalendarState>;
  prestige: { rank: number; base: number };
}

interface LedgerRow {
  userId: string;
  currency: string;
  amount: number;
  ts: number;
  recordedAt: number;
}

const liveBoosts = (boosts: BoostRecord[], after: number) =>
  boosts
    .filter((b) => b.endsAt > after)
    .sort((a, b) => a.startsAt - b.startsAt || (a.id < b.id ? -1 : 1))
    .map((b) => ({ ...b }));

const emptyProfile = (): ProfileData => ({ displayName: null, avatarUrl: null, metadata: {}, timezone: null });
const copyProfile = (p: ProfileData): ProfileData => ({ ...p, metadata: structuredClone(p.metadata) });

/** In-process store for tests, demos and local development. Data is lost on exit. */
export class MemoryStore implements Store {
  private users = new Map<string, UserData>();
  private ledger: LedgerRow[] = [];
  private members: Array<Membership & { userId: string }> = [];
  private friendships = new Map<string, Map<string, number>>();
  /** Keyed by "rivalryId|userA|userB" with userA < userB. */
  private rivals = new Map<string, { rivalryId: string; a: string; b: string; startedRound: string; since: number; rounds: Map<string, [number, number]> }>();
  private locks = new Map<string, Promise<unknown>>();
  /** Keyed by the referred user's id. */
  private referralRows = new Map<string, ReferralRecord>();
  /** Keyed by "userId|goalId". */
  private communityClaimRows = new Set<string>();
  /** Keyed by "userId|seasonId". */
  private seasonAwardRows = new Map<string, { rank: number; claimedAt: number }>();
  private teamRows = new Map<string, TeamRecord>();
  /** Keyed by user id: a user is in at most one team. */
  private teamMemberRows = new Map<string, TeamMemberRecord>();
  /** "userId|goalId|periodKey". */
  private teamGoalClaimRows = new Set<string>();

  async migrate(): Promise<MigrationReport> {
    return { applied: [], version: 0 };
  }

  private data(userId: string): UserData {
    let d = this.users.get(userId);
    if (!d) {
      d = {
        profile: emptyProfile(),
        events: new Map(),
        idempotency: new Map(),
        metrics: new Map(),
        balances: new Map(),
        streaks: new Map(),
        achievements: new Map(),
        quests: new Map(),
        spent: new Map(),
        inventory: new Map(),
        purchases: [],
        itemUses: [],
        boosts: [],
        calendars: new Map(),
        prestige: { rank: 0, base: 0 },
      };
      this.users.set(userId, d);
    }
    return d;
  }

  async withUser<T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => fn(this.tx(userId)));
    this.locks.set(userId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(userId) === run) this.locks.delete(userId);
    }
  }

  private tx(userId: string): UserTx {
    const d = this.data(userId);
    return {
      getProfile: async () => copyProfile(d.profile),
      updateProfile: async (patch) => {
        if (patch.displayName !== undefined) d.profile.displayName = patch.displayName;
        if (patch.avatarUrl !== undefined) d.profile.avatarUrl = patch.avatarUrl;
        if (patch.metadata !== undefined) d.profile.metadata = structuredClone(patch.metadata ?? {});
        if (patch.timezone !== undefined) d.profile.timezone = patch.timezone;
        return copyProfile(d.profile);
      },
      findByIdempotencyKey: async (key) => {
        const id = d.idempotency.get(key);
        return id ? (d.events.get(id)?.result ?? null) : null;
      },
      insertEvent: async (event) => {
        d.events.set(event.id, { ...event, properties: event.properties ? { ...event.properties } : null, result: null });
        if (event.idempotencyKey) d.idempotency.set(event.idempotencyKey, event.id);
      },
      setEventResult: async (eventId, result) => {
        const e = d.events.get(eventId);
        if (e) e.result = result;
      },
      addMetric: async (key, delta) => {
        const total = (d.metrics.get(key) ?? 0) + delta;
        d.metrics.set(key, total);
        return total;
      },
      getMetric: async (key) => d.metrics.get(key) ?? 0,
      addPoints: async (currency, amount, ts, _eventId, recordedAt) => {
        const total = (d.balances.get(currency) ?? 0) + amount;
        d.balances.set(currency, total);
        this.ledger.push({ userId, currency, amount, ts, recordedAt });
        return total;
      },
      getBalance: async (currency) => d.balances.get(currency) ?? 0,
      windowTotal: async (kind, key, from, to) => {
        let total = 0;
        if (kind === "points") {
          for (const l of this.ledger) if (l.userId === userId && l.currency === key && l.ts >= from && l.ts < to) total += l.amount;
        } else {
          for (const e of d.events.values()) if (e.key === key && e.ts >= from && e.ts < to) total += e.value;
        }
        return total;
      },
      getPrestige: async () => ({ ...d.prestige }),
      setPrestige: async (rank, base) => {
        d.prestige = { rank, base };
      },
      getSpent: async (currency) => d.spent.get(currency) ?? 0,
      spend: async (currency, amount) => {
        d.spent.set(currency, (d.spent.get(currency) ?? 0) + amount);
      },
      getInventory: async (itemId) => d.inventory.get(itemId) ?? 0,
      findPurchase: async (key) => {
        const p = d.purchases.find((x) => x.idempotencyKey === key);
        return p ? { ...p } : null;
      },
      getPurchase: async (id) => {
        const p = d.purchases.find((x) => x.id === id);
        return p ? { ...p } : null;
      },
      refundPurchase: async (id, quantity, amount) => {
        const p = d.purchases.find((x) => x.id === id)!;
        p.refunded += quantity;
        d.spent.set(p.currency, (d.spent.get(p.currency) ?? 0) - amount);
        d.inventory.set(p.itemId, (d.inventory.get(p.itemId) ?? 0) - quantity);
      },
      recordPurchase: async (p) => {
        d.purchases.push({ ...p });
        d.spent.set(p.currency, (d.spent.get(p.currency) ?? 0) + p.cost);
        const owned = (d.inventory.get(p.itemId) ?? 0) + p.quantity;
        d.inventory.set(p.itemId, owned);
        return owned;
      },
      getReferral: async () => {
        const r = this.referralRows.get(userId);
        return r ? { ...r } : null;
      },
      addReferral: async (r) => {
        if (this.referralRows.has(userId)) return false;
        this.data(r.referrerId);
        this.referralRows.set(userId, { ...r, referredId: userId });
        return true;
      },
      qualifyReferral: async (at) => {
        const r = this.referralRows.get(userId);
        if (r && r.qualifiedAt === null) r.qualifiedAt = at;
      },
      settleReferrals: async (max, at) => {
        const mine = [...this.referralRows.values()].filter((r) => r.referrerId === userId);
        let rewardedSoFar = mine.filter((r) => r.rewarded).length;
        const due = mine.filter((r) => r.qualifiedAt !== null && r.settledAt === null).sort((a, b) => a.qualifiedAt! - b.qualifiedAt! || (a.referredId < b.referredId ? -1 : 1));
        for (const r of due) {
          r.settledAt = at;
          r.rewarded = max === null || rewardedSoFar < max;
          if (r.rewarded) rewardedSoFar++;
        }
        return due.map((r) => ({ ...r }));
      },
      claimTeamGoalReward: async (goalId, periodKey) => {
        const key = `${userId}|${goalId}|${periodKey}`;
        if (this.teamGoalClaimRows.has(key)) return false;
        this.teamGoalClaimRows.add(key);
        return true;
      },
      claimSeasonAward: async (seasonId, rank, at) => {
        const key = `${userId}|${seasonId}`;
        if (this.seasonAwardRows.has(key)) return false;
        this.seasonAwardRows.set(key, { rank, claimedAt: at });
        return true;
      },
      claimCommunityReward: async (goalId) => {
        const key = `${userId}|${goalId}`;
        if (this.communityClaimRows.has(key)) return false;
        this.communityClaimRows.add(key);
        return true;
      },
      getCalendar: async (id) => {
        const c = d.calendars.get(id);
        return c ? { ...c } : null;
      },
      setCalendar: async (id, state) => {
        d.calendars.set(id, { ...state });
      },
      getBoosts: async (after) => liveBoosts(d.boosts, after),
      findBoost: async (key) => {
        const b = d.boosts.find((x) => x.idempotencyKey === key);
        return b ? { ...b } : null;
      },
      addBoost: async (b) => {
        d.boosts.push({ ...b });
      },
      findItemUse: async (key) => {
        const u = d.itemUses.find((x) => x.idempotencyKey === key);
        return u ? structuredClone(u.result) : null;
      },
      recordItemUse: async (u) => {
        d.itemUses.push(structuredClone(u));
        const left = (d.inventory.get(u.itemId) ?? 0) - u.quantity;
        d.inventory.set(u.itemId, left);
        return left;
      },
      getStreak: async (id) => {
        const s = d.streaks.get(id);
        return s ? { ...s } : null;
      },
      setStreak: async (id, state) => {
        d.streaks.set(id, { ...state });
      },
      getQuest: async (questId, periodKey) => {
        const q = d.quests.get(`${questId}|${periodKey}`);
        return q ? { ...q } : null;
      },
      setQuest: async (q) => {
        d.quests.set(`${q.questId}|${q.periodKey}`, { ...q });
      },
      unlockedAchievements: async () => new Set(d.achievements.keys()),
      revokeAchievement: async (id) => d.achievements.delete(id),
      getEvent: async (eventId) => {
        const e = d.events.get(eventId);
        if (!e) return null;
        return { id: e.id, key: e.key, value: e.value, ts: e.ts, recordedAt: e.recordedAt, result: e.result, properties: e.properties ?? null, reversedAt: (e as { reversedAt?: number | null }).reversedAt ?? null };
      },
      markReversed: async (eventId, at) => {
        const e = d.events.get(eventId) as { reversedAt?: number | null } | undefined;
        if (e) e.reversedAt = at;
      },
      unlock: async (id, ts) => {
        if (!d.achievements.has(id)) d.achievements.set(id, ts);
      },
      getMemberships: async (leagueId, limit) =>
        this.members
          .filter((m) => m.userId === userId && m.leagueId === leagueId)
          .sort((a, b) => (a.roundKey < b.roundKey ? 1 : -1))
          .slice(0, limit)
          .map(({ userId: _u, ...m }) => ({ ...m })),
      joinLeague: async (leagueId, roundKey, tier, groupSize, joinedAt) => {
        const counts = new Map<number, number>();
        for (const m of this.members) {
          if (m.leagueId === leagueId && m.roundKey === roundKey && m.tier === tier) counts.set(m.group, (counts.get(m.group) ?? 0) + 1);
        }
        let group = 1;
        while ((counts.get(group) ?? 0) >= groupSize) group++;
        this.members.push({ userId, leagueId, roundKey, tier, group, joinedAt, outcome: null, finalRank: null, nextTier: null });
        return group;
      },
      settleMembership: async (leagueId, roundKey, result) => {
        const m = this.members.find((x) => x.userId === userId && x.leagueId === leagueId && x.roundKey === roundKey);
        if (m) Object.assign(m, result);
      },
      groupStandings: async (q) => {
        const rows: GroupMember[] = this.members
          .filter((m) => m.leagueId === q.leagueId && m.roundKey === q.roundKey && m.tier === q.tier && m.group === q.group)
          .map((m) => ({
            userId: m.userId,
            joinedAt: m.joinedAt,
            score: this.ledger
              .filter(
                (l) =>
                  l.userId === m.userId &&
                  l.currency === q.currency &&
                  l.ts >= q.from &&
                  l.ts < q.to &&
                  (q.recordedBefore === null || l.recordedAt < q.recordedBefore),
              )
              .reduce((sum, l) => sum + l.amount, 0),
          }));
        return rows.sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt || (a.userId < b.userId ? -1 : 1));
      },
    };
  }

  async snapshot(userId: string): Promise<UserSnapshot> {
    const d = this.users.get(userId);
    if (!d) return { profile: emptyProfile(), metrics: {}, balances: {}, spent: {}, inventory: {}, calendars: {}, prestige: { rank: 0, base: 0 }, streaks: {}, achievements: [] };
    return {
      profile: copyProfile(d.profile),
      metrics: Object.fromEntries(d.metrics),
      balances: Object.fromEntries(d.balances),
      spent: Object.fromEntries(d.spent),
      inventory: Object.fromEntries([...d.inventory].filter(([, n]) => n > 0)),
      calendars: Object.fromEntries([...d.calendars].map(([k, v]) => [k, { ...v }])),
      prestige: { ...d.prestige },
      streaks: Object.fromEntries([...d.streaks].map(([k, v]) => [k, { ...v }])),
      achievements: [...d.achievements]
        .sort((a, b) => a[1] - b[1])
        .map(([id, ts]) => ({ id, unlockedAt: new Date(ts).toISOString() })),
    };
  }

  async leaderboard(q: LeaderboardQuery): Promise<{ entries: LeaderboardEntry[]; user: LeaderboardEntry | null }> {
    const scores = new Map<string, number>();
    for (const row of this.ledger) {
      if (row.currency !== q.currency) continue;
      if (q.userIds && !q.userIds.includes(row.userId)) continue;
      if (q.from !== null && row.ts < q.from) continue;
      if (q.to !== null && row.ts >= q.to) continue;
      if (q.recordedBefore != null && row.recordedAt >= q.recordedBefore) continue;
      if (q.segment) {
        const v = this.users.get(row.userId)?.profile.metadata[q.segment.key];
        if (v === undefined || v === null || typeof v === "object" || String(v) !== q.segment.value) continue;
      }
      scores.set(row.userId, (scores.get(row.userId) ?? 0) + row.amount);
    }
    const sorted = [...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    // Standard competition ranking: equal scores share a rank (1, 2, 2, 4).
    const ranked: LeaderboardEntry[] = [];
    sorted.forEach(([userId, score], i) => {
      const prev = ranked[i - 1];
      ranked.push({ userId, score, rank: prev && prev.score === score ? prev.rank : i + 1 });
    });
    const userIndex = q.userId ? ranked.findIndex((e) => e.userId === q.userId) : -1;
    return {
      entries: q.around !== undefined && userIndex >= 0 ? ranked.slice(Math.max(0, userIndex - q.around), userIndex + q.around + 1) : ranked.slice(0, q.limit),
      user: userIndex >= 0 ? ranked[userIndex]! : null,
    };
  }

  async profiles(userIds: string[]): Promise<Record<string, PublicProfile>> {
    const out: Record<string, PublicProfile> = {};
    for (const id of userIds) {
      const p = this.users.get(id)?.profile;
      if (p && (p.displayName !== null || p.avatarUrl !== null)) out[id] = { displayName: p.displayName, avatarUrl: p.avatarUrl };
    }
    return out;
  }

  async events(userId: string, q: EventPageQuery): Promise<EventRecord[]> {
    const d = this.users.get(userId);
    if (!d) return [];
    const before = q.before;
    return [...d.events.values()]
      .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
      .filter((e) => !before || e.ts < before.ts || (e.ts === before.ts && e.id < before.id))
      .slice(0, q.limit)
      .map((e) => ({ id: e.id, key: e.key, value: e.value, ts: e.ts, recordedAt: e.recordedAt, result: e.result, properties: e.properties ? { ...e.properties } : null, reversedAt: (e as { reversedAt?: number | null }).reversedAt ?? null }));
  }

  async userIds(afterUserId: string | null, limit: number): Promise<string[]> {
    return [...this.users.keys()].filter((id) => afterUserId === null || id > afterUserId).sort().slice(0, limit);
  }

  async activeStreaks(streakId: string, afterUserId: string | null, limit: number) {
    return [...this.users.entries()]
      .filter(([id, d]) => (afterUserId === null || id > afterUserId) && (d.streaks.get(streakId)?.current ?? 0) > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([userId, d]) => ({ userId, state: { ...d.streaks.get(streakId)! }, timezone: d.profile.timezone }));
  }

  async communityTotal(q: CommunityTotalQuery): Promise<number> {
    let total = 0;
    if (q.kind === "points") {
      for (const l of this.ledger) {
        if (l.currency === q.key && l.ts >= q.from && l.ts < q.to && (!q.userId || l.userId === q.userId)) total += l.amount;
      }
      return total;
    }
    const users = q.userId ? [this.users.get(q.userId)].filter((d): d is UserData => !!d) : [...this.users.values()];
    for (const d of users) for (const e of d.events.values()) if (e.key === q.key && e.ts >= q.from && e.ts < q.to) total += e.value;
    return total;
  }

  async saveTeam(team: TeamRecord): Promise<boolean> {
    const existing = this.teamRows.get(team.id);
    if (existing) {
      existing.name = team.name;
      return false;
    }
    this.teamRows.set(team.id, { ...team });
    return true;
  }

  async getTeam(teamId: string): Promise<TeamRecord | null> {
    const t = this.teamRows.get(teamId);
    return t ? { ...t } : null;
  }

  async addTeamMember(teamId: string, userId: string, joinedAt: number, maxMembers: number): Promise<boolean> {
    const current = this.teamMemberRows.get(userId);
    if (current?.teamId === teamId) return false;
    if (current) throw new AlreadyInTeamError(current.teamId);
    const size = [...this.teamMemberRows.values()].filter((m) => m.teamId === teamId).length;
    if (size >= maxMembers) throw new TeamFullError(teamId);
    this.data(userId);
    this.teamMemberRows.set(userId, { userId, teamId, joinedAt });
    return true;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<boolean> {
    if (this.teamMemberRows.get(userId)?.teamId !== teamId) return false;
    this.teamMemberRows.delete(userId);
    return true;
  }

  async teamMembers(teamId: string): Promise<TeamMemberRecord[]> {
    return [...this.teamMemberRows.values()]
      .filter((m) => m.teamId === teamId)
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.userId < b.userId ? -1 : 1))
      .map((m) => ({ ...m }));
  }

  async userTeam(userId: string): Promise<TeamMemberRecord | null> {
    const m = this.teamMemberRows.get(userId);
    return m ? { ...m } : null;
  }

  async teamContributions(teamId: string, kind: "event" | "points", key: string, from: number, to: number): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const m of this.teamMemberRows.values()) {
      if (m.teamId !== teamId) continue;
      const since = Math.max(from, m.joinedAt);
      let total = 0;
      if (kind === "points") {
        for (const l of this.ledger) if (l.userId === m.userId && l.currency === key && l.ts >= since && l.ts < to) total += l.amount;
      } else {
        for (const e of this.users.get(m.userId)?.events.values() ?? []) if (e.key === key && e.ts >= since && e.ts < to) total += e.value;
      }
      if (total !== 0) out[m.userId] = total;
    }
    return out;
  }

  async teamGoalClaims(userId: string): Promise<Set<string>> {
    return new Set([...this.teamGoalClaimRows].filter((k) => k.startsWith(`${userId}|`)).map((k) => k.slice(userId.length + 1)));
  }

  async teamMemberScores(teamId: string, currency: string, from: number | null, to: number | null): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const l of this.ledger) {
      const m = this.teamMemberRows.get(l.userId);
      if (!m || m.teamId !== teamId || l.currency !== currency) continue;
      if (l.ts < m.joinedAt || (from !== null && l.ts < from) || (to !== null && l.ts >= to)) continue;
      out[l.userId] = (out[l.userId] ?? 0) + l.amount;
    }
    return out;
  }

  async teamScores(q: TeamScoreQuery) {
    const scores = new Map<string, number>([...this.teamRows.keys()].map((id) => [id, 0]));
    for (const l of this.ledger) {
      const m = this.teamMemberRows.get(l.userId);
      if (!m || l.currency !== q.currency) continue;
      if (l.ts < m.joinedAt || (q.from !== null && l.ts < q.from) || (q.to !== null && l.ts >= q.to)) continue;
      scores.set(m.teamId, (scores.get(m.teamId) ?? 0) + l.amount);
    }
    const sorted = [...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const ranked: Array<{ rank: number; teamId: string; score: number }> = [];
    sorted.forEach(([teamId, score], i) => {
      const prev = ranked[i - 1];
      ranked.push({ teamId, score, rank: prev && prev.score === score ? prev.rank : i + 1 });
    });
    return { entries: ranked.slice(0, q.limit), team: q.teamId ? (ranked.find((e) => e.teamId === q.teamId) ?? null) : null };
  }

  async seasonAwards(userId: string): Promise<Record<string, { rank: number; claimedAt: number }>> {
    const out: Record<string, { rank: number; claimedAt: number }> = {};
    for (const [k, v] of this.seasonAwardRows) if (k.startsWith(`${userId}|`)) out[k.slice(userId.length + 1)] = { ...v };
    return out;
  }

  async communityClaims(userId: string): Promise<Set<string>> {
    return new Set([...this.communityClaimRows].filter((k) => k.startsWith(`${userId}|`)).map((k) => k.slice(userId.length + 1)));
  }

  async referrals(userId: string): Promise<{ referredBy: ReferralRecord | null; referred: ReferralRecord[] }> {
    const by = this.referralRows.get(userId);
    const referred = [...this.referralRows.values()]
      .filter((r) => r.referrerId === userId)
      .sort((a, b) => b.createdAt - a.createdAt || (a.referredId < b.referredId ? 1 : -1))
      .map((r) => ({ ...r }));
    return { referredBy: by ? { ...by } : null, referred };
  }

  async boosts(userId: string, after: number): Promise<BoostRecord[]> {
    const d = this.users.get(userId);
    return d ? liveBoosts(d.boosts, after) : [];
  }

  async purchases(userId: string, q: PurchasePageQuery): Promise<PurchaseRecord[]> {
    const d = this.users.get(userId);
    if (!d) return [];
    const before = q.before;
    return [...d.purchases]
      .sort((a, b) => b.purchasedAt - a.purchasedAt || (a.id < b.id ? 1 : -1))
      .filter((p) => !before || p.purchasedAt < before.ts || (p.purchasedAt === before.ts && p.id < before.id))
      .slice(0, q.limit)
      .map((p) => ({ ...p }));
  }

  async addFriendship(a: string, b: string, ts: number, maxFriends: number): Promise<boolean> {
    this.data(a);
    this.data(b);
    const of = (id: string) => {
      let m = this.friendships.get(id);
      if (!m) this.friendships.set(id, (m = new Map()));
      return m;
    };
    if (of(a).has(b)) return false;
    for (const id of [a, b]) if (of(id).size >= maxFriends) throw new FriendLimitError(id);
    of(a).set(b, ts);
    of(b).set(a, ts);
    return true;
  }

  async removeFriendship(a: string, b: string): Promise<boolean> {
    const existed = this.friendships.get(a)?.delete(b) ?? false;
    this.friendships.get(b)?.delete(a);
    return existed;
  }

  async friends(userId: string): Promise<FriendRecord[]> {
    return [...(this.friendships.get(userId) ?? [])]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .map(([id, since]) => {
        const p = this.users.get(id)?.profile;
        return { userId: id, since, displayName: p?.displayName ?? null, avatarUrl: p?.avatarUrl ?? null };
      });
  }

  async addRivalry(rivalryId: string, a: string, b: string, startedRound: string, ts: number, max: number): Promise<boolean> {
    this.data(a);
    this.data(b);
    const [ua, ub] = a < b ? [a, b] : [b, a];
    const key = `${rivalryId}|${ua}|${ub}`;
    if (this.rivals.has(key)) return false;
    for (const id of [a, b]) {
      const count = [...this.rivals.values()].filter((r) => r.rivalryId === rivalryId && (r.a === id || r.b === id)).length;
      if (count >= max) throw new RivalLimitError(id);
    }
    this.rivals.set(key, { rivalryId, a: ua, b: ub, startedRound, since: ts, rounds: new Map() });
    return true;
  }

  async removeRivalry(rivalryId: string, a: string, b: string): Promise<boolean> {
    const [ua, ub] = a < b ? [a, b] : [b, a];
    return this.rivals.delete(`${rivalryId}|${ua}|${ub}`);
  }

  async quests(userId: string, keys: Array<{ questId: string; periodKey: string }>): Promise<QuestProgress[]> {
    const d = this.users.get(userId);
    if (!d) return [];
    return keys.flatMap((k) => {
      const q = d.quests.get(`${k.questId}|${k.periodKey}`);
      return q ? [{ ...q }] : [];
    });
  }

  async rivalries(rivalryId: string, userId: string): Promise<RivalRecord[]> {
    return [...this.rivals.values()]
      .filter((r) => r.rivalryId === rivalryId && (r.a === userId || r.b === userId))
      .map((r) => {
        const mine = r.a === userId;
        return {
          rivalId: mine ? r.b : r.a,
          startedRound: r.startedRound,
          since: r.since,
          rounds: [...r.rounds]
            .sort((x, y) => (x[0] < y[0] ? -1 : 1))
            .map(([roundKey, [sa, sb]]) => ({ roundKey, you: mine ? sa : sb, them: mine ? sb : sa })),
        };
      })
      .sort((x, y) => y.since - x.since || (x.rivalId < y.rivalId ? -1 : 1));
  }

  async recordRivalryRound(rivalryId: string, a: string, b: string, roundKey: string, scoreA: number, scoreB: number): Promise<void> {
    const [ua, ub, sa, sb] = a < b ? [a, b, scoreA, scoreB] : [b, a, scoreB, scoreA];
    const r = this.rivals.get(`${rivalryId}|${ua}|${ub}`);
    if (r && !r.rounds.has(roundKey)) r.rounds.set(roundKey, [sa, sb]);
  }

  async windowScores(q: WindowScoreQuery): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const l of this.ledger) {
      if (l.currency !== q.currency || l.ts < q.from || l.ts >= q.to) continue;
      if (q.recordedBefore !== null && l.recordedAt >= q.recordedBefore) continue;
      if (!q.userIds.includes(l.userId)) continue;
      out[l.userId] = (out[l.userId] ?? 0) + l.amount;
    }
    return out;
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
