import type { TrackResult } from "../engine.js";
import type { StreakState } from "../streaks.js";
import type { LeaderboardEntry, LeaderboardQuery, Store, StoredEvent, UserSnapshot, UserTx } from "./types.js";

interface UserData {
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
}

/** In-process store for tests, demos and local development. Data is lost on exit. */
export class MemoryStore implements Store {
  private users = new Map<string, UserData>();
  private ledger: LedgerRow[] = [];
  private locks = new Map<string, Promise<unknown>>();

  async migrate(): Promise<void> {}

  private data(userId: string): UserData {
    let d = this.users.get(userId);
    if (!d) {
      d = {
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
      addPoints: async (currency, amount, ts) => {
        const total = (d.balances.get(currency) ?? 0) + amount;
        d.balances.set(currency, total);
        this.ledger.push({ userId, currency, amount, ts });
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
    };
  }

  async snapshot(userId: string): Promise<UserSnapshot> {
    const d = this.users.get(userId);
    if (!d) return { metrics: {}, balances: {}, streaks: {}, achievements: [] };
    return {
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
}
