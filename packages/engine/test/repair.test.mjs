import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError, PostgresStore, fromPgPool, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const DAY = 86_400_000;
const start = Date.parse("2026-11-16T06:00:00Z"); // Monday 11:30 in Kolkata, the default zone
const config = {
  ...base,
  streaks: [
    { id: "daily_lesson", event: "lesson_completed", period: "daily", freezes: { start: 1, max: 2 }, repair: { withinHours: 24, cost: { currency: "coins", amount: 5 } } },
    { id: "weekly_study", event: "minutes_studied", period: "weekly", repair: { withinHours: 48 } },
    { id: "plain", event: "lesson_completed", period: "daily" },
  ],
  achievements: [],
};

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (err) => err instanceof EngineError && err.status === status && err.code === code);
}

/** Two lessons a day for three days: a 3-day streak, 6 coins, one freeze left. */
async function threeDays(engine, userId, clock) {
  for (let d = 0; d < 3; d++) {
    clock.now = start + d * DAY;
    await engine.track({ userId, event: "lesson_completed" });
    await engine.track({ userId, event: "lesson_completed" });
  }
}

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: a broken streak can be repaired for coins within the window`, async (t) => {
    const clock = { now: start };
    const engine = new Engine(config, await makeStore(t), () => clock.now);
    await threeDays(engine, "asha", clock); // last lesson on the 18th; the freeze covers the 19th

    clock.now = Date.parse("2026-11-20T06:00:00Z");
    let s = (await engine.getUser("asha")).streaks.daily_lesson;
    assert.deepEqual([s.status, s.repairableUntil], ["pending", undefined], "not broken yet: the freeze still covers it");
    await rejectsWith(engine.repairStreak("asha", "daily_lesson"), 409, "not_broken");

    clock.now = Date.parse("2026-11-21T04:30:00Z"); // 10:00 on the 21st in Kolkata
    s = (await engine.getUser("asha")).streaks.daily_lesson;
    assert.deepEqual([s.status, s.current, s.repairableUntil], ["broken", 0, "2026-11-21T18:30:00.000Z"], "24 hours after the 21st began");

    const r = await engine.repairStreak("asha", "daily_lesson");
    assert.deepEqual(r, { userId: "asha", streak: "daily_lesson", current: 3, status: "pending", cost: { currency: "coins", amount: 5 }, wallet: { xp: 60, coins: 1 } });
    const user = await engine.getUser("asha");
    assert.deepEqual([user.streaks.daily_lesson.status, user.streaks.daily_lesson.freezes, user.points.coins], ["pending", 0, 6], "earned coins stay; the wallet pays");
    const next = await engine.track({ userId: "asha", event: "lesson_completed" });
    assert.deepEqual([next.streaks.daily_lesson.current, next.streaks.daily_lesson.reset], [4, false]);
    await rejectsWith(engine.repairStreak("asha", "daily_lesson"), 409, "not_broken");
  });

  test(`${name}: too late, too poor, or already restarted`, async (t) => {
    const clock = { now: start };
    const engine = new Engine(config, await makeStore(t), () => clock.now);
    await threeDays(engine, "late", clock);
    await threeDays(engine, "poor", clock);
    await engine.purchase("poor", { item: "sticker", quantity: 2 }); // 4 coins left
    await threeDays(engine, "eager", clock);

    clock.now = Date.parse("2026-11-21T19:00:00Z"); // past the deadline
    assert.equal((await engine.getUser("late")).streaks.daily_lesson.repairableUntil, undefined);
    await rejectsWith(engine.repairStreak("late", "daily_lesson"), 409, "repair_expired");

    clock.now = Date.parse("2026-11-21T04:30:00Z");
    await rejectsWith(engine.repairStreak("poor", "daily_lesson"), 409, "insufficient_funds");
    assert.equal((await engine.getUser("poor")).streaks.daily_lesson.status, "broken", "a refused repair changes nothing");

    await engine.track({ userId: "eager", event: "lesson_completed" }); // starts over at 1
    await rejectsWith(engine.repairStreak("eager", "daily_lesson"), 409, "not_broken");

    await rejectsWith(engine.repairStreak("late", "plain"), 400, undefined);
    await rejectsWith(engine.repairStreak("late", "nope"), 404, undefined);
    await rejectsWith(engine.repairStreak("nobody", "daily_lesson"), 409, "not_broken");
  });

  test(`${name}: weekly streaks repair for free`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    await engine.track({ userId: "w", event: "minutes_studied", value: 5 }); // week of the 16th
    now += 7 * DAY;
    await engine.track({ userId: "w", event: "minutes_studied", value: 5 }); // week of the 23rd: 2 weeks
    now = Date.parse("2026-12-07T06:00:00Z"); // missed the week of the 30th
    const r = await engine.repairStreak("w", "weekly_study");
    assert.deepEqual([r.current, r.status, r.cost], [2, "pending", null]);
    const t2 = await engine.track({ userId: "w", event: "minutes_studied", value: 5 });
    assert.equal(t2.streaks.weekly_study.current, 3);
  });
}

test("repair config is validated", () => {
  const bad = (repair) => assert.throws(() => resolveConfig({ ...base, achievements: [], items: [], streaks: [{ id: "s", event: "x", period: "daily", repair }] }), /repair/);
  bad(null);
  bad({});
  bad({ withinHours: 0 });
  bad({ withinHours: 721 });
  bad({ withinHours: 24, cost: { currency: "gems", amount: 1 } });
  bad({ withinHours: 24, cost: { currency: "coins", amount: -1 } });
  assert.doesNotThrow(() => resolveConfig({ ...base, achievements: [], items: [], streaks: [{ id: "s", event: "x", period: "daily", repair: { withinHours: 1.5 } }] }));
});

test("pg: concurrent repairs charge once", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const clock = { now: start };
  const engine = new Engine(config, store, () => clock.now);
  await threeDays(engine, "fast", clock);
  clock.now = Date.parse("2026-11-21T04:30:00Z");
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => engine.repairStreak("fast", "daily_lesson")));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await engine.getUser("fast")).wallet.coins, 1);
});
