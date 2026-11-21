import type { TrackResult } from "../engine.js";
import type { StreakState } from "../streaks.js";
import type {
  EventPageQuery,
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
}

interface LedgerRow {
  userId: string;
  currency: string;
  amount: number;
  ts: number;
  recordedAt: number;
}

const emptyProfile = (): ProfileData => ({ displayName: null, avatarUrl: null, metadata: {}, timezone: null });
const copyProfile = (p: ProfileData): ProfileData => ({ ...p, metadata: structuredClone(p.metadata) });

/** In-process store for tests, demos and local development. Data is lost on exit. */
export class MemoryStore implements Store {
  private users = new Map<string, UserData>();
  private ledger: LedgerRow[] = [];
  private members: Array<Membership & { userId: string }> = [];
  private locks = new Map<string, Promise<unknown>>();

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
        d.events.set(event.id, { ...event, result: null });
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
      getStreak: async (id) => {
        const s = d.streaks.get(id);
        return s ? { ...s } : null;
      },
      setStreak: async (id, state) => {
        d.streaks.set(id, { ...state });
      },
      unlockedAchievements: async () => new Set(d.achievements.keys()),
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
    if (!d) return { profile: emptyProfile(), metrics: {}, balances: {}, streaks: {}, achievements: [] };
    return {
      profile: copyProfile(d.profile),
      metrics: Object.fromEntries(d.metrics),
      balances: Object.fromEntries(d.balances),
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
      if (q.from !== null && row.ts < q.from) continue;
      if (q.to !== null && row.ts >= q.to) continue;
      scores.set(row.userId, (scores.get(row.userId) ?? 0) + row.amount);
    }
    const sorted = [...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    // Standard competition ranking: equal scores share a rank (1, 2, 2, 4).
    const ranked: LeaderboardEntry[] = [];
    sorted.forEach(([userId, score], i) => {
      const prev = ranked[i - 1];
      ranked.push({ userId, score, rank: prev && prev.score === score ? prev.rank : i + 1 });
    });
    return {
      entries: ranked.slice(0, q.limit),
      user: q.userId ? (ranked.find((e) => e.userId === q.userId) ?? null) : null,
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
      .map((e) => ({ id: e.id, key: e.key, value: e.value, ts: e.ts, recordedAt: e.recordedAt, result: e.result }));
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
