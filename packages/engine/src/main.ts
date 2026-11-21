#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { Engine } from "./engine.js";
import { createLogger, LOG_LEVELS, type LogLevel } from "./logger.js";
import { createOnstreakServer } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { fromPgPool, PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

async function main(): Promise<void> {
  const level = (process.env.ONSTREAK_LOG_LEVEL ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(level)) {
    console.error(`ONSTREAK_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
    process.exit(1);
  }
  const logger = createLogger({ level, format: process.env.ONSTREAK_LOG_FORMAT === "pretty" ? "pretty" : "json" });

  const apiKey = process.env.ONSTREAK_API_KEY;
  if (!apiKey) {
    logger.error("Set ONSTREAK_API_KEY (at least 16 characters) before starting onstreak.");
    process.exit(1);
  }

  const configPath = path.resolve(process.env.ONSTREAK_CONFIG ?? "onstreak.config.json");
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    logger.error("could not read config", { path: configPath, err });
    process.exit(1);
  }

  let store: Store;
  if (process.env.DATABASE_URL) {
    store = new PostgresStore(fromPgPool(new pg.Pool({ connectionString: process.env.DATABASE_URL })));
  } else {
    logger.warn("DATABASE_URL is not set: using the in-memory store. Data is lost when the server stops.");
    store = new MemoryStore();
  }
  const report = await store.migrate();
  for (const m of report.applied) logger.info("migration applied", { version: m.version, name: m.name });

  const engine = new Engine(config as ConstructorParameters<typeof Engine>[0], store);
  const port = Number(process.env.PORT ?? 8787);
  const server = createOnstreakServer(engine, { apiKey, logger });
  server.listen(port, () => logger.info(`onstreak listening on http://localhost:${port}`, { port }));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) {
      logger.warn("second signal, exiting now", { signal });
      process.exit(1);
    }
    stopping = true;
    const timeoutMs = Number(process.env.ONSTREAK_SHUTDOWN_TIMEOUT_MS ?? 10_000);
    logger.info("shutting down", { signal, timeoutMs });
    const { forced } = await server.shutdown({ timeoutMs });
    logger.info("stopped", { forced });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
