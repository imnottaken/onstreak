import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");
const config = {
  ...base,
  points: [
    { event: "lesson_completed", currency: "xp", amount: 10 },
    { event: "lesson_completed", currency: "xp", amount: 15, where: { difficulty: "hard" } },
    { event: "quiz_done", currency: "xp", amount: 0.5, multiplyBy: "score", where: { score: { gte: 50 } } },
    { event: "quiz_done", currency: "coins", amount: 2, where: { subject: { in: ["math", "physics"] }, passed: true } },
  ],
  streaks: [{ id: "hard_days", event: "lesson_completed", period: "daily", where: { difficulty: "hard" } }],
  achievements: [],
  items: [],
  quests: [{ id: "hard_three", name: "Three hard ones", period: "daily", goal: { event: "lesson_completed", target: 3, where: { difficulty: "hard" } } }],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: rules filter on event properties and can multiply by one`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    let r = await engine.track({ userId: "a", event: "lesson_completed", properties: { difficulty: "easy" } });
    assert.deepEqual([r.points.xp.awarded, r.streaks.hard_days, r.quests.hard_three], [10, undefined, undefined]);
    r = await engine.track({ userId: "a", event: "lesson_completed", properties: { difficulty: "hard" } });
    assert.deepEqual([r.points.xp.awarded, r.streaks.hard_days.current, r.quests.hard_three.progress], [25, 1, 1]);
    r = await engine.track({ userId: "a", event: "lesson_completed" });
    assert.equal(r.points.xp.awarded, 10, "no properties: only rules without where apply");

    r = await engine.track({ userId: "a", event: "quiz_done", properties: { score: 84, subject: "math", passed: true } });
    assert.deepEqual([r.points.xp.awarded, r.points.coins.awarded], [42, 2]);
    r = await engine.track({ userId: "a", event: "quiz_done", properties: { score: 40, subject: "art", passed: true } });
    assert.deepEqual(r.points, {}, "score below 50 and the wrong subject");
    r = await engine.track({ userId: "a", event: "quiz_done", properties: { score: "84" } });
    assert.deepEqual(r.points, {}, "a range test needs a number");

    const history = await engine.events("a", { limit: 10 });
    assert.ok(history.events.some((e) => e.properties.subject === "math"));
    assert.ok(history.events.some((e) => Object.keys(e.properties).length === 0), "events without properties show {}");
  });

  test(`${name}: properties are validated`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    const bad = (properties) => assert.rejects(engine.track({ userId: "a", event: "x", properties }), (e) => e instanceof EngineError && e.status === 400);
    await bad([]);
    await bad("hard");
    await bad({ "bad key": 1 });
    await bad({ nested: { a: 1 } });
    await bad({ n: Infinity });
    await bad({ s: "x".repeat(201) });
    await bad(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])));
    await bad(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, "y".repeat(150)])));
    const ok = await engine.track({ userId: "a", event: "x", properties: { a: "b", n: 1, f: false } });
    assert.equal(ok.duplicate, false);
  });
}

test("where and multiplyBy are validated", () => {
  const bad = (rule, re) => assert.throws(() => resolveConfig({ ...base, points: [{ event: "x", currency: "xp", amount: 1, ...rule }] }), re);
  bad({ where: [] }, /where must be an object/);
  bad({ where: {} }, /1 to 10/);
  bad({ where: { "bad key": 1 } }, /bad property name/);
  bad({ where: { a: { between: [1, 2] } } }, /value or \{ in, gte, lte \}/);
  bad({ where: { a: { in: [] } } }, /list of strings or numbers/);
  bad({ where: { a: { gte: "5" } } }, /must be a number/);
  bad({ multiplyBy: "bad key" }, /property name/);
  bad({ multiplyBy: "score", multiplyByValue: true }, /not both/);
  assert.throws(() => resolveConfig({ ...base, quests: [{ id: "q", name: "Q", period: "daily", goal: { points: "xp", target: 1, where: { a: 1 } } }] }), /only works on event goals/);
  assert.throws(() => resolveConfig({ ...base, teamGoals: [{ id: "g", name: "G", period: "daily", goal: { event: "x", target: 1, where: { a: 1 } } }] }), /does not support where/);
});
