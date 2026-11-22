import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Engine, EngineError } from "./engine.js";
import { silentLogger, type Logger } from "./logger.js";
import { openapiSpec } from "./openapi.js";
import { packageVersion } from "./version.js";
import { Metrics, routeLabel } from "./metrics.js";
import { deriveTokenSecret, isUserToken, signUserToken, verifyUserToken } from "./tokens.js";

const MAX_BODY = 256 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ServerOptions {
  /** Secret clients send as `Authorization: Bearer <key>`. At least 16 characters. Has the admin scope. */
  apiKey?: string;
  /**
   * More keys, each with a scope: "read" (GET only), "write" (everything an
   * app does) or "admin" (also deleting and exporting users, reversing
   * events, revoking achievements, config preview and the webhook log).
   * Several keys at once make rotation easy: add the new one, then remove
   * the old.
   */
  apiKeys?: Array<{ key: string; scope: KeyScope; name?: string }>;
  /** Where request and error logs go. Default: nowhere. */
  logger?: Logger;
  /** How long the database check in /health may take. Default 2000 ms. */
  healthTimeoutMs?: number;
  /**
   * Limit each client to `perMinute` API requests (a token bucket that refills
   * steadily, allowing bursts up to `burst`, default perMinute). Clients are
   * told apart by IP, or by the first x-forwarded-for address with
   * `trustProxy`. Over the limit: 429 with retry-after. Default: no limit.
   */
  rateLimit?: { perMinute: number; burst?: number; trustProxy?: boolean };
  /** Origins allowed to call the API from a browser ("*" for any). Default: none (no CORS headers). */
  corsOrigins?: string[];
  /** Where request counts and timings go (GET /metrics). Default: a new registry. */
  metrics?: Metrics;
  /** A separate secret a Prometheus scraper may use for GET /metrics instead of an API key. */
  metricsToken?: string;
  /** Secret that signs user tokens (POST /v1/tokens). Default: derived from the first key, so rotating that key ends all tokens. */
  tokenSecret?: string;
}

/**
 * Whether a user token for `userId` may make this call: GETs about that
 * user, and shared views (leaderboards, seasons, community goals, teams)
 * that do not name another user.
 */
function userTokenAllows(method: string | undefined, parts: string[], url: URL, userId: string): boolean {
  if (method !== "GET") return false;
  const [, resource, id, sub, subId] = parts;
  const named = url.searchParams.get("userId");
  if (named !== null && named !== userId) return false;
  if (resource === "users") return id === userId && sub !== "export";
  if (resource === "leagues" || resource === "rivalries") return sub === "users" && subId === userId && parts.length === 5;
  if (resource === "streaks") return false;
  return ["leaderboards", "seasons", "community-goals", "teams"].includes(resource ?? "");
}

/** A token bucket per client key. Old idle buckets are dropped as it grows. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly burst: number = perMinute,
  ) {
    if (!(perMinute > 0) || !(burst >= 1)) throw new Error("rate limit needs perMinute > 0 and burst >= 1");
  }

  /** Take one token. Returns 0 if allowed, else the seconds to wait. */
  take(key: string, now = Date.now()): number {
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) {
      for (const [k, v] of this.buckets) if (now - v.at > 600_000) this.buckets.delete(k);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / rate / 1000);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type KeyScope = "read" | "write" | "admin";
const SCOPES: readonly KeyScope[] = ["read", "write", "admin"];

/** The scope of the key in the Authorization header, or null if it matches none. Every key is compared, so timing does not reveal which. */
function scopeOf(req: IncomingMessage, keys: Array<{ key: Buffer; scope: KeyScope }>): KeyScope | null {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  let found: KeyScope | null = null;
  for (const k of keys) {
    if (given.length === k.key.length && timingSafeEqual(given, k.key) && found === null) found = k.scope;
  }
  return found;
}

