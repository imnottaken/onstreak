import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const DAY = 86_400_000;
const start = Date.parse("2026-11-16T06:00:00Z"); // Monday, 11:30 in Kolkata

const config = {
  ...base,
  multipliers: [
    { id: "double_xp_weekend", currency: "xp", factor: 2, from: "2026-11-21T00:00:00Z", to: "2026-11-23T00:00:00Z" },
    { id: "streak_bonus", streak: "daily_lesson", steps: [{ gte: 7, factor: 2 }, { gte: 3, factor: 1.5 }] },
  ],
  quests: [{ id: "one", name: "One lesson", period: "daily", goal: { event: "lesson_completed", target: 1 }, rewards: [{ currency: "xp", amount: 5 }] }],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: streak steps raise points as the streak grows, and stop once it breaks`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const lesson = () => engine.track({ userId: "asha", event: "lesson_completed" });

    let r = await lesson();
    assert.deepEqual(r.multipliers, {}, "day 1: no bonus yet");
    assert.deepEqual(r.points.xp, { awarded: 15, total: 15 }, "10 xp plus the 5 xp quest reward, which is never multiplied");
    now += DAY;
    await lesson();
    now += DAY;
    r = await lesson();
    assert.deepEqual(r.multipliers, { streak_bonus: { factor: 1.5, currency: null } }, "day 3 counts, including this lesson");
    assert.deepEqual(r.points.xp.awarded, 15 + 5, "10 x 1.5 plus the reward");
    assert.equal(r.points.coins.awarded, 1.5, "no currency set: applies to every currency");

    // Studying (which does not touch the streak) still gets the bonus while the streak is alive.
    r = await engine.track({ userId: "asha", event: "minutes_studied", value: 10 });
    assert.equal(r.points.xp.awarded, 30, "20 x 1.5");

    // Skip enough days to break it (one freeze covers one missed day).
    now += 5 * DAY; // Monday again, past the double XP weekend
    r = await engine.track({ userId: "asha", event: "minutes_studied", value: 10 });
    assert.deepEqual(r.multipliers, {}, "a lapsed streak gives no bonus");
    assert.equal(r.points.xp.awarded, 20);
  });

  test(`${name}: window multipliers apply to events inside the window and stack with streaks`, async (t) => {
    let now = Date.parse("2026-11-20T12:00:00Z"); // Friday
    const engine = new Engine({ ...config, quests: [] }, await makeStore(t), () => now);
    let r = await engine.track({ userId: "ravi", event: "lesson_completed" });
    assert.deepEqual(r.multipliers, {}, "before the weekend");
    now = Date.parse("2026-11-21T12:00:00Z");
    r = await engine.track({ userId: "ravi", event: "lesson_completed" });
    assert.deepEqual(r.multipliers, { double_xp_weekend: { factor: 2, currency: "xp" } });
    assert.equal(r.points.xp.awarded, 20);
    assert.equal(r.points.coins.awarded, 1, "only xp is doubled");
    now = Date.parse("2026-11-22T12:00:00Z");
    r = await engine.track({ userId: "ravi", event: "lesson_completed" });
    assert.deepEqual(Object.keys(r.multipliers).sort(), ["double_xp_weekend", "streak_bonus"]);
    assert.equal(r.points.xp.awarded, 30, "10 x 2 x 1.5");
    r = await engine.track({ userId: "ravi", event: "lesson_completed", timestamp: "2026-11-23T00:00:00Z" });
    assert.equal(r.multipliers.double_xp_weekend, undefined, "the window ends at `to`");
    const board = await engine.leaderboard("xp_all", { userId: "ravi" });
    assert.equal(board.user.score, 10 + 20 + 30 + 15, "boosted points count everywhere");
  });
}

test("fractional factors do not leave floating point noise", async () => {
  const engine = new Engine({ ...base, multipliers: [{ id: "tiny", factor: 1.1, from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" }] }, new MemoryStore(), () => start);
  const r = await engine.track({ userId: "a", event: "lesson_completed" });
  assert.equal(r.points.xp.awarded, 11);
});

test("multiplier config is validated", () => {
  const bad = (m, pattern) => assert.throws(() => new Engine({ ...base, multipliers: [{ id: "m", ...m }] }, new MemoryStore()), pattern);
  bad({ factor: 0, from: "2026-01-01", to: "2026-02-01" }, /factor/);
  bad({ factor: 2, from: "2026-02-01", to: "2026-01-01" }, /from before to/);
  bad({ factor: 2, from: "soon", to: "2026-01-01" }, /ISO dates/);
  bad({ factor: 2, currency: "gold", from: "2026-01-01", to: "2026-02-01" }, /unknown currency/);
  bad({ streak: "nope", steps: [{ gte: 1, factor: 2 }] }, /unknown streak/);
  bad({ streak: "daily_lesson", steps: [] }, /steps/);
  bad({ streak: "daily_lesson", steps: [{ gte: -1, factor: 2 }] }, /steps need/);
});
