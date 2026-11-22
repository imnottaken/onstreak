import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-18T06:00:00Z"); // Wednesday
const config = { ...base, achievements: [], items: [] };
const DAY = 86_400_000;

async function rejects400(promise) {
  await assert.rejects(promise, (e) => e instanceof EngineError && e.status === 400);
}

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: around-me and segments`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    // u1 scores 10 xp ... u9 scores 90 xp (minutes_studied pays 2 xp a minute).
    for (let i = 1; i <= 9; i++) {
      await engine.updateUser(`u${i}`, { metadata: { country: i % 2 ? "IN" : "US", cohort: i <= 3 ? 1 : 2 } });
      await engine.track({ userId: `u${i}`, event: "minutes_studied", value: i * 5 });
    }
    let b = await engine.leaderboard("xp_all", { userId: "u5", around: 2 });
    assert.deepEqual(b.entries.map((e) => [e.rank, e.userId]), [[3, "u7"], [4, "u6"], [5, "u5"], [6, "u4"], [7, "u3"]]);
    assert.deepEqual([b.around, b.user.rank], [2, 5]);
    b = await engine.leaderboard("xp_all", { userId: "u9", around: 3 });
    assert.deepEqual(b.entries.map((e) => e.userId), ["u9", "u8", "u7", "u6"], "clipped at the top");
    b = await engine.leaderboard("xp_all", { userId: "nobody", around: 2, limit: 2 });
    assert.deepEqual([b.entries.map((e) => e.userId), b.user], [["u9", "u8"], null], "a user with no points gets the top");

    b = await engine.leaderboard("xp_all", { segment: { key: "country", value: "US" }, userId: "u4" });
    assert.deepEqual(b.entries.map((e) => [e.rank, e.userId]), [[1, "u8"], [2, "u6"], [3, "u4"], [4, "u2"]]);
    assert.deepEqual([b.segment, b.user.rank], [{ key: "country", value: "US" }, 3]);
    b = await engine.leaderboard("xp_all", { segment: { key: "cohort", value: "1" } });
    assert.deepEqual(b.entries.map((e) => e.userId), ["u3", "u2", "u1"], "numbers match as text");
    b = await engine.leaderboard("xp_all", { segment: { key: "country", value: "IN" }, userId: "u5", around: 1 });
    assert.deepEqual(b.entries.map((e) => e.userId), ["u7", "u5", "u3"], "both together");

    await rejects400(engine.leaderboard("xp_all", { around: 2 }));
    await rejects400(engine.leaderboard("xp_all", { userId: "u1", around: 0 }));
    await rejects400(engine.leaderboard("xp_all", { userId: "u1", around: 51 }));
    await rejects400(engine.leaderboard("xp_all", { segment: { key: "bad key", value: "x" } }));
    await rejects400(engine.leaderboard("xp_all", { segment: { key: "a", value: "" } }));
    await rejects400(engine.leaderboard("xp_all", { userId: "u1", scope: "friends", around: 1 }));
  });

  test(`${name}: past winners are fixed when each window closes`, async (t) => {
    let now = start - 14 * DAY; // two weeks back
    const engine = new Engine(config, await makeStore(t), () => now);
    const study = (u, v, extra = {}) => engine.track({ userId: u, event: "minutes_studied", value: v, ...extra });
    await study("a", 30);
    await study("b", 20);
    await study("c", 10);
    await study("d", 5);
    now += 7 * DAY;
    await study("d", 50);
    await study("c", 1);
    now += 7 * DAY; // this week
    await study("a", 99, { timestamp: start - 8 * DAY }); // backfilled into last week, after it closed
    await study("b", 7);

    const h = await engine.leaderboardHistory("xp_weekly", { periods: 3 });
    assert.equal(h.windows.length, 3);
    assert.deepEqual(h.windows.map((w) => w.from), ["2026-11-09T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "2026-10-26T00:00:00.000Z"]);
    assert.deepEqual(h.windows[0].entries.map((e) => [e.rank, e.userId, e.score]), [[1, "d", 100], [2, "c", 2]], "the late 99 minutes do not count");
    assert.deepEqual(h.windows[1].entries.map((e) => e.userId), ["a", "b", "c"], "top 3 by default");
    assert.deepEqual(h.windows[2].entries, []);
    assert.equal((await engine.leaderboardHistory("xp_weekly", { top: 1, periods: 1 })).windows[0].entries.length, 1);

    await rejects400(engine.leaderboardHistory("xp_all"));
    await rejects400(engine.leaderboardHistory("xp_weekly", { periods: 0 }));
    await rejects400(engine.leaderboardHistory("xp_weekly", { top: 11 }));
    await assert.rejects(engine.leaderboardHistory("nope"), (e) => e.status === 404);
  });
}
