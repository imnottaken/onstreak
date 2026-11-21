import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, MAX_BATCH } from "../dist/index.js";
import { config } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const DAY = 86_400_000;
const start = Date.parse("2026-11-16T06:00:00Z"); // Monday

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: profiles are stored, cleared and shown on leaderboards and leagues`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    await engine.track({ userId: "asha", event: "minutes_studied", value: 20 });
    await engine.track({ userId: "ravi", event: "minutes_studied", value: 10 });

    const updated = await engine.updateUser("asha", {
      displayName: "  Asha K  ",
      avatarUrl: "https://example.com/a.png",
      metadata: { school: "IIT", year: 2 },
    });
    assert.deepEqual(updated.profile, {
      displayName: "Asha K",
      avatarUrl: "https://example.com/a.png",
      metadata: { school: "IIT", year: 2 },
      timezone: null,
    });
    assert.equal(updated.points.xp, 40, "updateUser returns the full profile");

    const board = await engine.leaderboard("xp_all", { userId: "ravi" });
    assert.deepEqual(board.entries[0], { rank: 1, userId: "asha", score: 40, displayName: "Asha K", avatarUrl: "https://example.com/a.png" });
    assert.deepEqual(board.user, { rank: 2, userId: "ravi", score: 20, displayName: null, avatarUrl: null });

    const league = await engine.league("study_league", "ravi");
    assert.equal(league.group.entries.find((e) => e.userId === "asha").displayName, "Asha K");
    assert.equal(league.you.displayName, null);

    // Partial updates leave other fields alone; null clears one field.
    await engine.updateUser("asha", { avatarUrl: null });
    const after = (await engine.getUser("asha")).profile;
    assert.equal(after.displayName, "Asha K");
    assert.equal(after.avatarUrl, null);
    assert.deepEqual(after.metadata, { school: "IIT", year: 2 });

    // A profile can exist before any events.
    const fresh = await engine.updateUser("newbie", { displayName: "New" });
    assert.equal(fresh.profile.displayName, "New");
    assert.equal(fresh.points.xp, 0);
  });

  test(`${name}: a user's time zone is remembered and used for streak days`, async (t) => {
    let now = Date.parse("2026-01-01T17:30:00Z"); // 23:00 in India, still Jan 1 in UTC
    const engine = new Engine({ ...config, defaultTimezone: "UTC" }, await makeStore(t), () => now);
    await engine.track({ userId: "t", event: "lesson_completed", timezone: "Asia/Kolkata" });
    assert.equal((await engine.getUser("t")).profile.timezone, "Asia/Kolkata", "zone sent with an event is saved");

    now = Date.parse("2026-01-01T19:00:00Z"); // 00:30 Jan 2 in India, Jan 1 in UTC
    const second = await engine.track({ userId: "t", event: "lesson_completed" }); // no zone sent
    assert.equal(second.streaks.daily_lesson.current, 2, "the remembered zone made this a new day");

    await engine.updateUser("t", { timezone: "UTC" });
    const third = await engine.track({ userId: "t", event: "lesson_completed", timestamp: "2026-01-01T20:00:00Z" });
    // In UTC this event falls on Jan 1, before the last counted day (Jan 2 in India), so it cannot extend the streak.
    assert.equal(third.streaks.daily_lesson.extended, false, "the newly saved zone is used");
    assert.equal((await engine.getUser("t")).profile.timezone, "UTC");
  });

  test(`${name}: event history pages newest first with what each event awarded`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const ids = [];
    for (let i = 0; i < 5; i++) {
      now = start + i * 60_000;
      ids.push((await engine.track({ userId: "h", event: "lesson_completed" })).eventId);
    }
    await engine.track({ userId: "other", event: "lesson_completed" });

    const page1 = await engine.events("h", { limit: 2 });
    assert.deepEqual(page1.events.map((e) => e.id), [ids[4], ids[3]]);
    assert.equal(page1.events[0].event, "lesson_completed");
    assert.equal(page1.events[0].result.points.xp.awarded, 10);
    assert.ok(page1.nextCursor);

    const page2 = await engine.events("h", { limit: 2, cursor: page1.nextCursor });
    assert.deepEqual(page2.events.map((e) => e.id), [ids[2], ids[1]]);
    const page3 = await engine.events("h", { limit: 2, cursor: page2.nextCursor });
    assert.deepEqual(page3.events.map((e) => e.id), [ids[0]]);
    assert.equal(page3.nextCursor, null, "last page");

    // Backfilled events sort by when they happened, and show when they arrived.
    await engine.track({ userId: "h", event: "lesson_completed", timestamp: start - DAY });
    const all = await engine.events("h", { limit: 100 });
    assert.equal(all.events.length, 6);
    const backfilled = all.events[5];
    assert.equal(backfilled.timestamp, new Date(start - DAY).toISOString());
    assert.equal(backfilled.recordedAt, new Date(now).toISOString());

    assert.deepEqual((await engine.events("nobody")).events, []);
  });

  test(`${name}: batch tracking applies events in order and reports bad ones in place`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    const results = await engine.trackBatch([
      { userId: "b", event: "lesson_completed" },
      { userId: "b", event: "bad event" },
      { userId: "b", event: "minutes_studied", value: 5 },
      { userId: "c", event: "lesson_completed", idempotencyKey: "k1" },
      { userId: "c", event: "lesson_completed", idempotencyKey: "k1" },
    ]);
    assert.deepEqual(results.map((r) => r.ok), [true, false, true, true, true]);
    assert.equal(results[1].status, 400);
    assert.match(results[1].error, /event/);
    assert.equal(results[2].result.points.xp.total, 20, "applied after the first, in order");
    assert.equal(results[4].result.duplicate, true);
    assert.equal((await engine.getUser("b")).points.xp, 20);
    assert.equal((await engine.getUser("c")).points.xp, 10);
  });

  test(`${name}: points backfilled after a league round ended never change its result`, async (t) => {
    let now = start;
    const cfg = {
      currencies: ["xp"],
      points: [{ event: "win", currency: "xp", amount: 1, multiplyByValue: true }],
      leagues: [{ id: "arena", currency: "xp", tiers: ["bronze", "silver"], groupSize: 5, promote: 1, demote: 1 }],
    };
    const engine = new Engine(cfg, await makeStore(t), () => now);
    await engine.track({ userId: "leader", event: "win", value: 30 });
    await engine.track({ userId: "cheater", event: "win", value: 10 });

    now += 7 * DAY; // round 1 is over, nobody has settled yet
    // A late event dated inside round 1 arrives after it ended.
    await engine.track({ userId: "cheater", event: "win", value: 1000, timestamp: start + 60_000 });

    const leader = await engine.league("arena", "leader");
    assert.equal(leader.previous.rank, 1, "the late points did not overtake the leader");
    assert.equal(leader.previous.outcome, "promoted");
    const cheater = await engine.league("arena", "cheater");
    assert.equal(cheater.previous.rank, 2);
    assert.equal(cheater.previous.outcome, "stayed");
  });
}

