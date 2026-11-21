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
  group: { number: number; size: number; entries: Array<{ rank: number; userId: string; score: number; zone: LeagueZone }> } | null;
  you: { rank: number; userId: string; score: number; zone: LeagueZone } | null;
  previous: LeaguePrevious | null;
}

export interface UserProfile {
  userId: string;
  points: Record<string, number>;
  level: { current: number; points: number; nextAt: number | null } | null;
  metrics: Record<string, number>;
  streaks: Record<string, { current: number; longest: number; freezes: number; lastPeriod: string | null; status: "none" | "done" | "pending" | "broken" }>;
  achievements: Array<{ id: string; name: string; description?: string; unlockedAt: string }>;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  score: number;
}

export interface LeaderboardResult {
  id: string;
  currency: string;
  period: "daily" | "weekly" | "monthly" | "all";
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
  ) {
    super(message);
    this.name = "OnstreakError";
  }
}

export function createClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new OnstreakError(res.status, data.error ?? `onstreak request failed with ${res.status}`);
    return data as T;
  }

  return {
    /** Record that a user did something. Returns points, streaks and achievements it triggered. */
    track: (input: TrackInput) => call<TrackResult>("POST", "/v1/events", input),
    /** A user's points, level, streaks and achievements. */
    getUser: (userId: string, opts: { timezone?: string } = {}) =>
      call<UserProfile>("GET", `/v1/users/${encodeURIComponent(userId)}${opts.timezone ? `?timezone=${encodeURIComponent(opts.timezone)}` : ""}`),
    /** Top entries of a leaderboard, plus the given user's own rank. */
    leaderboard: (id: string, opts: { limit?: number; userId?: string } = {}) => {
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.userId) params.set("userId", opts.userId);
      const qs = params.toString();
      return call<LeaderboardResult>("GET", `/v1/leaderboards/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
    },
    /** The user's league tier, their group's live standings this round, and how last round ended. */
    league: (id: string, userId: string) =>
      call<LeagueStatus>("GET", `/v1/leagues/${encodeURIComponent(id)}/users/${encodeURIComponent(userId)}`),
  };
}

export type OnstreakClient = ReturnType<typeof createClient>;
