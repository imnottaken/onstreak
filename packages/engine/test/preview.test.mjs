import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: preview counts level moves and achievement changes without changing anything`, async (t) => {
    const engine = new Engine(base, await makeStore(t), () => start); // thresholds [25, 60, 120]
    const study = (u, minutes) => engine.track({ userId: u, event: "minutes_studied", value: minutes });
    await study("a", 5); // 10 xp, level 1
    await study("b", 15); // 30 xp, level 2
    await study("c", 35); // 70 xp, level 3
    await engine.track({ userId: "d", event: "lesson_completed" }); // 10 xp, first_lesson

    const candidate = {
      ...base,
      levels: { currency: "xp", thresholds: [10, 100] },
      achievements: [
        { id: "first_lesson", name: "First steps", when: { metric: "lesson_completed", gte: 2 } },
        { id: "xp_20", name: "Twenty", when: { points: "xp", gte: 20 } },
        { id: "grind", name: "Grind", when: { metric: "minutes_studied" }, tiers: [{ name: "B", gte: 10 }, { name: "S", gte: 30 }] },
      ],
    };
    const p = await engine.previewConfig(candidate);
    assert.equal(p.users, 4);
    assert.equal(p.truncated, false);
    // a: 1 -> 2, b: 2 -> 2, c: 3 -> 2, d: 1 -> 2
    assert.deepEqual(p.levels, { up: 2, down: 1, same: 1 });
    assert.deepEqual(p.achievements, {
      first_lesson: { wouldUnlock: 0, noLongerQualify: 1 },
      xp_20: { wouldUnlock: 2, noLongerQualify: 0 },
      "grind#1": { wouldUnlock: 2, noLongerQualify: 0 },
      "grind#2": { wouldUnlock: 1, noLongerQualify: 0 },
    });
    assert.equal((await engine.getUser("c")).level.current, 3, "nothing changed");

    const capped = await engine.previewConfig(candidate, { maxUsers: 2 });
    assert.deepEqual([capped.users, capped.truncated], [2, true]);
    const noLevels = await engine.previewConfig({ ...candidate, levels: undefined });
    assert.equal(noLevels.levels, null);
    await assert.rejects(engine.previewConfig({ currencies: [] }), (e) => e instanceof EngineError && e.status === 400 && /currencies/.test(e.message));
  });
}
