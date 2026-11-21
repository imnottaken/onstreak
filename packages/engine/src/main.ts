#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { Engine } from "./engine.js";
import { createOnstreakServer } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { fromPgPool, PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

async function main(): Promise<void> {
  const apiKey = process.env.ONSTREAK_API_KEY;
  if (!apiKey) {
    console.error("Set ONSTREAK_API_KEY (at least 16 characters) before starting onstreak.");
    process.exit(1);
  }

  const configPath = path.resolve(process.env.ONSTREAK_CONFIG ?? "onstreak.config.json");
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`Could not read config at ${configPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  let store: Store;
  if (process.env.DATABASE_URL) {
    store = new PostgresStore(fromPgPool(new pg.Pool({ connectionString: process.env.DATABASE_URL })));
  } else {
    console.warn("DATABASE_URL is not set: using the in-memory store. Data is lost when the server stops.");
    store = new MemoryStore();
  }
  await store.migrate();

  const engine = new Engine(config as ConstructorParameters<typeof Engine>[0], store);
  const port = Number(process.env.PORT ?? 8787);
  createOnstreakServer(engine, { apiKey }).listen(port, () => {
    console.log(`onstreak listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
