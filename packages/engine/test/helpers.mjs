import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { MemoryStore, PostgresStore, fromPglite, fromPgPool } from "../dist/index.js";

/**
 * Set TEST_DATABASE_URL to run the suites against a real Postgres server too,
 * e.g. postgres://postgres:postgres@localhost:5432/postgres. Each test gets
 * its own schema, so nothing it creates outlives it.
 */
export const PG_URL = process.env.TEST_DATABASE_URL ?? null;

if (process.env.REQUIRE_POSTGRES === "1" && !PG_URL) {
  // CI sets REQUIRE_POSTGRES so a missing database fails loudly instead of skipping.
  throw new Error("REQUIRE_POSTGRES=1 but TEST_DATABASE_URL is not set");
}

/** Create an isolated schema, dropped when the test ends. */
export async function freshSchema(t) {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`create schema ${schema}`);
  t.after(async () => {
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  return schema;
}

/** A connection pool whose tables live in `schema`. Several connections, so locks are real. */
export function poolFor(schema, t, max = 10) {
  const pool = new pg.Pool({ connectionString: PG_URL, max, options: `-c search_path=${schema}` });
  t.after(() => pool.end());
  return pool;
}

/** The same URL, but every connection uses `schema` (for the server process). */
export function urlFor(schema) {
  return `${PG_URL}${PG_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function migrateTwice(store) {
  await store.migrate();
  await store.migrate(); // migrations are idempotent
  return store;
}

/** Store factories every behaviour suite runs against. Each takes the test context. */
export const storeFactories = {
  memory: async () => new MemoryStore(),
  pglite: async () => migrateTwice(new PostgresStore(fromPglite(new PGlite()))),
  ...(PG_URL
    ? {
        pg: async (t) => {
          const schema = await freshSchema(t);
          return migrateTwice(new PostgresStore(fromPgPool(poolFor(schema, t))));
        },
      }
    : {}),
};
