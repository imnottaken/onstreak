import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-18T06:00:00Z"); // Wednesday
const DAY = 86_400_000;
const config = {
  ...base,
  achievements: [
    { id: "first_lesson", name: "First steps", when: { metric: "lesson_completed", gte: 1 } },
    { id: "bookworm", name: "Bookworm", when: { metric: "lesson_completed" }, tiers: [{ name: "Bronze", gte: 1 }, { name: "Silver", gte: 3 }] },
  ],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: reversing an event takes its points back in its own window`, async (t) => {
    let now = start - 7 * DAY; // last week
    const engine = new Engine(config, await makeStore(t), () => now);
    const old = await engine.track({ userId: "a", event: "minutes_studied", value: 50 }); // 100 xp last week
    now = start;
    await engine.track({ userId: "a", event: "lesson_completed" }); // 10 xp, 1 coin this week
    const cheat = await engine.track({ userId: "a", event: "lesson_completed" });

    const r = await engine.reverseEvent("a", cheat.eventId);
    assert.deepEqual(r, { userId: "a", eventId: cheat.eventId, points: { xp: 10, coins: 1 }, totals: { xp: 110, coins: 1 } });
    const user = await engine.getUser("a");
    assert.deepEqual([user.points.xp, user.metrics.lesson_completed], [110, 1]);
    assert.equal((await engine.leaderboard("xp_weekly", { userId: "a" })).user.score, 10, "this week's board drops it");

    const back = await engine.reverseEvent("a", old.eventId);
    assert.deepEqual(back.points, { xp: 100 });
    assert.equal((await engine.leaderboard("xp_weekly", { userId: "a" })).user.score, 10, "last week's event never touched this week");
    assert.equal((await engine.getUser("a")).points.xp, 10);

    const history = await engine.events("a", { limit: 5 });
    const reversed = new Set(history.events.filter((e) => e.reversedAt !== null).map((e) => e.id));
    assert.deepEqual([reversed.size, reversed.has(cheat.eventId), reversed.has(old.eventId)], [2, true, true]);

    await assert.rejects(engine.reverseEvent("a", cheat.eventId), (e) => e instanceof EngineError && e.status === 409 && e.code === "already_reversed");
    await assert.rejects(engine.reverseEvent("b", old.eventId), (e) => e.status === 404, "only the owner's events");
    await assert.rejects(engine.reverseEvent("a", "00000000-0000-4000-8000-000000000000"), (e) => e.status === 404);
    await assert.rejects(engine.reverseEvent("a", "not-a-uuid"), (e) => e.status === 404);
  });

  test(`${name}: achievements and tiers can be revoked`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    for (let i = 0; i < 3; i++) await engine.track({ userId: "a", event: "lesson_completed" });
    assert.deepEqual(await engine.revokeAchievement("a", "bookworm#2"), { userId: "a", achievementId: "bookworm#2", revoked: true });
    assert.equal((await engine.revokeAchievement("a", "bookworm#2")).revoked, false);
    assert.equal((await engine.revokeAchievement("a", "first_lesson")).revoked, true);
    const user = await engine.getUser("a");
    assert.deepEqual(user.achievements.map((x) => [x.id, x.tier?.name]), [["bookworm", "Bronze"]]);
    // A revoked achievement unlocks again if earned again.
    const r = await engine.track({ userId: "a", event: "lesson_completed" });
    assert.deepEqual(r.achievements.map((x) => [x.id, x.tier?.name]), [["first_lesson", undefined], ["bookworm", "Silver"]]);
    await assert.rejects(engine.revokeAchievement("a", "nope"), (e) => e.status === 404);
    await assert.rejects(engine.revokeAchievement("a", "bookworm#9"), (e) => e.status === 404);
  });
}