test("profile updates are validated", async () => {
  const engine = new Engine(config, new MemoryStore());
  const bad = [
    [{ displayName: "" }, /displayName/],
    [{ displayName: "x".repeat(81) }, /displayName/],
    [{ displayName: 42 }, /displayName/],
    [{ avatarUrl: "javascript:alert(1)" }, /avatarUrl/],
    [{ avatarUrl: "not a url" }, /avatarUrl/],
    [{ metadata: [1, 2] }, /metadata/],
    [{ metadata: { big: "x".repeat(9000) } }, /8 KB/],
    [{ timezone: "Mars/Base" }, /timezone/],
    [{ nickname: "x" }, /unknown field "nickname"/],
    [null, /JSON object/],
    [[], /JSON object/],
  ];
  for (const [patch, pattern] of bad) {
    await assert.rejects(engine.updateUser("u", patch), pattern, JSON.stringify(patch));
  }
  await assert.rejects(engine.updateUser("has space", {}), /userId/);
});

test("event history and batch inputs are validated", async () => {
  const engine = new Engine(config, new MemoryStore());
  await assert.rejects(engine.events("u", { limit: 0 }), /limit/);
  await assert.rejects(engine.events("u", { cursor: "garbage!!" }), /cursor/);
  await assert.rejects(engine.trackBatch([]), /1 to 100/);
  await assert.rejects(engine.trackBatch({}), /array/);
  await assert.rejects(engine.trackBatch(Array.from({ length: MAX_BATCH + 1 }, () => ({ userId: "u", event: "e" }))), /1 to 100/);
});
