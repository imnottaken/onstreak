import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { resolveConfig, type OnstreakConfig, type ResolvedConfig } from "./config.js";
import { MemoryStore } from "./store/memory.js";
import { fromPgPool, PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

export const HELP = `onstreak: open-source gamification engine

Usage
  onstreak [serve]        start the HTTP server (default)
  onstreak check          validate the config, and the database if DATABASE_URL is set
  onstreak migrate        bring the database schema up to date, then exit
  onstreak --version
  onstreak --help

Settings (environment variables)
  ONSTREAK_CONFIG               config file (default ./onstreak.config.json)
  ONSTREAK_API_KEY              secret clients send as "Authorization: Bearer <key>" (serve)
  DATABASE_URL                  Postgres connection string (in-memory store if unset)
  ONSTREAK_DB_SCHEMA            Postgres schema for onstreak's tables (created if missing)
  ONSTREAK_TABLE_PREFIX         prefix for table names (default onstreak_)
  ONSTREAK_AUTO_MIGRATE         "false" to refuse to start with pending migrations (default true)
  PORT                          HTTP port (default 8787)
  ONSTREAK_LOG_LEVEL            debug | info | warn | error (default info)
  ONSTREAK_LOG_FORMAT           json | pretty (default json)
  ONSTREAK_SHUTDOWN_TIMEOUT_MS  how long to let requests finish on shutdown (default 10000)
`;

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class CliError extends Error {}

export function version(): string {
  const url = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

/** Read and validate the config file. Throws CliError with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv): { path: string; config: OnstreakConfig; resolved: ResolvedConfig } {
  const file = path.resolve(env.ONSTREAK_CONFIG || "onstreak.config.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new CliError(`config file not found: ${file} (set ONSTREAK_CONFIG)`);
  }
  let config: OnstreakConfig;
  try {
    config = JSON.parse(raw) as OnstreakConfig;
  } catch (err) {
    throw new CliError(`config file is not valid JSON: ${file}: ${(err as Error).message}`);
  }
  try {
    return { path: file, config, resolved: resolveConfig(config) };
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

export interface OpenedStore {
  store: Store;
  kind: "postgres" | "memory";
  /** Create the configured schema if it does not exist yet (no-op otherwise). */
  ensureSchema(): Promise<void>;
  /** The Postgres store, for migration status. Null for memory. */
  postgres: PostgresStore | null;
}

/** Build the store described by the environment. */
export function openStore(env: NodeJS.ProcessEnv): OpenedStore {
  if (!env.DATABASE_URL) {
    const store = new MemoryStore();
    return { store, kind: "memory", ensureSchema: async () => {}, postgres: null };
  }
  const schema = env.ONSTREAK_DB_SCHEMA || null;
  if (schema && !SCHEMA_NAME.test(schema)) throw new CliError(`ONSTREAK_DB_SCHEMA "${schema}" must be lowercase letters, digits and _`);
  const prefix = env.ONSTREAK_TABLE_PREFIX;
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
    connectionTimeoutMillis: 5000,
  });
  let store: PostgresStore;
  try {
    store = new PostgresStore(fromPgPool(pool), prefix ? { tablePrefix: prefix } : {});
  } catch (err) {
    void pool.end();
    throw new CliError((err as Error).message.replace("tablePrefix", "ONSTREAK_TABLE_PREFIX"));
  }
  return {
    store,
    kind: "postgres",
    postgres: store,
    ensureSchema: async () => {
      if (schema) await pool.query(`create schema if not exists ${schema}`);
    },
  };
}

async function check(env: NodeJS.ProcessEnv, io: CliIO): Promise<number> {
  const { path: file, resolved: c } = loadConfig(env);
  io.out(`config OK: ${file}`);
  io.out(
    `  ${c.currencies.length} currencies (${c.currencies.join(", ")}), ${c.points.length} point rules, ` +
      `${c.levels ? `${c.levels.thresholds.length + 1} levels` : "no levels"}, ${c.streaks.length} streaks, ` +
      `${c.achievements.length} achievements, ${c.leaderboards.length} leaderboards, ${c.leagues.length} leagues`,
  );
  const opened = openStore(env);
  if (!opened.postgres) {
    io.out("database: none (DATABASE_URL is not set; the server would use the in-memory store)");
    return 0;
  }
  try {
    await opened.store.ping();
  } catch (err) {
    io.err(`database unreachable: ${(err as Error).message}`);
    await opened.store.close().catch(() => {});
    return 1;
  }
  const status = await opened.postgres.migrationStatus();
  await opened.store.close();
  io.out(
    status.pending.length === 0
      ? `database: reachable, schema up to date (version ${status.version})`
      : `database: reachable, schema version ${status.version} of ${status.latest}, ${status.pending.length} migration(s) pending (run: onstreak migrate)`,
  );
  return 0;
}

async function migrate(env: NodeJS.ProcessEnv, io: CliIO): Promise<number> {
  if (!env.DATABASE_URL) throw new CliError("DATABASE_URL is not set: there is no database to migrate");
  const opened = openStore(env);
  try {
    await opened.ensureSchema();
    const report = await opened.store.migrate();
    if (report.applied.length === 0) io.out(`schema already up to date (version ${report.version})`);
    for (const m of report.applied) io.out(`applied ${m.version}: ${m.name}`);
    if (report.applied.length > 0) io.out(`schema now at version ${report.version}`);
    return 0;
  } finally {
    await opened.store.close().catch(() => {});
  }
}

/**
 * Run a one-shot command. Returns the exit code, or "serve" when the caller
 * should start the server.
 */
export async function runCommand(argv: string[], env: NodeJS.ProcessEnv, io: CliIO): Promise<number | "serve"> {
  const [command = "serve", ...rest] = argv;
  if (rest.length > 0) {
    io.err(`unexpected argument: ${rest[0]}\n\n${HELP}`);
    return 2;
  }
  try {
    switch (command) {
      case "serve":
        return "serve";
      case "check":
        return await check(env, io);
      case "migrate":
        return await migrate(env, io);
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return 0;
      case "--version":
      case "-v":
        io.out(version());
        return 0;
      default:
        io.err(`unknown command: ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    io.err(err instanceof CliError ? err.message : `${(err as Error).message}`);
    return 1;
  }
}
