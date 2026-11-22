import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError, PostgresStore, fromPgPool, resolveConfig } from "../dist/index.js";
import { config } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");

/** Rejects with an EngineError of this status and code. */
async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (err) => err instanceof EngineError && err.status === status && err.code === code);
}

async function earnCoins(engine, userId, n) {
  for (let i = 0; i < n; i++) await engine.track({ userId, event: "lesson_completed" });
}

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: buying spends the wallet but never earned points`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    await earnCoins(engine, "asha", 7); // 7 coins, 70 xp

    let shop = await engine.rewardStore("asha");
    assert.deepEqual(shop.wallet, { xp: 70, coins: 7 });
    assert.deepEqual(
      shop.items.map((i) => [i.id, i.owned, i.canBuy]),
      [["sticker", 0, true], ["streak_freeze", 0, true], ["gold_frame", 0, true]],
    );
    assert.deepEqual(shop.items[1], {
      id: "streak_freeze", name: "Streak freeze", description: "Keeps your streak for a day",
      price: { currency: "coins", amount: 5 }, limit: 2, owned: 0, canBuy: true,
    });
    assert.deepEqual(shop.items[2].metadata, { image: "/frame.png" });
    assert.equal(shop.items[0].limit, null);

    now += 1000;
    const r = await engine.purchase("asha", { item: "streak_freeze" });
    assert.equal(r.duplicate, false);
    assert.equal(r.owned, 1);
    assert.deepEqual(r.wallet, { xp: 70, coins: 2 });
    assert.deepEqual(r.purchase.cost, { currency: "coins", amount: 5 });
    assert.equal(r.purchase.name, "Streak freeze");
    assert.equal(r.purchase.purchasedAt, new Date(start + 1000).toISOString());

    const user = await engine.getUser("asha");
    assert.deepEqual(user.points, { xp: 70, coins: 7 }, "earned totals do not drop");
    assert.deepEqual(user.wallet, { xp: 70, coins: 2 });
    assert.deepEqual(user.inventory, { streak_freeze: 1 });

    shop = await engine.rewardStore("asha");
    assert.deepEqual(shop.items.map((i) => [i.id, i.owned, i.canBuy]), [["sticker", 0, true], ["streak_freeze", 1, false], ["gold_frame", 0, true]]);

    // Spending does not count against the leaderboard or achievements.
    const board = await engine.leaderboard("xp_all");
    assert.equal(board.entries[0].score, 70);

    // Earning more refills the wallet.
    await earnCoins(engine, "asha", 3);
    assert.deepEqual((await engine.rewardStore("asha")).wallet, { xp: 100, coins: 5 });
  });

  test(`${name}: funds, limits, quantities and unknown items`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    await rejectsWith(engine.purchase("new", { item: "sticker" }), 409, "insufficient_funds");
    await earnCoins(engine, "ravi", 12);

    await rejectsWith(engine.purchase("ravi", { item: "sticker", quantity: 13 }), 409, "insufficient_funds");
    const many = await engine.purchase("ravi", { item: "sticker", quantity: 12 });
    assert.deepEqual([many.owned, many.wallet.coins, many.purchase.cost.amount], [12, 0, 12]);
    await rejectsWith(engine.purchase("ravi", { item: "sticker" }), 409, "insufficient_funds");

    // Free items still respect their limit.
    assert.equal((await engine.purchase("ravi", { item: "gold_frame" })).owned, 1);
    await rejectsWith(engine.purchase("ravi", { item: "gold_frame" }), 409, "limit_reached");

    await earnCoins(engine, "ravi", 15);
    await rejectsWith(engine.purchase("ravi", { item: "streak_freeze", quantity: 3 }), 409, "limit_reached");
    assert.equal((await engine.purchase("ravi", { item: "streak_freeze", quantity: 2 })).owned, 2);
    assert.equal((await engine.rewardStore("ravi")).wallet.coins, 5);

    await rejectsWith(engine.purchase("ravi", { item: "nope" }), 404, undefined);
    for (const quantity of [0, -1, 1.5, 1001, "2"]) {
      await rejectsWith(engine.purchase("ravi", { item: "sticker", quantity }), 400, undefined);
    }
    await rejectsWith(engine.purchase("ravi", { item: "sticker", idempotencyKey: "" }), 400, undefined);
    await rejectsWith(engine.purchase("bad user", { item: "sticker" }), 400, undefined);
    await rejectsWith(engine.purchase("ravi", null), 400, undefined);

    // A failed purchase changes nothing.
    const user = await engine.getUser("ravi");
    assert.deepEqual(user.inventory, { sticker: 12, gold_frame: 1, streak_freeze: 2 });
    assert.equal(user.wallet.coins, 5);
  });

  test(`${name}: idempotency keys charge once`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    await earnCoins(engine, "maya", 3);
    const first = await engine.purchase("maya", { item: "sticker", idempotencyKey: "buy-1" });
    const again = await engine.purchase("maya", { item: "sticker", idempotencyKey: "buy-1" });
    assert.equal(again.duplicate, true);
    assert.equal(again.purchase.id, first.purchase.id);
    assert.deepEqual([again.owned, again.wallet.coins], [1, 2]);
    // Another user may reuse the key.
    await earnCoins(engine, "zoe", 1);
    assert.equal((await engine.purchase("zoe", { item: "sticker", idempotencyKey: "buy-1" })).duplicate, false);
  });

  test(`${name}: purchase history pages newest first`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    await earnCoins(engine, "asha", 5);
    for (let i = 0; i < 5; i++) {
      now += 60_000;
      await engine.purchase("asha", { item: "sticker" });
    }
    const page1 = await engine.purchases("asha", { limit: 2 });
    assert.equal(page1.purchases.length, 2);
    assert.equal(page1.purchases[0].purchasedAt, new Date(start + 5 * 60_000).toISOString());
    const page2 = await engine.purchases("asha", { limit: 2, cursor: page1.nextCursor });
    const page3 = await engine.purchases("asha", { limit: 2, cursor: page2.nextCursor });
    assert.equal(page3.purchases.length, 1);
    assert.equal(page3.nextCursor, null);
    const ids = [...page1.purchases, ...page2.purchases, ...page3.purchases].map((p) => p.id);
    assert.equal(new Set(ids).size, 5);
    assert.deepEqual(await engine.purchases("nobody"), { purchases: [], nextCursor: null });
    await rejectsWith(engine.purchases("asha", { limit: 0 }), 400, undefined);
    await rejectsWith(engine.purchases("asha", { cursor: "junk" }), 400, undefined);

    // Items removed from the config still show in history, without a name.
    const later = new Engine({ ...config, items: [] }, engine["store"], () => now);
    const old = await later.purchases("asha", { limit: 1 });
    assert.deepEqual([old.purchases[0].item, old.purchases[0].name], ["sticker", null]);
  });
}

test("item config is validated", () => {
  const bad = (items) => assert.throws(() => resolveConfig({ ...config, items }), /Invalid onstreak config/);
  bad([{ id: "a", price: { currency: "coins", amount: 1 } }]);
  bad([{ id: "a", name: "A" }]);
  bad([{ id: "a", name: "A", price: { currency: "gems", amount: 1 } }]);
  bad([{ id: "a", name: "A", price: { currency: "coins", amount: -1 } }]);
  bad([{ id: "a", name: "A", price: { currency: "coins", amount: 1 }, limit: 0 }]);
  bad([{ id: "a", name: "A", price: { currency: "coins", amount: 1 }, limit: 1.5 }]);
  bad([{ id: "a", name: "A", price: { currency: "coins", amount: 1 }, metadata: [] }]);
  bad([{ id: "a", name: "A", price: { currency: "coins", amount: 1 } }, { id: "a", name: "B", price: { currency: "coins", amount: 1 } }]);
  assert.deepEqual(resolveConfig({ ...config, items: undefined }).items, []);
});

test("pg: concurrent purchases never overspend", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const engine = new Engine(config, store, () => start);
  await earnCoins(engine, "fast", 12);
  // 20 buyers race for 5-coin freezes: only 2 fit the limit, and 12 coins only cover 2.
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => engine.purchase("fast", { item: "streak_freeze" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.status === 409));
  const user = await engine.getUser("fast");
  assert.deepEqual([user.wallet.coins, user.inventory.streak_freeze], [2, 2]);

  // The same idempotency key sent 10 times at once charges once.
  const keyed = await Promise.all(Array.from({ length: 10 }, () => engine.purchase("fast", { item: "sticker", idempotencyKey: "k" })));
  assert.equal(keyed.filter((r) => !r.duplicate).length, 1);
  assert.equal((await engine.getUser("fast")).wallet.coins, 1);
});
