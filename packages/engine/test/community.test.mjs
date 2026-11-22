import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, PostgresStore, fromPgPool, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const DAY = 86_400_000;
const start = Date.parse("2026-11-16T06:00:00Z");
const config = {
  ...base,
  communityGoals: [
    { id: "minutes", name: "100 minutes together", goal: { event: "minutes_studied", target: 100 }, from: "2026-11-16T00:00:00Z", to: "2026-11-23T00:00:00Z", rewards: [{ currency: "coins", amount: 20 }], minContribution: 30 },
    { id: "xp_rush", name: "XP rush", description: "Earn 50 XP between you", goal: { points: "xp", target: 50 }, from: "2026-11-20T00:00:00Z", to: "2026-11-21T00:00:00Z" },
  ],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: everyone's events add up, and contributors share the reward once`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const study = (userId, value, extra = {}) => engine.track({ userId, event: "minutes_studied", value, ...extra });

    let list = await engine.communityGoals();
    assert.deepEqual(list.goals[0], {
      id: "minutes", name: "100 minutes together", goal: { event: "minutes_studied", target: 100 }, progress: 0, target: 100, completed: false,
      status: "active", startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-23T00:00:00.000Z", rewards: [{ currency: "coins", amount: 20 }], minContribution: 30, you: null,
    });
    assert.deepEqual([list.goals[1].status, list.goals[1].description], ["upcoming", "Earn 50 XP between you"]);

    await study("asha", 40);
    await study("ravi", 20);
    await study("maya", 10, { timestamp: Date.parse("2026-11-15T23:00:00Z") }); // before the window
    list = await engine.communityGoals({ userId: "asha" });
    assert.deepEqual([list.goals[0].progress, list.goals[0].completed], [60, false]);
    assert.deepEqual(list.goals[0].you, { contribution: 40, eligible: true, rewarded: false, paidNow: [] }, "nothing until the goal is reached");

    now += DAY;
    await study("maya", 45);
    list = await engine.communityGoals({ userId: "asha" });
    assert.deepEqual([list.goals[0].progress, list.goals[0].completed], [105, true]);
    assert.deepEqual(list.goals[0].you, { contribution: 40, eligible: true, rewarded: true, paidNow: [{ currency: "coins", amount: 20 }] });
    assert.equal((await engine.getUser("asha")).points.coins, 20);
    list = await engine.communityGoals({ userId: "asha" });
    assert.deepEqual(list.goals[0].you.paidNow, [], "paid once");
    assert.equal((await engine.getUser("asha")).points.coins, 20);

    const ravi = (await engine.communityGoals({ userId: "ravi" })).goals[0].you;
    assert.deepEqual(ravi, { contribution: 20, eligible: false, rewarded: false, paidNow: [] }, "below minContribution");
    const zoe = (await engine.communityGoals({ userId: "zoe" })).goals[0].you;
    assert.deepEqual([zoe.contribution, zoe.eligible], [0, false]);

    // Claiming still works after the window ends, and later events do not count.
    now = Date.parse("2026-11-25T00:00:00Z");
    await study("asha", 500);
    list = await engine.communityGoals({ userId: "maya" });
    assert.deepEqual([list.goals[0].status, list.goals[0].progress, list.goals[0].you.paidNow.length], ["ended", 105, 1]);
  });

  test(`${name}: points goals count points earned in the window`, async (t) => {
    let now = Date.parse("2026-11-20T10:00:00Z");
    const engine = new Engine(config, await makeStore(t), () => now);
    for (const u of ["a", "b", "c"]) await engine.track({ userId: u, event: "lesson_completed" }); // 10 xp each
    let goal = (await engine.communityGoals({ userId: "a" })).goals[1];
    assert.deepEqual([goal.status, goal.progress, goal.completed, goal.you.eligible], ["active", 30, false, true]);
    await engine.track({ userId: "b", event: "minutes_studied", value: 10 }); // 20 xp
    goal = (await engine.communityGoals({ userId: "a" })).goals[1];
    assert.deepEqual([goal.completed, goal.you.rewarded, goal.you.paidNow], [true, true, []], "no rewards configured, but marked done");
  });
}

test("community goal config is validated", () => {
  const goal = { id: "g", name: "G", goal: { event: "x", target: 1 }, from: "2026-01-01", to: "2026-02-01" };
  const bad = (g) => assert.throws(() => resolveConfig({ ...base, communityGoals: [{ ...goal, ...g }] }), /Invalid onstreak config/);
  bad({ name: "" });
  bad({ goal: { event: "x", target: 0 } });
  bad({ goal: { event: "x", points: "xp", target: 1 } });
  bad({ goal: { points: "gems", target: 1 } });
  bad({ goal: { event: "bad event", target: 1 } });
  bad({ from: "2026-02-01", to: "2026-01-01" });
  bad({ from: "soon" });
  bad({ rewards: [{ currency: "coins", amount: -1 }] });
  bad({ minContribution: 0 });
  assert.throws(() => resolveConfig({ ...base, communityGoals: [goal, goal] }), /duplicate/);
  assert.equal(resolveConfig({ ...base, communityGoals: [goal] }).communityGoals[0].from, Date.parse("2026-01-01"));
});

test("pg: concurrent looks pay a contributor once", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const engine = new Engine(config, store, () => start);
  await engine.track({ userId: "fast", event: "minutes_studied", value: 120 });
  const looks = await Promise.all(Array.from({ length: 10 }, () => engine.communityGoals({ userId: "fast" })));
  assert.equal(looks.filter((l) => l.goals[0].you.paidNow.length > 0).length, 1);
  assert.equal((await engine.getUser("fast")).points.coins, 20);
});
