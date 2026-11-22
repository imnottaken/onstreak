import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, resolveConfig, levelFor } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");

test("level curves generate thresholds", () => {
  const linear = resolveConfig({ ...base, levels: { currency: "xp", curve: { type: "linear", step: 100, maxLevel: 5 } } }).levels;
  assert.deepEqual(linear.thresholds, [100, 200, 300, 400]);
  const exp = resolveConfig({ ...base, levels: { currency: "xp", curve: { type: "exponential", base: 100, factor: 1.5, maxLevel: 5 } } }).levels;
  assert.deepEqual(exp.thresholds, [100, 250, 475, 813], "steps of 100, 150, 225, 337.5");
  assert.deepEqual([levelFor(exp, 0), levelFor(exp, 250), levelFor(exp, 5000)], [1, 3, 5]);
  assert.equal(resolveConfig({ ...base, levels: { currency: "xp", curve: { type: "linear", step: 10 } } }).levels.thresholds.length, 99, "100 levels by default");
  const huge = resolveConfig({ ...base, levels: { currency: "xp", curve: { type: "exponential", base: 1e6, factor: 10, maxLevel: 1000 } } }).levels;
  assert.ok(huge.thresholds.every(Number.isSafeInteger), "stops before numbers get unsafe");
});

test("level config is validated", () => {
  const bad = (levels, re) => assert.throws(() => resolveConfig({ ...base, levels: { currency: "xp", ...levels } }), re);
  bad({}, /thresholds or a curve/);
  bad({ thresholds: [10], curve: { type: "linear", step: 1 } }, /not both/);
  bad({ curve: { type: "cubic" } }, /linear" or "exponential/);
  bad({ curve: { type: "linear", step: 0 } }, /step must be positive/);
  bad({ curve: { type: "exponential", base: 10, factor: 1 } }, /factor/);
  bad({ curve: { type: "linear", step: 5, maxLevel: 1 } }, /maxLevel/);
  bad({ thresholds: [10, 20], rewards: [{ level: 4, rewards: [] }] }, /from 2 to 3/);
  bad({ thresholds: [10, 20], rewards: [{ level: 2, rewards: [] }, { level: 2, rewards: [] }] }, /twice/);
  bad({ thresholds: [10, 20], rewards: [{ level: 2, rewards: [{ currency: "gems", amount: 1 }] }] }, /unknown currency/);
});

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: reaching a level pays its rewards, once per level passed`, async (t) => {
    const config = {
      ...base,
      achievements: [],
      levels: {
        currency: "xp",
        curve: { type: "linear", step: 20, maxLevel: 10 },
        rewards: [
          { level: 2, rewards: [{ currency: "coins", amount: 5 }] },
          { level: 3, rewards: [{ currency: "coins", amount: 10 }] },
          { level: 4, rewards: [{ currency: "xp", amount: 25 }] }, // pushes on to level 5
          { level: 6, rewards: [{ currency: "coins", amount: 1 }] },
        ],
      },
    };
    const engine = new Engine(config, await makeStore(t), () => start);
    let r = await engine.track({ userId: "a", event: "lesson_completed" }); // 10 xp
    assert.equal(r.level.rewards, undefined);
    r = await engine.track({ userId: "a", event: "minutes_studied", value: 20 }); // +40 xp: 50, level 3
    assert.deepEqual([r.level.previous, r.level.current, r.level.rewards], [1, 3, [{ currency: "coins", amount: 15 }]], "both levels passed pay");
    assert.equal(r.points.coins.awarded, 15);
    r = await engine.track({ userId: "a", event: "lesson_completed" }); // 60: level 4, +25 xp: 85, level 5
    assert.deepEqual([r.level.previous, r.level.current, r.level.rewards], [3, 5, [{ currency: "xp", amount: 25 }]]);
    r = await engine.track({ userId: "a", event: "lesson_completed" }); // 95: still 5
    assert.equal(r.level.rewards, undefined);
    r = await engine.track({ userId: "a", event: "lesson_completed" }); // 105: level 6
    assert.deepEqual(r.level.rewards, [{ currency: "coins", amount: 1 }]);
    const user = await engine.getUser("a");
    assert.deepEqual([user.level.current, user.level.startsAt, user.level.nextAt], [6, 100, 120]);
  });
}
