import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, PostgresStore, fromPgPool } from "../dist/index.js";
import { config } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const start = Date.parse("2026-11-16T06:00:00Z"); // Monday of week 1

/** The one rival entry of `userId` in the weekly duel. */
const duel = async (engine, userId) => (await engine.rivals("weekly_duel", userId)).rivals[0];

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: a rivalry plays out week by week`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const study = (userId, minutes, ts) => engine.track({ userId, event: "minutes_studied", value: minutes, ...(ts ? { timestamp: ts } : {}) });
    await engine.updateUser("maya", { displayName: "Maya" });

    assert.deepEqual(await engine.addRival("weekly_duel", "asha", "maya"), { rivalryId: "weekly_duel", userId: "asha", rivalId: "maya", created: true });
    assert.equal((await engine.addRival("weekly_duel", "maya", "asha")).created, false, "already rivals, either way round");

    // Week 1: asha 30, maya 20.
    await study("asha", 15);
    await study("maya", 10);
    const w1 = await engine.rivals("weekly_duel", "asha");
    assert.deepEqual(w1.round, { key: "2026-11-16", startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-23T00:00:00.000Z" });
    assert.deepEqual(w1.rivals[0].current, { you: 30, them: 20, leading: "you" });
    assert.equal(w1.rivals[0].displayName, "Maya");
    assert.deepEqual(w1.rivals[0].record, { wins: 0, losses: 0, draws: 0 }, "nothing finished yet");
    assert.equal(w1.rivals[0].streak, null);
    assert.deepEqual((await duel(engine, "maya")).current, { you: 20, them: 30, leading: "them" }, "the other side sees it mirrored");

    // Week 2: asha wins week 1; maya takes week 2 (0 vs 40).
    now += WEEK;
    let a = await duel(engine, "asha");
    assert.deepEqual(a.last, { round: "2026-11-16", you: 30, them: 20, outcome: "won" });
    assert.deepEqual(a.record, { wins: 1, losses: 0, draws: 0 });
    assert.deepEqual(a.streak, { outcome: "won", length: 1 });
    await study("maya", 20);

    // Week 3: nobody plays. Week 4: both 10, a draw.
    now += 2 * WEEK;
    await study("asha", 5);
    await study("maya", 5);

    // Week 5. Before anyone looks, maya backfills a huge score into week 4.
    now += WEEK;
    await study("maya", 500, start + 3 * WEEK + DAY);
    a = await duel(engine, "asha");
    assert.deepEqual(a.record, { wins: 1, losses: 1, draws: 1 }, "week 3 had no contest and counts for nothing");
    assert.deepEqual(a.last, { round: "2026-12-07", you: 10, them: 10, outcome: "draw" }, "points recorded after the round ended do not count");
    assert.deepEqual(a.streak, { outcome: "draw", length: 1 });
    const m = await duel(engine, "maya");
    assert.deepEqual(m.record, { wins: 1, losses: 1, draws: 1 }, "records agree from both sides");
    assert.deepEqual(a.current, { you: 0, them: 0, leading: "tied" }, "the backfill landed in week 4, not this week");

    // Ending it drops the history; starting again counts from the current round.
    assert.equal((await engine.removeRival("weekly_duel", "maya", "asha")).removed, true);
    assert.equal((await engine.removeRival("weekly_duel", "maya", "asha")).removed, false);
    assert.deepEqual((await engine.rivals("weekly_duel", "asha")).rivals, []);
    await engine.addRival("weekly_duel", "asha", "maya");
    assert.deepEqual((await duel(engine, "asha")).record, { wins: 0, losses: 0, draws: 0 });
  });

  test(`${name}: streaks count consecutive results and skip rounds nobody played`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    await engine.addRival("weekly_duel", "a", "b");
    const week = async (aMinutes, bMinutes) => {
      if (aMinutes) await engine.track({ userId: "a", event: "minutes_studied", value: aMinutes });
      if (bMinutes) await engine.track({ userId: "b", event: "minutes_studied", value: bMinutes });
      now += WEEK;
    };
    await week(10, 5); // a wins
    await week(0, 0); // no contest
    await week(10, 5); // a wins
    await week(10, 5); // a wins
    const a = await duel(engine, "a");
    assert.deepEqual(a.streak, { outcome: "won", length: 3 }, "the empty week does not break it");
    assert.deepEqual(a.record, { wins: 3, losses: 0, draws: 0 });
    assert.deepEqual((await duel(engine, "b")).streak, { outcome: "lost", length: 3 });
  });

  test(`${name}: rival limits, validation and unknown rivalries`, async (t) => {
    const engine = new Engine({ ...config, rivalries: [{ id: "weekly_duel", currency: "xp", max: 1 }] }, await makeStore(t));
    await engine.addRival("weekly_duel", "a", "b");
    await assert.rejects(engine.addRival("weekly_duel", "a", "c"), (e) => e.status === 409 && /maximum of 1 rivals/.test(e.message));
    await assert.rejects(engine.addRival("weekly_duel", "c", "a"), (e) => e.status === 409);
    await assert.rejects(engine.addRival("weekly_duel", "a", "a"), /own rival/);
    await assert.rejects(engine.addRival("nope", "a", "b"), (e) => e.status === 404);
    await assert.rejects(engine.rivals("nope", "a"), (e) => e.status === 404);
    await assert.rejects(engine.rivals("weekly_duel", "has space"), /userId/);
  });
}

test("daily rivalries settle every day", async () => {
  let now = start;
  const engine = new Engine({ ...config, rivalries: [{ id: "daily", currency: "xp", period: "daily", timezone: "Asia/Kolkata" }] }, new MemoryStore(), () => now);
  await engine.addRival("daily", "a", "b");
  await engine.track({ userId: "b", event: "lesson_completed" });
  now += DAY;
  const status = await engine.rivals("daily", "a");
  assert.equal(status.round.key, "2026-11-17");
  assert.equal(status.round.startsAt, "2026-11-16T18:30:00.000Z", "rounds start at midnight in the rivalry's zone");
  assert.deepEqual(status.rivals[0].last, { round: "2026-11-16", you: 0, them: 10, outcome: "lost" });
});

test("rivalry config is validated", () => {
  assert.throws(() => new Engine({ ...config, rivalries: [{ id: "r", currency: "gold" }] }, new MemoryStore()), /unknown currency/);
  assert.throws(() => new Engine({ ...config, rivalries: [{ id: "r", currency: "xp", max: 0 }] }, new MemoryStore()), /max/);
  assert.throws(() => new Engine({ ...config, rivalries: [{ id: "r", currency: "xp", period: "monthly" }] }, new MemoryStore()), /daily or weekly/);
});

test("pg: both sides looking at once settle each round exactly once", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  let now = start;
  const engine = new Engine(config, store, () => now);
  await engine.addRival("weekly_duel", "a", "b");
  for (let w = 0; w < 6; w++) {
    await engine.track({ userId: w % 2 ? "a" : "b", event: "lesson_completed" });
    now += WEEK;
  }
  const views = await Promise.all(Array.from({ length: 20 }, (_, i) => engine.rivals("weekly_duel", i % 2 ? "a" : "b")));
  const { rows } = await pool.query("select count(*)::int as n from onstreak_rivalry_rounds");
  assert.equal(rows[0].n, 6, "one row per finished round, no duplicates");
  const aViews = views.filter((v) => v.userId === "a").map((v) => JSON.stringify(v.rivals[0].record));
  assert.equal(new Set(aViews).size, 1, "every concurrent view agrees");
  assert.deepEqual(views.find((v) => v.userId === "a").rivals[0].record, { wins: 3, losses: 3, draws: 0 });
});
