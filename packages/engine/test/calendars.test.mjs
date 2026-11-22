import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, PostgresStore, fromPgPool, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const start = Date.parse("2026-11-16T06:00:00Z"); // 11:30 in Kolkata, the default zone

const coins = (amount) => ({ rewards: [{ currency: "coins", amount }] });
const config = {
  ...base,
  achievements: [...base.achievements, { id: "rich", name: "Rich", when: { points: "coins", gte: 20 } }],
  calendars: [
    { id: "login", name: "Daily login", event: "app_opened", days: [coins(5), coins(10), { rewards: [{ currency: "coins", amount: 20 }, { currency: "xp", amount: 50 }] }] },
    { id: "loyal", event: "app_opened", days: [coins(1), coins(2)], missed: "continue", afterLast: "stay" },
  ],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: one claim a day walks through the calendar and starts over`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const open = (extra = {}) => engine.track({ userId: "asha", event: "app_opened", ...extra });

    let list = await engine.calendars("asha");
    assert.deepEqual(list.calendars[0], {
      id: "login", name: "Daily login", event: "app_opened", day: 1, claimedToday: false,
      days: [
        { day: 1, rewards: [{ currency: "coins", amount: 5 }], status: "today" },
        { day: 2, rewards: [{ currency: "coins", amount: 10 }], status: "upcoming" },
        { day: 3, rewards: [{ currency: "coins", amount: 20 }, { currency: "xp", amount: 50 }], status: "upcoming" },
      ],
      nextClaimAt: "2026-11-16T18:30:00.000Z", // midnight in Kolkata
    });
    assert.equal(list.calendars[1].name, undefined);

    let r = await open();
    assert.deepEqual(r.calendars, { login: { day: 1, rewards: [{ currency: "coins", amount: 5 }] }, loyal: { day: 1, rewards: [{ currency: "coins", amount: 1 }] } });
    assert.deepEqual(r.points, { coins: { awarded: 6, total: 6 } });
    r = await open();
    assert.deepEqual([r.calendars, r.points], [{}, {}], "once a day");
    list = await engine.calendars("asha");
    assert.deepEqual([list.calendars[0].day, list.calendars[0].claimedToday], [1, true]);
    assert.deepEqual(list.calendars[0].days.map((d) => d.status), ["claimed", "upcoming", "upcoming"]);

    now += DAY;
    assert.deepEqual((await engine.calendars("asha")).calendars[0].days.map((d) => d.status), ["claimed", "today", "upcoming"]);
    r = await open();
    assert.equal(r.calendars.login.day, 2);
    now += DAY;
    r = await open();
    assert.deepEqual(r.calendars.login, { day: 3, rewards: [{ currency: "coins", amount: 20 }, { currency: "xp", amount: 50 }] });
    assert.ok(r.achievements.some((a) => a.id === "rich"), "rewards count toward achievements");
    assert.equal(r.level.current, 2, "and levels");
    assert.equal(r.calendars.loyal.day, 2, "a stay calendar sits on its last day");

    now += DAY;
    r = await open();
    assert.deepEqual([r.calendars.login.day, r.calendars.loyal.day], [1, 2], "repeat starts over; stay keeps paying the last day");
  });

  test(`${name}: a missed day resets unless the calendar continues`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const open = () => engine.track({ userId: "ravi", event: "app_opened" });
    await open();
    now += DAY;
    await open(); // day 2 of both
    now += 3 * DAY;
    const list = await engine.calendars("ravi");
    assert.deepEqual(list.calendars.map((c) => [c.day, c.days.map((d) => d.status)]), [
      [1, ["today", "upcoming", "upcoming"]],
      [2, ["claimed", "today"]],
    ]);
    const r = await open();
    assert.deepEqual([r.calendars.login.day, r.calendars.loyal.day], [1, 2]);
  });

  test(`${name}: only events from today claim, in the user's time zone`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    let r = await engine.track({ userId: "maya", event: "app_opened", timestamp: start - DAY });
    assert.deepEqual(r.calendars, {}, "a backfilled event does not claim");

    // 23:00 in New York is already tomorrow in UTC.
    now = Date.parse("2026-11-17T04:00:00Z");
    r = await engine.track({ userId: "maya", event: "app_opened", timezone: "America/New_York" });
    assert.equal(r.calendars.login.day, 1);
    now = Date.parse("2026-11-17T05:30:00Z"); // 00:30 in New York, a new day
    r = await engine.track({ userId: "maya", event: "app_opened" });
    assert.equal(r.calendars.login.day, 2);
    const list = await engine.calendars("maya");
    assert.equal(list.calendars[0].nextClaimAt, "2026-11-18T05:00:00.000Z");
    assert.equal((await engine.calendars("maya", { timezone: "Asia/Tokyo" })).calendars[0].nextClaimAt, "2026-11-17T15:00:00.000Z");
    await assert.rejects(engine.calendars("maya", { timezone: "Nope/Zone" }), /unknown timezone/);

    // Idempotent retries do not claim twice.
    now += DAY;
    const a = await engine.track({ userId: "maya", event: "app_opened", idempotencyKey: "open-1" });
    const b = await engine.track({ userId: "maya", event: "app_opened", idempotencyKey: "open-1" });
    assert.deepEqual([a.calendars.login.day, b.duplicate, b.calendars.login.day], [3, true, 3]);
  });
}

test("calendar config is validated", () => {
  const bad = (cal) => assert.throws(() => resolveConfig({ ...base, calendars: [{ id: "c", event: "app_opened", days: [coins(1)], ...cal }] }), /Invalid onstreak config/);
  bad({ event: "bad event" });
  bad({ days: [] });
  bad({ days: [{}] });
  bad({ days: [{ rewards: [{ currency: "gems", amount: 1 }] }] });
  bad({ days: [{ rewards: [{ currency: "coins", amount: 0 }] }] });
  bad({ missed: "skip" });
  bad({ afterLast: "loop" });
  bad({ timezone: "Mars/Base" });
  bad({ name: "" });
  assert.equal(resolveConfig({ ...base, calendars: [{ id: "c", event: "app_opened", days: [{ rewards: [] }] }] }).calendars.length, 1, "a day may pay nothing");
});

test("pg: concurrent opens claim the day once", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const engine = new Engine(config, store, () => start);
  const results = await Promise.all(Array.from({ length: 10 }, () => engine.track({ userId: "fast", event: "app_opened" })));
  assert.equal(results.filter((r) => r.calendars.login).length, 1);
  assert.equal((await engine.getUser("fast")).points.coins, 6);
});
