import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const DAY = 86_400_000;
const config = {
  ...base,
  defaultTimezone: "UTC",
  achievements: [],
  items: [],
  streaks: [
    { id: "daily_lesson", event: "lesson_completed", period: "daily", freezes: { start: 1, max: 2 } },
    { id: "weekdays", event: "minutes_studied", period: "daily", skipWeekends: true },
  ],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: lists users who still need today's activity, in their own time zone`, async (t) => {
    let now = Date.parse("2026-11-16T10:00:00Z"); // Monday
    const engine = new Engine(config, await makeStore(t), () => now);
    const lesson = (u, extra = {}) => engine.track({ userId: u, event: "lesson_completed", ...extra });
    await engine.updateUser("asha", { displayName: "Asha" });
    await lesson("asha");
    await lesson("ravi");
    await lesson("maya", { timezone: "Asia/Tokyo" });
    await lesson("zoe");
    now += DAY; // Tuesday 10:00 UTC (19:00 in Tokyo)
    await lesson("zoe"); // done today
    await engine.updateUser("ravi", { timezone: "America/New_York" });

    let r = await engine.streaksAtRisk("daily_lesson");
    assert.deepEqual(r.users.map((u) => [u.userId, u.endsAt, u.lastChance]), [
      ["asha", "2026-11-18T00:00:00.000Z", false],
      ["maya", "2026-11-17T15:00:00.000Z", false],
      ["ravi", "2026-11-18T05:00:00.000Z", false],
    ]);
    assert.deepEqual([r.users[0].displayName, r.users[0].current, r.users[0].freezes, r.nextCursor], ["Asha", 1, 1, null]);

    r = await engine.streaksAtRisk("daily_lesson", { endingWithinHours: 6 });
    assert.deepEqual(r.users.map((u) => u.userId), ["maya"], "only Tokyo's day ends within 6 hours");

    // Paging.
    const first = await engine.streaksAtRisk("daily_lesson", { limit: 2 });
    assert.deepEqual(first.users.map((u) => u.userId), ["asha", "maya"]);
    const second = await engine.streaksAtRisk("daily_lesson", { limit: 2, cursor: first.nextCursor });
    assert.deepEqual([second.users.map((u) => u.userId), second.nextCursor], [["ravi"], null]);

    now += DAY; // Wednesday: asha missed Tuesday, her freeze covered it, now no freeze is left
    r = await engine.streaksAtRisk("daily_lesson");
    const asha = r.users.find((u) => u.userId === "asha");
    assert.deepEqual([asha.freezes, asha.lastChance], [0, true]);
    assert.ok(!r.users.some((u) => u.userId === "zoe") || r.users.find((u) => u.userId === "zoe").lastChance === false);

    await assert.rejects(engine.streaksAtRisk("nope"), (e) => e.status === 404);
    for (const opts of [{ limit: 0 }, { limit: 501 }, { endingWithinHours: 0 }, { cursor: "!!" }]) {
      await assert.rejects(engine.streaksAtRisk("daily_lesson", opts), (e) => e instanceof EngineError && e.status === 400);
    }
  });

  test(`${name}: a day off is not a risk`, async (t) => {
    let now = Date.parse("2026-11-20T10:00:00Z"); // Friday
    const engine = new Engine(config, await makeStore(t), () => now);
    await engine.track({ userId: "w", event: "minutes_studied", value: 5 });
    now = Date.parse("2026-11-21T10:00:00Z"); // Saturday
    assert.deepEqual((await engine.streaksAtRisk("weekdays")).users, []);
    now = Date.parse("2026-11-23T10:00:00Z"); // Monday
    const r = await engine.streaksAtRisk("weekdays");
    assert.deepEqual(r.users.map((u) => [u.userId, u.lastChance]), [["w", true]]);
  });
}
