import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, ConfigError } from "../dist/index.js";
import { config } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";


const DAY = 86_400_000;
const start = Date.parse("2026-11-16T06:00:00Z"); // Monday, 11:30 in India

// Run the same behaviour suite against every store.
for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: points, levels, streaks and achievements`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);

    const first = await engine.track({ userId: "asha", event: "lesson_completed" });
    assert.deepEqual(first.points, { xp: { awarded: 10, total: 10 }, coins: { awarded: 1, total: 1 } });
    assert.equal(first.streaks.daily_lesson.current, 1);
    assert.deepEqual(first.achievements.map((a) => a.id), ["first_lesson"]);
    assert.deepEqual(first.level, { current: 1, previous: 1, leveledUp: false });

    now += DAY;
    const second = await engine.track({ userId: "asha", event: "lesson_completed" });
    assert.equal(second.streaks.daily_lesson.current, 2);
    assert.equal(second.achievements.length, 0, "first_lesson only unlocks once");

    now += 2 * DAY; // skip a day; the starting freeze covers it
    const third = await engine.track({ userId: "asha", event: "lesson_completed" });
    assert.equal(third.streaks.daily_lesson.current, 3);
    assert.equal(third.streaks.daily_lesson.freezesUsed, 1);
    assert.deepEqual(third.achievements.map((a) => a.id), ["streak_3"]);
    assert.equal(third.level.current, 2);
    assert.equal(third.level.leveledUp, true);

    const study = await engine.track({ userId: "asha", event: "minutes_studied", value: 35 });
    assert.deepEqual(study.points.xp, { awarded: 70, total: 100 });
    assert.deepEqual(study.achievements.map((a) => a.id), ["xp_100"]);
    assert.equal(study.level.current, 3);

    const profile = await engine.getUser("asha");
    assert.deepEqual(profile.points, { xp: 100, coins: 3 });
    assert.deepEqual(profile.level, { current: 3, points: 100, startsAt: 60, nextAt: 120, prestige: 0 });
    assert.equal(profile.metrics.minutes_studied, 35);
    assert.equal(profile.streaks.daily_lesson.status, "done");
    assert.deepEqual(profile.achievements.map((a) => a.id), ["first_lesson", "streak_3", "xp_100"]);

    now += 3 * DAY;
    const later = await engine.getUser("asha");
    assert.equal(later.streaks.daily_lesson.status, "broken");
    assert.equal(later.streaks.daily_lesson.current, 0);
  });

  test(`${name}: idempotency keys stop double counting`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    const a = await engine.track({ userId: "ravi", event: "lesson_completed", idempotencyKey: "req-1" });
    const b = await engine.track({ userId: "ravi", event: "lesson_completed", idempotencyKey: "req-1" });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.eventId, a.eventId);
    assert.equal((await engine.getUser("ravi")).points.xp, 10);
  });

  test(`${name}: concurrent events for one user all count`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    await Promise.all(Array.from({ length: 20 }, () => engine.track({ userId: "zoe", event: "lesson_completed" })));
    const profile = await engine.getUser("zoe");
    assert.equal(profile.points.xp, 200);
    assert.equal(profile.metrics.lesson_completed, 20);
  });

  test(`${name}: leaderboards rank by points in the current window`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    // Last week: only counts for the all-time board.
    await engine.track({ userId: "old", event: "minutes_studied", value: 100, timestamp: start - 7 * DAY });
    await engine.track({ userId: "a", event: "minutes_studied", value: 10 }); // 20
    await engine.track({ userId: "b", event: "minutes_studied", value: 30 }); // 60
    await engine.track({ userId: "c", event: "minutes_studied", value: 10 }); // 20, ties with a
    await engine.track({ userId: "d", event: "lesson_completed" }); // 10

    const weekly = await engine.leaderboard("xp_weekly", { limit: 2, userId: "d" });
    assert.deepEqual(
      weekly.entries.map((e) => [e.rank, e.userId, e.score]),
      [
        [1, "b", 60],
        [2, "a", 20],
      ],
    );
    assert.deepEqual(weekly.user, { rank: 4, userId: "d", score: 10, displayName: null, avatarUrl: null });
    assert.equal(weekly.from, "2026-11-16T00:00:00.000Z");

    const full = await engine.leaderboard("xp_weekly", { limit: 10 });
    assert.deepEqual(full.entries.map((e) => e.rank), [1, 2, 2, 4], "ties share a rank");

    const all = await engine.leaderboard("xp_all", { limit: 1 });
    assert.deepEqual(all.entries[0], { rank: 1, userId: "old", score: 200, displayName: null, avatarUrl: null });

    now += 7 * DAY;
    assert.equal((await engine.leaderboard("xp_weekly")).entries.length, 0, "new week starts empty");
  });
}

test("streak days use the user's time zone", async () => {
  const engine = new Engine(config, new MemoryStore());
  // 23:00 and 00:30 India time are two different days, though both are Jan 1 in UTC.
  await engine.track({ userId: "t", event: "lesson_completed", timestamp: "2026-01-01T17:30:00Z" });
  const r = await engine.track({ userId: "t", event: "lesson_completed", timestamp: "2026-01-01T19:00:00Z" });
  assert.equal(r.streaks.daily_lesson.current, 2);
  const utc = await engine.track({ userId: "u", event: "lesson_completed", timestamp: "2026-01-01T17:30:00Z", timezone: "UTC" });
  const utc2 = await engine.track({ userId: "u", event: "lesson_completed", timestamp: "2026-01-01T19:00:00Z", timezone: "UTC" });
  assert.equal(utc.streaks.daily_lesson.current, 1);
  assert.equal(utc2.streaks.daily_lesson.extended, false, "same UTC day");
});

test("bad input is rejected with a clear message", async () => {
  const engine = new Engine(config, new MemoryStore());
  await assert.rejects(engine.track({ userId: "", event: "x" }), /userId/);
  await assert.rejects(engine.track({ userId: "a", event: "has space" }), /event/);
  await assert.rejects(engine.track({ userId: "a", event: "x", value: -1 }), /value/);
  await assert.rejects(engine.track({ userId: "a", event: "x", timezone: "Mars/Base" }), /timezone/);
  await assert.rejects(engine.track({ userId: "a", event: "x", timestamp: "not a date" }), /timestamp/);
  await assert.rejects(engine.leaderboard("nope"), /unknown leaderboard/);
  await assert.rejects(engine.leaderboard("xp_all", { limit: 1000 }), /limit/);
});

test("config mistakes fail fast", () => {
  assert.throws(() => new Engine({ currencies: [] }, new MemoryStore()), ConfigError);
  assert.throws(
    () => new Engine({ currencies: ["xp"], points: [{ event: "e", currency: "gold", amount: 1 }] }, new MemoryStore()),
    /unknown currency "gold"/,
  );
  assert.throws(
    () => new Engine({ currencies: ["xp"], achievements: [{ id: "a", name: "A", when: { streak: "missing", gte: 1 } }] }, new MemoryStore()),
    /unknown streak/,
  );
  assert.throws(() => new Engine({ currencies: ["xp"], levels: { currency: "xp", thresholds: [50, 10] } }, new MemoryStore()), /ascending/);
});

test("level progress has a start and an end for progress bars", async () => {
  const engine = new Engine({ currencies: ["xp"], points: [{ event: "e", currency: "xp", amount: 1, multiplyByValue: true }], levels: { currency: "xp", thresholds: [10, 30] } }, new MemoryStore());
  const level = async () => (await engine.getUser("u")).level;
  assert.deepEqual(await level(), { current: 1, points: 0, startsAt: 0, nextAt: 10, prestige: 0 }, "level 1 starts at 0");
  await engine.track({ userId: "u", event: "e", value: 10 });
  assert.deepEqual(await level(), { current: 2, points: 10, startsAt: 10, nextAt: 30, prestige: 0 }, "exactly on a threshold");
  await engine.track({ userId: "u", event: "e", value: 25 });
  assert.deepEqual(await level(), { current: 3, points: 35, startsAt: 30, nextAt: null, prestige: 0 }, "top level has no next");
});
