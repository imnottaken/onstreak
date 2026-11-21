import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Engine, PostgresStore, fromPgPool } from "../dist/index.js";
import { config } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, urlFor } from "./helpers.mjs";

// These need a real server with several connections: PGlite has only one, so it
// cannot show whether row locks and advisory locks actually keep data correct.
const skip = PG_URL ? false : "set TEST_DATABASE_URL to run against real Postgres";
const start = Date.parse("2026-11-16T06:00:00Z");

async function engineOn(t, cfg = config, poolSize = 20) {
  const schema = await freshSchema(t);
  const pool = poolFor(schema, t, poolSize);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  return { engine: new Engine(cfg, store, () => start), pool, schema };
}

test("postgres: 50 parallel events for one user are each counted exactly once", { skip }, async (t) => {
  const { engine, pool } = await engineOn(t);
  const results = await Promise.all(Array.from({ length: 50 }, () => engine.track({ userId: "zoe", event: "lesson_completed" })));

  const profile = await engine.getUser("zoe");
  assert.equal(profile.points.xp, 500);
  assert.equal(profile.points.coins, 50);
  assert.equal(profile.metrics.lesson_completed, 50);
  assert.equal(profile.streaks.daily_lesson.current, 1, "all on one day");
  assert.deepEqual(profile.achievements.map((a) => a.id), ["first_lesson"], "unlocked once");

  const extended = results.filter((r) => r.streaks.daily_lesson.extended).length;
  assert.equal(extended, 1, "exactly one event grew the streak");
  const joined = results.filter((r) => r.leagues.study_league?.joined).length;
  assert.equal(joined, 1, "seated in the league once");

  const { rows } = await pool.query("select count(*)::int as n from onstreak_ledger where user_id = 'zoe'");
  assert.equal(rows[0].n, 100, "50 events x 2 currencies, no lost or doubled rows");
});

test("postgres: the same idempotency key sent 10 times at once counts once", { skip }, async (t) => {
  const { engine } = await engineOn(t);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => engine.track({ userId: "ravi", event: "lesson_completed", idempotencyKey: "req-1" })),
  );
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(new Set(results.map((r) => r.eventId)).size, 1, "every reply points at the first event");
  assert.equal((await engine.getUser("ravi")).points.xp, 10);
});

test("postgres: 40 users joining a league at once never overfill a group", { skip }, async (t) => {
  const cfg = {
    currencies: ["xp"],
    points: [{ event: "win", currency: "xp", amount: 1 }],
    leagues: [{ id: "arena", currency: "xp", tiers: ["bronze", "silver"], groupSize: 3, promote: 1, demote: 1 }],
  };
  const { engine, pool } = await engineOn(t, cfg);
  await Promise.all(Array.from({ length: 40 }, (_, i) => engine.track({ userId: `u${i}`, event: "win" })));

  const { rows } = await pool.query(
    "select group_no, count(*)::int as n from onstreak_league_members where tier = 'bronze' group by group_no order by group_no",
  );
  assert.ok(rows.every((r) => r.n <= 3), `a group went over 3: ${JSON.stringify(rows)}`);
  assert.equal(rows.reduce((sum, r) => sum + r.n, 0), 40, "everyone seated exactly once");
  assert.deepEqual(rows.map((r) => r.group_no), Array.from({ length: rows.length }, (_, i) => i + 1), "group numbers are contiguous");
  assert.equal(rows.length, 14, "ceil(40 / 3) groups");
});

test("postgres: leaderboard and group queries return real numbers, not strings", { skip }, async (t) => {
  const { engine } = await engineOn(t);
  await engine.track({ userId: "a", event: "minutes_studied", value: 10 });
  await engine.track({ userId: "b", event: "minutes_studied", value: 30 });
  const board = await engine.leaderboard("xp_all", { limit: 5, userId: "a" });
  assert.deepEqual(board.entries, [
    { rank: 1, userId: "b", score: 60 },
    { rank: 2, userId: "a", score: 20 },
  ]);
  assert.equal(typeof board.entries[0].rank, "number");
  assert.equal(typeof board.entries[0].score, "number");
  const lg = await engine.league("study_league", "a");
  assert.equal(typeof lg.you.score, "number");
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startServer(t, env) {
  const child = spawn(process.execPath, [new URL("../dist/main.js", import.meta.url).pathname], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  t.after(() => child.kill());
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      if (output.includes("listening")) resolve(child);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (c) => (output += c));
    child.once("exit", (code) => reject(new Error(`server exited early (${code}): ${output}`)));
    setTimeout(() => reject(new Error(`server did not start in time: ${output}`)), 15_000).unref();
  });
}

test("postgres: the real server process stores data and keeps it across a restart", { skip }, async (t) => {
  const schema = await freshSchema(t);
  const dir = mkdtempSync(path.join(tmpdir(), "onstreak-"));
  const configPath = path.join(dir, "onstreak.config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const port = await freePort();
  const apiKey = "integration-key-0123456789";
  const env = { DATABASE_URL: urlFor(schema), ONSTREAK_API_KEY: apiKey, ONSTREAK_CONFIG: configPath, PORT: String(port) };
  const call = (method, route, body) =>
    fetch(`http://localhost:${port}${route}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then((r) => r.json());

  const first = await startServer(t, env);
  const tracked = await call("POST", "/v1/events", { userId: "maya", event: "lesson_completed" });
  assert.equal(tracked.points.xp.total, 10);
  first.kill();
  await new Promise((resolve) => first.once("exit", resolve));

  await startServer(t, env);
  const profile = await call("GET", "/v1/users/maya");
  assert.equal(profile.points.xp, 10, "points survived the restart");
  assert.equal(profile.streaks.daily_lesson.current, 1);
  const again = await call("POST", "/v1/events", { userId: "maya", event: "lesson_completed" });
  assert.equal(again.points.xp.total, 20);
});
