import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Engine, PostgresStore, fromPglite, fromPgPool, MIGRATIONS, LATEST_VERSION, tableNames } from "../dist/index.js";
import { config } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor } from "./helpers.mjs";

// Raw database handles, so tests can inspect tables directly.
const databases = {
  pglite: async () => {
    const db = new PGlite();
    return { driver: fromPglite(db), query: (sql, params) => db.query(sql, params) };
  },
  ...(PG_URL
    ? {
        pg: async (t) => {
          const pool = poolFor(await freshSchema(t), t);
          return { driver: fromPgPool(pool), query: (sql, params) => pool.query(sql, params), pool };
        },
      }
    : {}),
};

const versions = async (query, prefix = "onstreak_") =>
  (await query(`select version, name from ${prefix}schema_migrations order by version`)).rows.map((r) => Number(r.version));

for (const [name, open] of Object.entries(databases)) {
  test(`${name}: a fresh database gets every migration, once`, async (t) => {
    const { driver, query } = await open(t);
    const store = new PostgresStore(driver);
    assert.deepEqual((await store.migrationStatus()).pending.length, MIGRATIONS.length, "nothing applied yet");

    const first = await store.migrate();
    assert.deepEqual(first.applied.map((m) => m.version), MIGRATIONS.map((m) => m.version));
    assert.equal(first.version, LATEST_VERSION);
    assert.deepEqual(await versions(query), MIGRATIONS.map((m) => m.version));

    const again = await store.migrate();
    assert.deepEqual(again.applied, [], "second run applies nothing");
    assert.deepEqual(await store.migrationStatus(), { version: LATEST_VERSION, latest: LATEST_VERSION, pending: [] });
  });

  test(`${name}: a database created by onstreak 0.1 upgrades without losing data`, async (t) => {
    const { driver, query } = await open(t);
    // 0.1 created migration 1's tables directly, with no migrations table.
    for (const sql of MIGRATIONS[0].statements(tableNames("onstreak_"))) await query(sql);
    await query("insert into onstreak_users (id) values ('old_user')");
    await query(
      "insert into onstreak_events (id, user_id, key, value, ts) values ('00000000-0000-4000-8000-000000000001', 'old_user', 'lesson_completed', 1, '2026-01-05T10:00:00Z')",
    );
    await query("insert into onstreak_ledger (user_id, currency, amount, ts) values ('old_user', 'xp', 10, '2026-01-05T10:00:00Z')");
    await query("insert into onstreak_balances (user_id, currency, total) values ('old_user', 'xp', 10)");

    const store = new PostgresStore(driver);
    const report = await store.migrate();
    assert.deepEqual(report.applied.map((m) => m.version), MIGRATIONS.map((m) => m.version), "1 is adopted, the rest applied");

    const ledger = (await query("select ts, recorded_at from onstreak_ledger")).rows[0];
    assert.equal(new Date(ledger.recorded_at).toISOString(), new Date(ledger.ts).toISOString(), "old rows count as recorded when they happened");

    const engine = new Engine(config, store);
    const before = await engine.getUser("old_user");
    assert.equal(before.points.xp, 10, "old balances survive");
    assert.deepEqual(before.profile, { displayName: null, avatarUrl: null, metadata: {}, timezone: null });
    const history = await engine.events("old_user");
    assert.equal(history.events.length, 1, "old events are in the history");

    await engine.updateUser("old_user", { displayName: "Old Timer" });
    assert.equal((await engine.getUser("old_user")).profile.displayName, "Old Timer");
  });

  test(`${name}: refuses a database migrated by a newer onstreak`, async (t) => {
    const { driver, query } = await open(t);
    const store = new PostgresStore(driver);
    await store.migrate();
    await query("insert into onstreak_schema_migrations (version, name) values ($1, 'from the future')", [LATEST_VERSION + 1]);
    await assert.rejects(store.migrate(), /newer|only knows up to/);
  });

  test(`${name}: table prefixes keep two apps apart in one database`, async (t) => {
    const { driver, query } = await open(t);
    const a = new PostgresStore(driver, { tablePrefix: "app_a_" });
    const b = new PostgresStore(driver, { tablePrefix: "app_b_" });
    await a.migrate();
    await b.migrate();
    assert.deepEqual(await versions(query, "app_a_"), MIGRATIONS.map((m) => m.version));
    assert.deepEqual(await versions(query, "app_b_"), MIGRATIONS.map((m) => m.version));

    const engineA = new Engine(config, a);
    const engineB = new Engine(config, b);
    await engineA.track({ userId: "same_id", event: "lesson_completed" });
    assert.equal((await engineA.getUser("same_id")).points.xp, 10);
    assert.equal((await engineB.getUser("same_id")).points.xp, 0, "app b never sees app a's data");

    // Only look in this test's own schema: other test files run in parallel and create their own tables.
    const tables = (await query("select tablename from pg_tables where schemaname = current_schema() and tablename like 'onstreak\\_%'")).rows;
    assert.equal(tables.length, 0, "no default-prefixed tables were created");
  });
}

test("table prefix must be a safe identifier", () => {
  const driver = { query: async () => ({ rows: [] }), transaction: async () => {} };
  assert.throws(() => new PostgresStore(driver, { tablePrefix: "bad-prefix" }), /tablePrefix/);
  assert.throws(() => new PostgresStore(driver, { tablePrefix: "x; drop table users;--" }), /tablePrefix/);
  assert.throws(() => new PostgresStore(driver, { tablePrefix: "Upper_" }), /tablePrefix/);
  assert.doesNotThrow(() => new PostgresStore(driver, { tablePrefix: "game_" }));
});

test("migration versions are numbered 1, 2, 3... with no gaps", () => {
  assert.deepEqual(
    MIGRATIONS.map((m) => m.version),
    MIGRATIONS.map((_, i) => i + 1),
  );
  assert.equal(LATEST_VERSION, MIGRATIONS.length);
});

test("pg: two servers migrating at the same time do not collide", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 10);
  const stores = Array.from({ length: 5 }, () => new PostgresStore(fromPgPool(pool)));
  const reports = await Promise.all(stores.map((s) => s.migrate()));
  const appliedCounts = reports.map((r) => r.applied.length).sort();
  assert.deepEqual(appliedCounts, [0, 0, 0, 0, MIGRATIONS.length], "exactly one runner applied the migrations");
  const { rows } = await pool.query("select count(*)::int as n from onstreak_schema_migrations");
  assert.equal(rows[0].n, MIGRATIONS.length);
});
