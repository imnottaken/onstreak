import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Engine, EngineError } from "./engine.js";

const MAX_BODY = 64 * 1024;

export interface ServerOptions {
  /** Secret clients send as `Authorization: Bearer <key>`. */
  apiKey: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
  res.end(json);
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

/** Request handler for the onstreak HTTP API. Mount it on any node:http server. */
export function createHandler(engine: Engine, options: ServerOptions) {
  if (!options.apiKey || options.apiKey.length < 16) throw new Error("apiKey must be at least 16 characters");

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (!authorized(req, options.apiKey)) throw new HttpError(401, "missing or wrong API key");

      if (parts[0] !== "v1") throw new HttpError(404, "not found");

      if (req.method === "POST" && parts.length === 2 && parts[1] === "events") {
        const body = await readJson(req);
        if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
        return send(res, 200, await engine.track(body as Parameters<Engine["track"]>[0]));
      }

      if (req.method === "GET" && parts.length === 3 && parts[1] === "users") {
        const timezone = url.searchParams.get("timezone") ?? undefined;
        return send(res, 200, await engine.getUser(parts[2] as string, timezone ? { timezone } : {}));
      }

      if (req.method === "GET" && parts.length === 3 && parts[1] === "leaderboards") {
        const limitParam = url.searchParams.get("limit");
        const userId = url.searchParams.get("userId") ?? undefined;
        return send(
          res,
          200,
          await engine.leaderboard(parts[2] as string, {
            ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
            ...(userId ? { userId } : {}),
          }),
        );
      }

      throw new HttpError(404, "not found");
    } catch (err) {
      if (err instanceof HttpError || err instanceof EngineError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: "internal error" });
    }
  };
}

export function createOnstreakServer(engine: Engine, options: ServerOptions): Server {
  const handler = createHandler(engine, options);
  return createServer((req, res) => void handler(req, res));
}
