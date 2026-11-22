import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError, PostgresStore, fromPgPool, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");
const coins = (amount) => [{ currency: "coins", amount }];
const qualified = { ...base, referrals: { referrer: coins(10), referred: coins(5), qualify: { event: "lesson_completed", target: 3 } } };
const instant = { ...base, referrals: { referrer: [...coins(10), { currency: "xp", amount: 25 }], referred: coins(5), max: 2 } };

const wallet = async (engine, userId) => (await engine.getUser(userId)).points.coins;

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (err) => err instanceof EngineError && err.status === status && err.code === code);
}

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: nobody is paid until the new user qualifies, then both are, once`, async (t) => {
    let now = start;
    const engine = new Engine(qualified, await makeStore(t), () => now);
    await engine.updateUser("newbie", { displayName: "Newbie" });

    const r = await engine.addReferral("newbie", "host");
    assert.deepEqual(r, { userId: "newbie", referrerId: "host", created: true, qualified: false, rewards: [] });
    assert.deepEqual(await engine.referrals("newbie"), { userId: "newbie", referredBy: { userId: "host", qualified: false }, referred: [], rewarded: 0, max: null });
    let list = await engine.referrals("host");
    assert.deepEqual(list.referred, [{ userId: "newbie", displayName: "Newbie", avatarUrl: null, since: new Date(start).toISOString(), qualified: false, rewarded: false }]);

    await engine.track({ userId: "newbie", event: "lesson_completed" });
    const second = await engine.track({ userId: "newbie", event: "lesson_completed" });
    assert.equal(second.referral, null);
    assert.equal(await wallet(engine, "host"), 0);

    now += 1000;
    const t3 = await engine.track({ userId: "newbie", event: "lesson_completed", idempotencyKey: "third" });
    assert.deepEqual(t3.referral, { referrerId: "host", rewards: coins(5) });
    assert.deepEqual(t3.points.coins, { awarded: 1 + 5, total: 3 + 5 });
    assert.equal(await wallet(engine, "host"), 10, "the referrer is paid right away");

    // Retries, more events and reads never pay again.
    const dup = await engine.track({ userId: "newbie", event: "lesson_completed", idempotencyKey: "third" });
    assert.equal(dup.duplicate, true);
    assert.equal((await engine.track({ userId: "newbie", event: "lesson_completed" })).referral, null);
    list = await engine.referrals("host");
    assert.deepEqual([list.rewarded, list.referred[0].qualified, list.referred[0].rewarded], [1, true, true]);
    await engine.referrals("host");
    assert.equal(await wallet(engine, "host"), 10);
    assert.equal(await wallet(engine, "newbie"), 4 + 5);

    // The same referral again is a no-op; another referrer is refused.
    assert.deepEqual(await engine.addReferral("newbie", "host"), { userId: "newbie", referrerId: "host", created: false, qualified: true, rewards: [] });
    await rejectsWith(engine.addReferral("newbie", "other"), 409, "already_referred");
    await rejectsWith(engine.addReferral("host", "host"), 400, undefined);
    await rejectsWith(engine.addReferral("host", "newbie"), 400, undefined); // newbie was referred by host
    await rejectsWith(engine.addReferral("bad id", "host"), 400, undefined);
  });

  test(`${name}: without a qualify rule both sides are paid at once, up to the limit`, async (t) => {
    let now = start;
    const engine = new Engine(instant, await makeStore(t), () => now);
    for (const u of ["a", "b", "c"]) {
      now += 1000;
      const r = await engine.addReferral(u, "host");
      assert.deepEqual([r.qualified, r.rewards], [true, coins(5)]);
      assert.equal(await wallet(engine, u), 5);
    }
    const user = await engine.getUser("host");
    assert.deepEqual([user.points.coins, user.points.xp], [20, 50], "paid for two, the max");
    const list = await engine.referrals("host");
    assert.deepEqual(list.referred.map((r) => [r.userId, r.rewarded]), [["c", false], ["b", true], ["a", true]], "newest first; the third was over the limit");
    assert.deepEqual([list.rewarded, list.max], [2, 2]);
    // The board counts referral points like any other.
    assert.equal((await engine.leaderboard("xp_all")).entries[0].userId, "host");
  });

  test(`${name}: a user who already did enough qualifies when the referral is recorded`, async (t) => {
    const engine = new Engine(qualified, await makeStore(t), () => start);
    for (let i = 0; i < 3; i++) await engine.track({ userId: "keen", event: "lesson_completed" });
    const r = await engine.addReferral("keen", "host");
    assert.deepEqual([r.qualified, r.rewards], [true, coins(5)]);
    assert.equal(await wallet(engine, "host"), 10);
  });

  test(`${name}: a referrer missed after a crash is paid on the next read`, async (t) => {
    const store = await makeStore(t);
    const engine = new Engine(qualified, store, () => start);
    await engine.addReferral("late", "host");
    // Simulate the new user's transaction committing without the referrer step running.
    await store.withUser("late", (tx) => tx.qualifyReferral(start));
    assert.equal(await wallet(engine, "host"), 0);
    const list = await engine.referrals("host");
    assert.deepEqual([list.rewarded, await wallet(engine, "host")], [1, 10]);
  });
}

test("referrals must be configured", async () => {
  const { MemoryStore } = await import("../dist/index.js");
  const engine = new Engine(base, new MemoryStore(), () => start);
  await rejectsWith(engine.addReferral("a", "b"), 404, undefined);
  await rejectsWith(engine.referrals("a"), 404, undefined);
  assert.equal((await engine.track({ userId: "a", event: "lesson_completed" })).referral, null);
});

test("referral config is validated", () => {
  const bad = (referrals) => assert.throws(() => resolveConfig({ ...base, referrals }), /Invalid onstreak config/);
  bad(null);
  bad([]);
  bad({ referrer: coins(0) });
  bad({ referred: [{ currency: "gems", amount: 1 }] });
  bad({ referrer: "10 coins" });
  bad({ qualify: { event: "bad event", target: 1 } });
  bad({ qualify: { event: "lesson_completed", target: 0 } });
  bad({ max: 0 });
  assert.deepEqual(resolveConfig({ ...base, referrals: {} }).referrals, { referrer: [], referred: [] });
  assert.equal(resolveConfig(base).referrals, null);
});

test("pg: concurrent qualifying events and reads pay the referrer once", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const engine = new Engine({ ...qualified, referrals: { ...qualified.referrals, qualify: { event: "lesson_completed", target: 1 } } }, store, () => start);
  await Promise.all(["n1", "n2", "n3"].map((u) => engine.addReferral(u, "host")));
  await Promise.all([
    ...["n1", "n2", "n3"].flatMap((u) => Array.from({ length: 4 }, () => engine.track({ userId: u, event: "lesson_completed" }))),
    ...Array.from({ length: 5 }, () => engine.referrals("host")),
  ]);
  await engine.referrals("host");
  assert.equal(await wallet(engine, "host"), 30);
  for (const u of ["n1", "n2", "n3"]) assert.equal(await wallet(engine, u), 4 + 5);
});
