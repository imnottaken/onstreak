import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError, MemoryStore, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");
const config = {
  ...base,
  achievements: [],
  levels: { currency: "xp", thresholds: [20, 40], rewards: [{ level: 2, rewards: [{ currency: "coins", amount: 1 }] }], prestige: { rewards: [{ currency: "coins", amount: 100 }] } },
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: prestige starts levels over at the top level`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    const lesson = () => engine.track({ userId: "a", event: "lesson_completed" });
    await lesson();
    await assert.rejects(engine.prestige("a"), (e) => e instanceof EngineError && e.status === 409 && e.code === "not_max_level");
    for (let i = 0; i < 4; i++) await lesson(); // 50 xp: level 3, the top
    assert.equal((await engine.getUser("a")).level.current, 3);

    const p = await engine.prestige("a");
    assert.deepEqual(p, { userId: "a", prestige: 1, level: 1, rewards: [{ currency: "coins", amount: 100 }] });
    let user = await engine.getUser("a");
    assert.deepEqual(user.level, { prestige: 1, current: 1, points: 0, startsAt: 0, nextAt: 20 });
    assert.equal(user.points.xp, 50, "earned points are kept");

    let r = await lesson();
    assert.deepEqual([r.level.previous, r.level.current], [1, 1]);
    r = await lesson(); // 20 since prestige: level 2 again, and its reward pays again
    assert.deepEqual([r.level.current, r.level.rewards], [2, [{ currency: "coins", amount: 1 }]]);
    user = await engine.getUser("a");
    assert.deepEqual([user.level.points, user.level.prestige], [20, 1]);
    await assert.rejects(engine.prestige("a"), (e) => e.code === "not_max_level");
  });
}

test("prestige must be configured", async () => {
  const engine = new Engine({ ...config, levels: { currency: "xp", thresholds: [10] } }, new MemoryStore(), () => start);
  await assert.rejects(engine.prestige("a"), (e) => e.status === 404);
  assert.throws(() => resolveConfig({ ...config, levels: { ...config.levels, prestige: { rewards: [{ currency: "gems", amount: 1 }] } } }), /unknown currency/);
  assert.throws(() => resolveConfig({ ...config, levels: { ...config.levels, prestige: true } }), /levels.prestige/);
  assert.deepEqual(resolveConfig({ ...config, levels: { currency: "xp", thresholds: [10], prestige: {} } }).levels.prestige, { rewards: [] });
});