/** Routes only an admin key may call. */
function isAdminRoute(method: string | undefined, parts: string[]): boolean {
  const [, resource, , sub, , subSub] = parts;
  if (resource === "users" && method === "DELETE" && parts.length === 3) return true;
  if (resource === "users" && sub === "export") return true;
  if (resource === "users" && sub === "events" && subSub === "reverse") return true;
  if (resource === "users" && sub === "achievements" && method === "DELETE") return true;
  if (resource === "config") return true;
  if (resource === "webhooks") return true;
  return false;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  return raw === null ? undefined : Number(raw);
}

/** Shared between the handler and shutdown(). */
interface ServerState {
  shuttingDown: boolean;
}

function buildHandler(engine: Engine, options: ServerOptions, state: ServerState) {
  const keys: Array<{ key: Buffer; scope: KeyScope }> = [];
  if (options.apiKey !== undefined) keys.push({ key: Buffer.from(options.apiKey), scope: "admin" });
  for (const k of options.apiKeys ?? []) {
    if (!SCOPES.includes(k.scope)) throw new Error(`api key scope must be read, write or admin, not "${String(k.scope)}"`);
    keys.push({ key: Buffer.from(k.key ?? ""), scope: k.scope });
  }
  if (keys.length === 0) throw new Error("set apiKey or apiKeys");
  if (keys.some((k) => k.key.length < 16)) throw new Error("apiKey must be at least 16 characters");
  if (options.tokenSecret !== undefined && options.tokenSecret.length < 32) throw new Error("tokenSecret must be at least 32 characters");
  const tokenSecret = options.tokenSecret ?? deriveTokenSecret(keys[0]!.key.toString());
  const metrics = options.metrics ?? new Metrics();
  const logger = options.logger ?? silentLogger;
  const healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  const spec = openapiSpec(packageVersion());
  const limiter = options.rateLimit ? new RateLimiter(options.rateLimit.perMinute, options.rateLimit.burst) : null;
  const corsOrigins = options.corsOrigins ?? [];

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = process.hrtime.bigint();
    const incoming = req.headers["x-request-id"];
    const requestId = typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    const allowOrigin = origin && corsOrigins.length > 0 ? (corsOrigins.includes("*") ? "*" : corsOrigins.includes(origin) ? origin : null) : null;
    const cors: Record<string, string> = allowOrigin
      ? {
          "access-control-allow-origin": allowOrigin,
          "access-control-expose-headers": "x-request-id, retry-after",
          ...(allowOrigin !== "*" ? { vary: "origin" } : {}),
        }
      : {};
    const extraHeaders: Record<string, string> = {};

    const send = (status: number, body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(status, {
        ...cors,
        ...extraHeaders,
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(json),
        "x-request-id": requestId,
        // Tell keep-alive clients to reconnect elsewhere while we drain.
        ...(state.shuttingDown ? { connection: "close" } : {}),
      });
      res.end(json);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const route = routeLabel(url.pathname.split("/").filter(Boolean));
      metrics.requests.inc({ method: req.method ?? "?", route, status: String(status) });
      metrics.duration.observe({ method: req.method ?? "?", route }, durationMs / 1000);
      const fields = { requestId, method: req.method, path: url.pathname, status, durationMs: Math.round(durationMs * 10) / 10 };
      if (status >= 500) logger.error("request", fields);
      else logger.info("request", fields);
    };

    try {
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      // Liveness: the process is up. Readiness: it can serve traffic, database included.
      if (req.method === "GET" && url.pathname === "/health/live") return send(200, { ok: true });
      if (req.method === "GET" && url.pathname === "/health") {
        if (state.shuttingDown) return send(503, { ok: false, status: "shutting_down" });
        try {
          await withTimeout(engine.ping(), healthTimeoutMs);
          return send(200, { ok: true, database: "ok" });
        } catch (err) {
          logger.warn("health check failed", { requestId, err });
          return send(503, { ok: false, database: "unreachable" });
        }
      }

      if (req.method === "GET" && url.pathname === "/openapi.json") return send(200, spec);
      if (req.method === "GET" && url.pathname === "/metrics") {
        // Any API key, or a metrics token, may scrape. User tokens may not.
        const bearer = (req.headers.authorization ?? "").startsWith("Bearer ") ? (req.headers.authorization as string).slice(7) : "";
        const metricsOk = options.metricsToken !== undefined && bearer.length === options.metricsToken.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(options.metricsToken));
        if (!metricsOk && scopeOf(req, keys) === null) throw new HttpError(401, "missing or wrong API key");
        const text = metrics.render();
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "x-request-id": requestId });
        res.end(text);
        metrics.requests.inc({ method: "GET", route: "/metrics", status: "200" });
        return;
      }

      if (req.method === "OPTIONS") {
        // CORS preflight. Without an allowed origin, browsers block the call.
        res.writeHead(204, {
          ...cors,
          ...(allowOrigin
            ? { "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE", "access-control-allow-headers": "authorization, content-type, x-request-id", "access-control-max-age": "600" }
            : {}),
          "x-request-id": requestId,
        });
        res.end();
        return;
      }

      if (state.shuttingDown) throw new HttpError(503, "server is shutting down");
      if (limiter) {
        const forwarded = options.rateLimit?.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "";
        const client = forwarded || req.socket.remoteAddress || "unknown";
        const wait = limiter.take(client);
        if (wait > 0) {
          extraHeaders["retry-after"] = String(wait);
          throw new HttpError(429, "too many requests, slow down");
        }
      }
      const bearer = (req.headers.authorization ?? "").startsWith("Bearer ") ? (req.headers.authorization as string).slice(7) : "";
      if (isUserToken(bearer)) {
        const tokenUser = verifyUserToken(tokenSecret, bearer, engine.clock());
        if (tokenUser === null) throw new HttpError(401, "user token is invalid or expired");
        if (parts[0] !== "v1") throw new HttpError(404, "not found");
        if (!userTokenAllows(req.method, parts, url, tokenUser)) throw new HttpError(403, "a user token can only read its own user");
      }
      const scope = isUserToken(bearer) ? "read" : scopeOf(req, keys);
      if (scope === null) throw new HttpError(401, "missing or wrong API key");
      if (parts[0] !== "v1") throw new HttpError(404, "not found");
      if (req.method === "POST" && parts[1] === "tokens" && parts.length === 2) {
        if (scope === "read") throw new HttpError(403, "this key can only read (GET)");
        const body = (await readJson(req)) as { userId?: unknown; ttlSeconds?: unknown } | null;
        const userId = body?.userId;
        if (typeof userId !== "string" || !/^[^\s]{1,128}$/.test(userId)) throw new HttpError(400, "userId must be a non-empty string without spaces");
        const ttl = body?.ttlSeconds ?? 3600;
        if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) throw new HttpError(400, "ttlSeconds must be a whole number from 60 to 86400");
        const expiresAt = Math.floor((engine.clock() + ttl * 1000) / 1000) * 1000;
        return send(200, { token: signUserToken(tokenSecret, userId, expiresAt), userId, expiresAt: new Date(expiresAt).toISOString() });
      }
      if (scope === "read" && req.method !== "GET") throw new HttpError(403, "this key can only read (GET)");
      if (scope !== "admin" && isAdminRoute(req.method, parts)) throw new HttpError(403, "this needs an admin key");
      const [, resource, id, sub, subId, subSub, subSubId] = parts;

      if (req.method === "GET" && resource === "webhooks" && id === "deliveries" && parts.length === 3) {
        const limit = intParam(url, "limit");
        const status = url.searchParams.get("status") ?? undefined;
        const cursor = url.searchParams.get("cursor") ?? undefined;
        return send(200, await engine.webhookDeliveries({ ...(limit !== undefined ? { limit } : {}), ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }));
      }
      if (req.method === "POST" && resource === "config" && id === "preview" && parts.length === 3) {
        return send(200, await engine.previewConfig(await readJson(req)));
      }

      if (req.method === "POST" && resource === "events" && parts.length === 2) {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
        const tracked = await engine.track(body as Parameters<Engine["track"]>[0]);
        if (!tracked.duplicate) metrics.events.inc();
        return send(200, tracked);
      }

      if (req.method === "POST" && resource === "events" && id === "batch" && parts.length === 3) {
        const body = (await readJson(req)) as { events?: unknown } | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, 'body must be { "events": [...] }');
        const results = await engine.trackBatch(body.events);
        const fresh = results.filter((r) => r.ok && !r.result.duplicate).length;
        if (fresh) metrics.events.inc({}, fresh);
        return send(200, { results });
      }

      const locale = url.searchParams.get("locale") ?? undefined;
      const withLocale = locale ? { locale } : {};
      if (resource === "users" && id && parts.length === 3) {
        if (req.method === "GET") {
          const timezone = url.searchParams.get("timezone") ?? undefined;
          return send(200, await engine.getUser(id, { ...(timezone ? { timezone } : {}), ...withLocale }));
        }
        if (req.method === "PATCH") return send(200, await engine.updateUser(id, await readJson(req)));
        if (req.method === "DELETE") return send(200, await engine.deleteUser(id));
      }

      if (req.method === "GET" && resource === "users" && id && sub === "events" && parts.length === 4) {
        const limit = intParam(url, "limit");
        const cursor = url.searchParams.get("cursor") ?? undefined;
        return send(200, await engine.events(id, { ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) }));
      }

      if (req.method === "GET" && resource === "users" && id && sub === "quests" && parts.length === 4) {
        const timezone = url.searchParams.get("timezone") ?? undefined;
        return send(200, await engine.quests(id, { ...(timezone ? { timezone } : {}), ...withLocale }));
      }

      if (req.method === "POST" && resource === "users" && id && sub === "streaks" && subId && subSub === "repair" && parts.length === 6) {
        return send(200, await engine.repairStreak(id, subId));
      }

      if (req.method === "GET" && resource === "users" && id && sub === "store" && parts.length === 4) {
        return send(200, await engine.rewardStore(id, withLocale));
      }

      if (req.method === "POST" && resource === "users" && id && sub === "purchases" && subId && subSub === "refund" && parts.length === 6) {
        const body = await readJson(req);
        return send(200, await engine.refundPurchase(id, subId, (body ?? {}) as { quantity?: number }));
      }

      if (resource === "users" && id && sub === "purchases" && parts.length === 4) {
        if (req.method === "POST") return send(200, await engine.purchase(id, (await readJson(req)) as Parameters<Engine["purchase"]>[1]));
        if (req.method === "GET") {
          const limit = intParam(url, "limit");
          const cursor = url.searchParams.get("cursor") ?? undefined;
          return send(200, await engine.purchases(id, { ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) }));
        }
      }

      if (req.method === "POST" && resource === "users" && id && sub === "inventory" && subId && subSub === "use" && parts.length === 6) {
        const body = await readJson(req);
        return send(200, await engine.useItem(id, subId, (body ?? {}) as Parameters<Engine["useItem"]>[2]));
      }

      if (req.method === "POST" && resource === "users" && id && sub === "boosts" && parts.length === 4) {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
        return send(200, await engine.grantBoost(id, body as Parameters<Engine["grantBoost"]>[1]));
      }

      if (req.method === "GET" && resource === "users" && id && sub === "calendars" && parts.length === 4) {
        const timezone = url.searchParams.get("timezone") ?? undefined;
        return send(200, await engine.calendars(id, { ...(timezone ? { timezone } : {}), ...withLocale }));
      }

      if (req.method === "PUT" && resource === "users" && id && sub === "referred-by" && subId && parts.length === 5) {
        return send(200, await engine.addReferral(id, subId));
      }
      if (req.method === "GET" && resource === "users" && id && sub === "referrals" && parts.length === 4) {
        return send(200, await engine.referrals(id));
      }

      if (resource === "users" && id && sub === "friends") {
        if (req.method === "GET" && parts.length === 4) return send(200, await engine.friends(id));
        if (req.method === "PUT" && subId && parts.length === 5) return send(200, await engine.addFriend(id, subId));
        if (req.method === "DELETE" && subId && parts.length === 5) return send(200, await engine.removeFriend(id, subId));
      }

      if (resource === "rivalries" && id && sub === "users" && subId) {
        if (req.method === "GET" && parts.length === 5) return send(200, await engine.rivals(id, subId));
        if (subSub === "rivals" && subSubId && parts.length === 7) {
          if (req.method === "PUT") return send(200, await engine.addRival(id, subId, subSubId));
          if (req.method === "DELETE") return send(200, await engine.removeRival(id, subId, subSubId));
        }
      }

      if (req.method === "GET" && resource === "leaderboards" && id && parts.length === 3) {
        const limit = intParam(url, "limit");
        const userId = url.searchParams.get("userId") ?? undefined;
        const scope = url.searchParams.get("scope") ?? undefined;
        const around = intParam(url, "around");
        const segmentParam = url.searchParams.get("segment");
        let segment: { key: string; value: string } | undefined;
        if (segmentParam !== null) {
          const at = segmentParam.indexOf(":");
          if (at < 1) throw new HttpError(400, 'segment must be "key:value"');
          segment = { key: segmentParam.slice(0, at), value: segmentParam.slice(at + 1) };
        }
        return send(
          200,
          await engine.leaderboard(id, {
            ...(limit !== undefined ? { limit } : {}),
            ...(userId ? { userId } : {}),
            ...(scope ? { scope: scope as "all" | "friends" } : {}),
            ...(around !== undefined ? { around } : {}),
            ...(segment ? { segment } : {}),
          }),
        );
      }

      if (resource === "teams" && id && parts.length === 3) {
        if (req.method === "PUT") return send(200, await engine.saveTeam(id, (await readJson(req)) as { name?: unknown }));
        if (req.method === "GET") {
          const leaderboard = url.searchParams.get("leaderboard") ?? undefined;
          return send(200, await engine.team(id, leaderboard ? { leaderboard } : {}));
        }
      }
      if (req.method === "GET" && resource === "teams" && id && sub === "goals" && parts.length === 4) {
        const userId = url.searchParams.get("userId") ?? undefined;
        return send(200, await engine.teamGoals(id, userId ? { userId } : {}));
      }
      if (resource === "teams" && id && sub === "members" && subId && parts.length === 5) {
        if (req.method === "PUT") return send(200, await engine.addTeamMember(id, subId));
        if (req.method === "DELETE") return send(200, await engine.removeTeamMember(id, subId));
      }
      if (req.method === "POST" && resource === "users" && id && sub === "events" && subId && subSub === "reverse" && parts.length === 6) {
        return send(200, await engine.reverseEvent(id, subId));
      }
      if (req.method === "DELETE" && resource === "users" && id && sub === "achievements" && subId && parts.length === 5) {
        return send(200, await engine.revokeAchievement(id, subId));
      }
      if (req.method === "POST" && resource === "users" && id && sub === "prestige" && parts.length === 4) {
        return send(200, await engine.prestige(id));
      }
      if (req.method === "GET" && resource === "users" && id && sub === "achievements" && parts.length === 4) {
        return send(200, await engine.achievements(id, withLocale));
      }
      if (req.method === "GET" && resource === "users" && id && sub === "export" && parts.length === 4) {
        return send(200, await engine.exportUser(id));
      }
      if (req.method === "GET" && resource === "users" && id && sub === "team" && parts.length === 4) {
        return send(200, await engine.userTeam(id));
      }
      if (req.method === "GET" && resource === "streaks" && id && sub === "at-risk" && parts.length === 4) {
        const limit = intParam(url, "limit");
        const hours = url.searchParams.get("endingWithinHours");
        const cursor = url.searchParams.get("cursor") ?? undefined;
        return send(
          200,
          await engine.streaksAtRisk(id, {
            ...(limit !== undefined ? { limit } : {}),
            ...(hours !== null ? { endingWithinHours: Number(hours) } : {}),
            ...(cursor ? { cursor } : {}),
          }),
        );
      }
      if (req.method === "GET" && resource === "leaderboards" && id && sub === "history" && parts.length === 4) {
        const periods = intParam(url, "periods");
        const top = intParam(url, "top");
        return send(200, await engine.leaderboardHistory(id, { ...(periods !== undefined ? { periods } : {}), ...(top !== undefined ? { top } : {}) }));
      }
      if (req.method === "GET" && resource === "leaderboards" && id && sub === "teams" && parts.length === 4) {
        const limit = intParam(url, "limit");
        const teamId = url.searchParams.get("teamId") ?? undefined;
        return send(200, await engine.teamLeaderboard(id, { ...(limit !== undefined ? { limit } : {}), ...(teamId ? { teamId } : {}) }));
      }

      if (req.method === "GET" && resource === "seasons" && parts.length === 2) {
        const userId = url.searchParams.get("userId") ?? undefined;
        return send(200, await engine.seasons(userId ? { userId } : {}));
      }
      if (req.method === "GET" && resource === "seasons" && id && sub === "standings" && parts.length === 4) {
        const limit = intParam(url, "limit");
        const userId = url.searchParams.get("userId") ?? undefined;
        return send(200, await engine.seasonStandings(id, { ...(limit !== undefined ? { limit } : {}), ...(userId ? { userId } : {}) }));
      }

      if (req.method === "GET" && resource === "community-goals" && parts.length === 2) {
        const userId = url.searchParams.get("userId") ?? undefined;
        return send(200, await engine.communityGoals(userId ? { userId } : {}));
      }

      if (req.method === "GET" && resource === "leagues" && id && sub === "users" && subId && parts.length === 5) {
        return send(200, await engine.league(id, subId));
      }

      throw new HttpError(404, "not found");
    } catch (err) {
      if (err instanceof EngineError && err.code) return send(err.status, { error: err.message, code: err.code, requestId });
      if (err instanceof HttpError || err instanceof EngineError) return send(err.status, { error: err.message, requestId });
      logger.error("unhandled error", { requestId, method: req.method, path: url.pathname, err });
      return send(500, { error: "internal error", requestId });
    }
  };
}

