import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, PostgresStore, fromPgPool } from "../dist/index.js";
import { config } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: friendship is mutual, repeatable and removable`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    await engine.updateUser("maya", { displayName: "Maya", avatarUrl: "https://example.com/m.png" });

    assert.deepEqual(await engine.addFriend("asha", "maya"), { userId: "asha", friendId: "maya", created: true });
    assert.deepEqual(await engine.addFriend("maya", "asha"), { userId: "maya", friendId: "asha", created: false }, "already friends, either way round");
    now += 60_000;
    await engine.addFriend("asha", "ravi"); // ravi has never been seen: created on the fly

    const ashas = await engine.friends("asha");
    assert.deepEqual(
      ashas.friends.map((f) => [f.userId, f.displayName, f.avatarUrl]),
      [
        ["ravi", null, null],
        ["maya", "Maya", "https://example.com/m.png"],
      ],
      "newest first, with profiles",
    );
    assert.equal(ashas.friends[1].since, new Date(start).toISOString());
    assert.deepEqual((await engine.friends("maya")).friends.map((f) => f.userId), ["asha"], "mutual");

    assert.deepEqual(await engine.removeFriend("maya", "asha"), { userId: "maya", friendId: "asha", removed: true });
    assert.equal((await engine.removeFriend("asha", "maya")).removed, false, "already removed");
    assert.deepEqual((await engine.friends("asha")).friends.map((f) => f.userId), ["ravi"]);
    assert.deepEqual((await engine.friends("maya")).friends, []);
    assert.deepEqual((await engine.friends("nobody")).friends, []);
  });

  test(`${name}: the friend limit applies to both sides`, async (t) => {
    const engine = new Engine({ ...config, friends: { max: 2 } }, await makeStore(t));
    await engine.addFriend("a", "b");
    await engine.addFriend("a", "c");
    await assert.rejects(engine.addFriend("a", "d"), (e) => e.status === 409 && /a already has the maximum of 2 friends/.test(e.message));
    await assert.rejects(engine.addFriend("d", "a"), (e) => e.status === 409, "the full side blocks it whichever way round");
    assert.equal((await engine.addFriend("a", "b")).created, false, "re-adding an existing friend is fine at the limit");
    await engine.removeFriend("a", "c");
    assert.equal((await engine.addFriend("a", "d")).created, true, "room again after removing one");
  });
}

test("friend requests are validated", async () => {
  const engine = new Engine(config, new MemoryStore());
  await assert.rejects(engine.addFriend("a", "a"), /own friend/);
  await assert.rejects(engine.addFriend("a", "has space"), /friendId/);
  await assert.rejects(engine.removeFriend("", "b"), /userId/);
  await assert.rejects(engine.friends("x y"), /userId/);
  assert.throws(() => new Engine({ ...config, friends: { max: 0 } }, new MemoryStore()), /friends\.max/);
});

test("pg: concurrent friend requests create one friendship and never deadlock", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const engine = new Engine(config, store);
  // Both directions at once, many times: the fixed lock order prevents deadlocks.
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? engine.addFriend("a", "b") : engine.addFriend("b", "a"))));
  assert.equal(results.filter((r) => r.created).length, 1, "exactly one request created the friendship");
  const { rows } = await pool.query("select count(*)::int as n from onstreak_friends");
  assert.equal(rows[0].n, 2, "stored once in each direction");

  const limited = new Engine({ ...config, friends: { max: 3 } }, store);
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => limited.addFriend("hub", `spoke${i}`)));
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 3, "the limit holds under concurrency");
  assert.equal((await limited.friends("hub")).friends.length, 3);
});
