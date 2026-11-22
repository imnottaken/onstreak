import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, PostgresStore, fromPgPool, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const at = (day, hour = 10) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`);
const config = {
  ...base,
  seasons: [
    {
      id: "autumn",
      name: "Autumn cup",
      currency: "xp",
      from: "2026-11-16T00:00:00Z",
      to: "2026-11-23T00:00:00Z",
      rewards: [
        { top: 3, rewards: [{ currency: "coins", amount: 10 }] },
        { top: 1, title: "Champion", rewards: [{ currency: "coins", amount: 50 }, { currency: "xp", amount: 5 }] },
      ],
    },
    { id: "winter", name: "Winter cup", currency: "xp", from: "2026-12-01T00:00:00Z", to: "2027-03-01T00:00:00Z" },
  ],
};

const coins = async (engine, u) => (await engine.getUser(u)).points.coins;

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: season standings, fixed at the end, with rank awards paid once`, async (t) => {
    let now = at(15); // the day before it starts
    const engine = new Engine(config, await makeStore(t), () => now);
    const lessons = async (u, n) => {
      for (let i = 0; i < n; i++) await engine.track({ userId: u, event: "lesson_completed" });
    };
    await lessons("early", 5); // before the season: does not count

    now = at(17);
    await lessons("a", 3);
    await lessons("b", 2);
    await lessons("c", 2);
    await lessons("d", 1);

    let list = await engine.seasons({ userId: "b" });
    assert.deepEqual(list.seasons.map((s) => s.status), ["active", "upcoming"]);
    assert.deepEqual(list.seasons[0].rewards.map((r) => r.top), [1, 3], "best tier first");
    assert.deepEqual(list.seasons[0].you, { score: 20, rank: 2, award: { top: 3, rewards: [{ currency: "coins", amount: 10 }] }, rewarded: false, paidNow: [] }, "provisional while it runs");

    let st = await engine.seasonStandings("autumn", { userId: "d", limit: 3 });
    assert.deepEqual(st.entries.map((e) => [e.userId, e.rank, e.score]), [["a", 1, 30], ["b", 2, 20], ["c", 2, 20]]);
    assert.deepEqual([st.user.rank, st.final, st.status], [4, false, "active"]);

    now = at(24); // the season is over
    await engine.track({ userId: "d", event: "lesson_completed", timestamp: at(20) }); // backfilled into the window, too late
    st = await engine.seasonStandings("autumn", { userId: "d" });
    assert.deepEqual([st.final, st.user.score, st.user.rank], [true, 10, 4], "the archive does not change");

    const before = await coins(engine, "a");
    list = await engine.seasons({ userId: "a" });
    const you = list.seasons[0].you;
    assert.deepEqual([you.rank, you.award.title, you.rewarded], [1, "Champion", true]);
    assert.deepEqual(you.paidNow, [{ currency: "coins", amount: 50 }, { currency: "xp", amount: 5 }], "only the best tier");
    assert.equal(await coins(engine, "a"), before + 50);
    assert.deepEqual((await engine.seasons({ userId: "a" })).seasons[0].you.paidNow, [], "paid once");
    assert.equal(await coins(engine, "a"), before + 50);

    for (const u of ["b", "c"]) assert.deepEqual((await engine.seasons({ userId: u })).seasons[0].you.paidNow, [{ currency: "coins", amount: 10 }], "ties share a tier");
    const d = (await engine.seasons({ userId: "d" })).seasons[0].you;
    assert.deepEqual([d.rank, d.award, d.rewarded], [4, null, false]);
    const nobody = (await engine.seasons({ userId: "early" })).seasons[0].you;
    assert.deepEqual([nobody.score, nobody.rank, nobody.award], [0, null, null]);

    // Award points land after the season, so they do not change its standings.
    st = await engine.seasonStandings("autumn");
    assert.equal(st.entries[0].score, 30);
  });

  test(`${name}: season lookups are validated`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => at(17));
    await assert.rejects(engine.seasonStandings("nope"), (e) => e.status === 404);
    await assert.rejects(engine.seasonStandings("autumn", { limit: 0 }), (e) => e.status === 400);
    await assert.rejects(engine.seasons({ userId: "bad id" }), (e) => e.status === 400);
    assert.deepEqual((await engine.seasons()).seasons.map((s) => s.you), [null, null]);
  });
}

test("season config is validated", () => {
  const s = { id: "s", name: "S", currency: "xp", from: "2026-01-01", to: "2026-02-01" };
  const bad = (extra) => assert.throws(() => resolveConfig({ ...base, seasons: [{ ...s, ...extra }] }), /season "s"/);
  bad({ name: "" });
  bad({ currency: "gems" });
  bad({ to: "2025-01-01" });
  bad({ rewards: [{ top: 0, rewards: [] }] });
  bad({ rewards: [{ top: 1, rewards: [] }, { top: 1, rewards: [] }] });
  bad({ rewards: [{ top: 1, rewards: [{ currency: "coins", amount: 0 }] }] });
  bad({ rewards: [{ top: 1, title: "", rewards: [] }] });
  assert.throws(() => resolveConfig({ ...base, seasons: [s, s] }), /duplicate/);
});

test("pg: concurrent looks pay a season award once", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  let now = at(17);
  const engine = new Engine(config, store, () => now);
  await engine.track({ userId: "fast", event: "lesson_completed" });
  now = at(24);
  const looks = await Promise.all(Array.from({ length: 10 }, () => engine.seasons({ userId: "fast" })));
  assert.equal(looks.filter((l) => l.seasons[0].you.paidNow.length > 0).length, 1);
  assert.equal((await engine.getUser("fast")).points.coins, 1 + 50);
});
