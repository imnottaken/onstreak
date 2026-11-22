import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError, PostgresStore, fromPgPool, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const MIN = 60_000;
const start = Date.parse("2026-11-16T06:00:00Z");

const config = {
  ...base,
  items: [
    ...base.items,
    { id: "xp_potion", name: "XP potion", price: { currency: "coins", amount: 2 }, effect: { boost: { factor: 2, minutes: 30, currency: "xp" } } },
  ],
};

async function rejectsWith(promise, status) {
  await assert.rejects(promise, (err) => err instanceof EngineError && err.status === status);
}

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: a boost multiplies points while it runs, then stops`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const lesson = (extra = {}) => engine.track({ userId: "asha", event: "lesson_completed", ...extra });

    const g = await engine.grantBoost("asha", { factor: 2, minutes: 60, currency: "xp", reason: "welcome_back" });
    assert.equal(g.duplicate, false);
    assert.deepEqual(g.boost, {
      id: g.boost.id, factor: 2, currency: "xp", reason: "welcome_back",
      startsAt: new Date(start).toISOString(), endsAt: new Date(start + 60 * MIN).toISOString(),
    });

    let r = await lesson();
    assert.deepEqual(r.points, { xp: { awarded: 20, total: 20 }, coins: { awarded: 1, total: 1 } }, "only xp is boosted");
    assert.deepEqual(r.multipliers, { [`boost:${g.boost.id}`]: { factor: 2, currency: "xp" } });

    // Boosts multiply with each other (different factor) and with config multipliers.
    await engine.grantBoost("asha", { factor: 1.5, minutes: 10 });
    r = await lesson();
    assert.deepEqual([r.points.xp.awarded, r.points.coins.awarded], [30, 1.5]);

    // A backfilled event from before the boost does not get it.
    r = await lesson({ timestamp: start - 5 * MIN });
    assert.equal(r.points.xp.awarded, 10);
    assert.deepEqual(r.multipliers, {});

    now = start + 30 * MIN; // the 10-minute one has ended
    r = await lesson();
    assert.equal(r.points.xp.awarded, 20);
    assert.deepEqual((await engine.getUser("asha")).boosts.map((b) => b.factor), [2]);

    now = start + 60 * MIN; // ends exactly now
    r = await lesson();
    assert.equal(r.points.xp.awarded, 10);
    assert.deepEqual((await engine.getUser("asha")).boosts, []);
  });

  test(`${name}: the same boost queues instead of stacking`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    await engine.grantBoost("ravi", { factor: 2, minutes: 30 });
    const second = await engine.grantBoost("ravi", { factor: 2, minutes: 30, idempotencyKey: "k" });
    assert.equal(second.boost.startsAt, new Date(start + 30 * MIN).toISOString(), "starts when the first ends");
    assert.equal(second.boost.endsAt, new Date(start + 60 * MIN).toISOString());
    assert.equal(second.boosts.length, 2);
    const again = await engine.grantBoost("ravi", { factor: 2, minutes: 30, idempotencyKey: "k" });
    assert.deepEqual([again.duplicate, again.boost.id, again.boosts.length], [true, second.boost.id, 2]);

    let r = await engine.track({ userId: "ravi", event: "lesson_completed" });
    assert.equal(r.points.xp.awarded, 20, "2x, not 4x");
    now = start + 45 * MIN;
    r = await engine.track({ userId: "ravi", event: "lesson_completed" });
    assert.equal(r.points.xp.awarded, 20, "the queued one is running");
    assert.equal(Object.keys(r.multipliers)[0], `boost:${second.boost.id}`);

    // A different currency is a different boost, so it runs alongside.
    const coins = await engine.grantBoost("ravi", { factor: 2, minutes: 5, currency: "coins" });
    assert.equal(coins.boost.startsAt, new Date(now).toISOString());
  });

  test(`${name}: an item with a boost effect queues one boost per item used`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    for (let i = 0; i < 4; i++) await engine.track({ userId: "maya", event: "lesson_completed" });
    await engine.purchase("maya", { item: "xp_potion", quantity: 2 });
    const used = await engine.useItem("maya", "xp_potion", { quantity: 2 });
    assert.deepEqual(used.effects, { boost: { factor: 2, currency: "xp", startsAt: new Date(start).toISOString(), endsAt: new Date(start + 60 * MIN).toISOString() } });
    const user = await engine.getUser("maya");
    assert.deepEqual(user.boosts.map((b) => [b.reason, b.startsAt]), [
      ["item:xp_potion", new Date(start).toISOString()],
      ["item:xp_potion", new Date(start + 30 * MIN).toISOString()],
    ]);
    now = start + 59 * MIN;
    assert.equal((await engine.track({ userId: "maya", event: "lesson_completed" })).points.xp.awarded, 20);
  });

  test(`${name}: boost input is validated`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    for (const bad of [
      { factor: 0, minutes: 10 },
      { factor: 101, minutes: 10 },
      { factor: "2", minutes: 10 },
      { factor: 2, minutes: 0 },
      { factor: 2, minutes: 1.5 },
      { factor: 2, minutes: 43201 },
      { factor: 2, minutes: 10, currency: "gems" },
      { factor: 2, minutes: 10, reason: "has space" },
      { factor: 2, minutes: 10, idempotencyKey: "" },
      null,
      [],
    ]) {
      await rejectsWith(engine.grantBoost("asha", bad), 400);
    }
    await rejectsWith(engine.grantBoost("bad user", { factor: 2, minutes: 10 }), 400);
    assert.deepEqual((await engine.getUser("asha")).boosts, []);
  });
}

test("boost item effects are validated", () => {
  const item = (boost) => () => resolveConfig({ ...base, items: [{ id: "p", name: "P", price: { currency: "coins", amount: 1 }, effect: { boost } }] });
  assert.throws(item({ factor: 2 }), /minutes/);
  assert.throws(item({ factor: -1, minutes: 5 }), /factor/);
  assert.throws(item({ factor: 2, minutes: 5, currency: "gems" }), /unknown currency/);
  assert.throws(item(null), /needs/);
  assert.doesNotThrow(item({ factor: 2, minutes: 5 }));
});

test("pg: boosts granted at the same moment queue without overlapping", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const engine = new Engine(config, store, () => start);
  await Promise.all(Array.from({ length: 8 }, () => engine.grantBoost("fast", { factor: 2, minutes: 15 })));
  const boosts = (await engine.getUser("fast")).boosts;
  assert.equal(boosts.length, 8);
  for (let i = 1; i < boosts.length; i++) assert.equal(boosts[i].startsAt, boosts[i - 1].endsAt, "back to back");
  assert.equal(boosts[7].endsAt, new Date(start + 120 * MIN).toISOString());
});
