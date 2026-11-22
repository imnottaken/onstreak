import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");
const config = {
  ...base,
  achievements: [
    {
      id: "bookworm",
      name: "Bookworm",
      description: "Finish lessons",
      when: { metric: "lesson_completed" },
      tiers: [
        { name: "Bronze", gte: 2, rewards: [{ currency: "coins", amount: 5 }] },
        { name: "Silver", gte: 4 },
        { name: "Gold", gte: 6, rewards: [{ currency: "xp", amount: 100 }] },
      ],
    },
    { id: "night_owl", name: "Night owl", description: "A secret", when: { metric: "late_lesson", gte: 1 }, hidden: true, rewards: [{ currency: "coins", amount: 3 }] },
    { id: "streak_3", name: "On fire", when: { streak: "daily_lesson", gte: 3 } },
    { id: "rich", name: "Rich", when: { points: "coins", gte: 10 } },
  ],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: tiered badges unlock tier by tier and pay their rewards`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    const lesson = () => engine.track({ userId: "asha", event: "lesson_completed" });

    let list = await engine.achievements("asha");
    const book = list.achievements[0];
    assert.deepEqual(book, {
      id: "bookworm", name: "Bookworm", description: "Finish lessons", hidden: false, unlocked: false, completed: false, unlockedAt: null,
      progress: { current: 0, target: 2, percent: 0 },
      tiers: [
        { level: 1, name: "Bronze", gte: 2, unlockedAt: null },
        { level: 2, name: "Silver", gte: 4, unlockedAt: null },
        { level: 3, name: "Gold", gte: 6, unlockedAt: null },
      ],
    });
    assert.deepEqual(list.achievements[1], { id: "night_owl", name: null, hidden: true, unlocked: false, completed: false, unlockedAt: null, progress: null }, "a secret stays secret");

    await lesson();
    let r = await lesson();
    assert.deepEqual(r.achievements, [{ id: "bookworm", name: "Bookworm", description: "Finish lessons", tier: { level: 1, name: "Bronze" }, rewards: [{ currency: "coins", amount: 5 }] }]);
    assert.deepEqual(r.points.coins, { awarded: 1 + 5, total: 2 + 5 }, "the reward lands in this event's points");
    list = await engine.achievements("asha");
    assert.deepEqual([list.achievements[0].unlocked, list.achievements[0].completed, list.achievements[0].progress], [true, false, { current: 2, target: 4, percent: 50 }]);

    await lesson();
    r = await lesson();
    assert.deepEqual(r.achievements.map((a) => [a.id, a.tier?.name]), [["bookworm", "Silver"]]);
    r = await lesson();
    assert.deepEqual(r.achievements.map((a) => a.id), ["rich"], "5 coins from lessons plus 5 from bronze");
    r = await lesson();
    assert.deepEqual(r.achievements.map((a) => a.tier?.name), ["Gold"]);
    list = await engine.achievements("asha");
    assert.deepEqual([list.achievements[0].completed, list.achievements[0].progress], [true, { current: 6, target: 6, percent: 100 }]);

    const user = await engine.getUser("asha");
    assert.deepEqual(user.achievements.filter((a) => a.id === "bookworm").map((a) => a.tier.name), ["Bronze", "Silver", "Gold"]);
  });

  test(`${name}: hidden achievements reveal themselves on unlock, and progress follows streaks`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const r = await engine.track({ userId: "m", event: "late_lesson" });
    assert.deepEqual(r.achievements, [{ id: "night_owl", name: "Night owl", description: "A secret", rewards: [{ currency: "coins", amount: 3 }] }]);
    let list = await engine.achievements("m");
    const owl = list.achievements[1];
    assert.deepEqual([owl.name, owl.hidden, owl.unlocked, owl.progress], ["Night owl", true, true, { current: 1, target: 1, percent: 100 }]);
    assert.equal(owl.rewards[0].amount, 3);

    await engine.track({ userId: "m", event: "lesson_completed" });
    now += 86_400_000;
    await engine.track({ userId: "m", event: "lesson_completed" });
    list = await engine.achievements("m");
    assert.deepEqual(list.achievements[2].progress, { current: 2, target: 3, percent: 66 });
    now += 3 * 86_400_000; // the streak broke (one freeze covers a day, not two)
    list = await engine.achievements("m");
    assert.equal(list.achievements[2].progress.current, 0);
  });
}

test("tiered and hidden achievements are validated", () => {
  const bad = (a, re) => assert.throws(() => resolveConfig({ ...base, achievements: [{ id: "a", name: "A", when: { metric: "x" }, ...a }] }), re);
  bad({}, /needs when/);
  bad({ when: { metric: "x", gte: 1 }, tiers: [{ name: "B", gte: 1 }, { name: "S", gte: 2 }] }, /gte on each tier/);
  bad({ tiers: [{ name: "B", gte: 1 }] }, /2 to 10/);
  bad({ tiers: [{ name: "B", gte: 2 }, { name: "S", gte: 2 }] }, /ascending/);
  bad({ tiers: [{ name: "", gte: 1 }, { name: "S", gte: 2 }] }, /need a name/);
  bad({ tiers: [{ name: "B", gte: 1 }, { name: "S", gte: 2 }], rewards: [{ currency: "coins", amount: 1 }] }, /rewards on each tier/);
  bad({ when: { metric: "x", gte: 1 }, hidden: "yes" }, /hidden/);
  bad({ when: { metric: "x", gte: 1 }, rewards: [{ currency: "gems", amount: 1 }] }, /unknown currency/);
  assert.doesNotThrow(() => resolveConfig({ ...base, achievements: [{ id: "a", name: "A", when: { metric: "x" }, tiers: [{ name: "B", gte: 1 }, { name: "S", gte: 2, rewards: [{ currency: "xp", amount: 1 }] }] }] }));
});

test("achievements a config no longer has are left out", async () => {
  const store = new MemoryStore();
  await new Engine(config, store, () => start).track({ userId: "x", event: "late_lesson" });
  const user = await new Engine({ ...config, achievements: [] }, store, () => start).getUser("x");
  assert.deepEqual(user.achievements, []);
});