/** Request handler for the onstreak HTTP API. Mount it on any node:http server. */
export function createHandler(engine: Engine, options: ServerOptions) {
  return buildHandler(engine, options, { shuttingDown: false });
}

export interface OnstreakServer extends Server {
  /** The registry behind GET /metrics, for counting things outside requests (e.g. webhook deliveries). */
  metrics: Metrics;
  /**
   * Stop accepting connections, let in-flight requests finish, then close the
   * engine's database connections. Connections still busy after `timeoutMs`
   * (default 10 s) are cut. Resolves with whether any had to be cut.
   */
  shutdown(options?: { timeoutMs?: number }): Promise<{ forced: boolean }>;
}

export function createOnstreakServer(engine: Engine, options: ServerOptions): OnstreakServer {
  const state: ServerState = { shuttingDown: false };
  const registry = options.metrics ?? new Metrics();
  const handler = buildHandler(engine, { ...options, metrics: registry }, state);
  const server = createServer((req, res) => void handler(req, res)) as OnstreakServer;
  server.metrics = registry;
  let closing: Promise<{ forced: boolean }> | null = null;

  server.shutdown = ({ timeoutMs = 10_000 } = {}) => {
    if (closing) return closing;
    state.shuttingDown = true;
    closing = (async () => {
      let forced = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          forced = true;
          server.closeAllConnections();
        }, timeoutMs);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        // Keep-alive connections with no request in flight can go now.
        server.closeIdleConnections();
      });
      await engine.close();
      return { forced };
    })();
    return closing;
  };

  return server;
}
