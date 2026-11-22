import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, PostgresStore, fromPgPool } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const start = Date.parse("2026-11-16T06:00:00Z"); // Monday, 11:30 in Kolkata (the default zone)

const config = {
  ...base,
  quests: [
    { id: "three_lessons", name: "Three lessons", description: "Finish 3 lessons today", period: "daily", goal: { event: "lesson_completed", target: 3 }, rewards: [{ currency: "coins", amount: 5 }, { currency: "xp", amount: 20 }] },
    { id: "study_hour", name: "Study an hour", period: "weekly", goal: { event: "minutes_studied", target: 60 } },
    { id: "earn_50", name: "Earn 50 XP", period: "daily", goal: { points: "xp", target: 50 }, rewards: [{ currency: "coins", amount: 1 }] },
  ],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: daily quests fill up, pay once, and reset the next day`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const lesson = () => engine.track({ userId: "asha", event: "lesson_completed" });

    let r = await lesson();
    assert.deepEqual(r.quests.three_lessons, { progress: 1, target: 3, completed: false, rewards: [] });
    assert.deepEqual(r.quests.earn_50, { progress: 10, target: 50, completed: false, rewards: [] });
    assert.equal(r.quests.study_hour, undefined, "quests the event does not touch are left out");
    await lesson();
    r = await lesson();
    assert.deepEqual(r.quests.three_lessons, { progress: 3, target: 3, completed: true, rewards: [{ currency: "coins", amount: 5 }, { currency: "xp", amount: 20 }] });
    assert.deepEqual(r.points, { xp: { awarded: 30, total: 50 }, coins: { awarded: 6, total: 8 } }, "rewards land in this event's points");
    assert.deepEqual(r.quests.earn_50, { progress: 30, target: 50, completed: false, rewards: [] }, "another quest's reward does not count toward a points goal");
    assert.ok(r.achievements.length === 0 && r.level.current === 2, "rewards count toward levels");

    r = await lesson();
    assert.equal(r.quests.three_lessons, undefined, "a finished quest stops counting");
    assert.deepEqual(r.points.coins, { awarded: 1, total: 9 }, "and pays nothing more");
    r = await engine.track({ userId: "asha", event: "minutes_studied", value: 5 });
    assert.equal(r.quests.earn_50.completed, true, "points goals finish too");
    assert.deepEqual(r.quests.study_hour, { progress: 5, target: 60, completed: false, rewards: [] }, "event values add up");

    let list = await engine.quests("asha");
    assert.deepEqual(
      list.quests.map((q) => [q.id, q.progress, q.completed]),
      [["three_lessons", 3, true], ["study_hour", 5, false], ["earn_50", 50, true]],
    );
    const daily = list.quests[0];
    assert.equal(daily.description, "Finish 3 lessons today");
    assert.equal(daily.startsAt, "2026-11-15T18:30:00.000Z", "days start at midnight in the user's zone");
    assert.equal(daily.endsAt, "2026-11-16T18:30:00.000Z");
    assert.equal(daily.completedAt, new Date(start).toISOString());
    assert.deepEqual(daily.goal, { event: "lesson_completed", target: 3 });
    assert.equal(list.quests[1].endsAt, "2026-11-22T18:30:00.000Z", "weekly quests run Monday to Monday");

    // Next day: daily quests start over, the weekly one keeps going.
    now += DAY;
    list = await engine.quests("asha");
    assert.deepEqual(list.quests.map((q) => [q.id, q.progress, q.completed]), [["three_lessons", 0, false], ["study_hour", 5, false], ["earn_50", 0, false]]);
    r = await lesson();
    assert.equal(r.quests.three_lessons.progress, 1);
  });

  test(`${name}: only events in the running period count`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const r = await engine.track({ userId: "ravi", event: "lesson_completed", timestamp: start - DAY });
    assert.deepEqual(r.quests, {}, "a backfilled event from yesterday moves no quest");
    assert.deepEqual(r.points.coins, { awarded: 1, total: 1 });
    assert.equal((await engine.quests("ravi")).quests[0].progress, 0);
    assert.equal((await engine.quests("nobody")).quests[0].progress, 0, "unknown users have no progress");
  });

  test(`${name}: quest days follow the user's time zone, or the quest's own`, async (t) => {
    // 20:00 UTC on Monday is already Tuesday in Kolkata but still Monday in New York.
    let now = Date.parse("2026-11-16T20:00:00Z");
    const fixed = { ...config, quests: [...config.quests, { id: "utc_daily", name: "UTC lesson", period: "daily", goal: { event: "lesson_completed", target: 1 } }] };
    fixed.quests[3].timezone = "UTC";
    const engine = new Engine(fixed, await makeStore(t), () => now);
    await engine.track({ userId: "ny", event: "lesson_completed", timezone: "America/New_York" });
    const list = await engine.quests("ny");
    assert.equal(list.quests[0].startsAt, "2026-11-16T05:00:00.000Z", "remembered zone: Monday in New York");
    assert.equal(list.quests[3].startsAt, "2026-11-16T00:00:00.000Z", "the quest's own zone wins");
    assert.equal((await engine.quests("ny", { timezone: "Asia/Kolkata" })).quests[0].progress, 0, "Tuesday in Kolkata has a fresh quest");
    await assert.rejects(engine.quests("ny", { timezone: "Mars/Base" }), /unknown timezone/);
  });

  test(`${name}: duplicate events do not advance quests twice`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    const once = await engine.track({ userId: "z", event: "lesson_completed", idempotencyKey: "k1" });
    const again = await engine.track({ userId: "z", event: "lesson_completed", idempotencyKey: "k1" });
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.quests, once.quests);
    assert.equal((await engine.quests("z")).quests[0].progress, 1);
  });
}

test("quest config is validated", () => {
  const bad = (quest, pattern) => assert.throws(() => new Engine({ ...base, quests: [{ id: "q", name: "Q", period: "daily", goal: { event: "x", target: 1 }, ...quest }] }, new MemoryStore()), pattern);
  bad({ name: "" }, /needs a name/);
  bad({ period: "monthly" }, /daily or weekly/);
  bad({ goal: { event: "x", target: 0 } }, /positive target/);
  bad({ goal: { event: "x", points: "xp", target: 1 } }, /goal/);
  bad({ goal: { points: "gold", target: 1 } }, /unknown currency/);
  bad({ rewards: [{ currency: "xp", amount: -1 }] }, /positive amount/);
  bad({ rewards: [{ currency: "gems", amount: 1 }] }, /unknown currency/);
  bad({ timezone: "Nope/Zone" }, /unknown timezone/);
  assert.throws(() => new Engine({ ...base, quests: [config.quests[0], config.quests[0]] }, new MemoryStore()), /duplicate quest/);
});

test("pg: concurrent events complete a quest and pay its reward exactly once", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const engine = new Engine(config, store, () => start);
  const results = await Promise.all(Array.from({ length: 10 }, () => engine.track({ userId: "fast", event: "lesson_completed" })));
  assert.equal(results.filter((r) => r.quests.three_lessons?.completed).length, 1);
  const user = await engine.getUser("fast");
  assert.equal(user.points.coins, 10 + 5 + 1, "10 lessons, the three-lesson reward, and the 50 XP reward");
});
