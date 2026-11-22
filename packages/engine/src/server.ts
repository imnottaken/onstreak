import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Engine, EngineError } from "./engine.js";
import { silentLogger, type Logger } from "./logger.js";
import { openapiSpec } from "./openapi.js";
import { packageVersion } from "./version.js";

const MAX_BODY = 256 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ServerOptions {
  /** Secret clients send as `Authorization: Bearer <key>`. At least 16 characters. */
  apiKey: string;
  /** Where request and error logs go. Default: nowhere. */
  logger?: Logger;
  /** How long the database check in /health may take. Default 2000 ms. */
  healthTimeoutMs?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function authorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(apiKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
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
  if (!options.apiKey || options.apiKey.length < 16) throw new Error("apiKey must be at least 16 characters");
  const logger = options.logger ?? silentLogger;
  const healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  const spec = openapiSpec(packageVersion());

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = process.hrtime.bigint();
    const incoming = req.headers["x-request-id"];
    const requestId = typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");

    const send = (status: number, body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(json),
        "x-request-id": requestId,
        // Tell keep-alive clients to reconnect elsewhere while we drain.
        ...(state.shuttingDown ? { connection: "close" } : {}),
      });
      res.end(json);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
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

      if (state.shuttingDown) throw new HttpError(503, "server is shutting down");
      if (!authorized(req, options.apiKey)) throw new HttpError(401, "missing or wrong API key");
      if (parts[0] !== "v1") throw new HttpError(404, "not found");
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
        return send(200, await engine.track(body as Parameters<Engine["track"]>[0]));
      }

      if (req.method === "POST" && resource === "events" && id === "batch" && parts.length === 3) {
        const body = (await readJson(req)) as { events?: unknown } | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, 'body must be { "events": [...] }');
        return send(200, { results: await engine.trackBatch(body.events) });
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
  /**
   * Stop accepting connections, let in-flight requests finish, then close the
   * engine's database connections. Connections still busy after `timeoutMs`
   * (default 10 s) are cut. Resolves with whether any had to be cut.
   */
  shutdown(options?: { timeoutMs?: number }): Promise<{ forced: boolean }>;
}

export function createOnstreakServer(engine: Engine, options: ServerOptions): OnstreakServer {
  const state: ServerState = { shuttingDown: false };
  const handler = buildHandler(engine, options, state);
  const server = createServer((req, res) => void handler(req, res)) as OnstreakServer;
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
