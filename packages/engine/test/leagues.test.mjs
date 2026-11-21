import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, resolveConfig, zoneFor } from "../dist/index.js";
import { storeFactories } from "./helpers.mjs";

const config = {
  currencies: ["xp"],
  points: [{ event: "win", currency: "xp", amount: 1, multiplyByValue: true }],
  leagues: [{ id: "arena", currency: "xp", tiers: ["bronze", "silver", "gold"], groupSize: 3, promote: 1, demote: 1, period: "weekly" }],
};

const DAY = 86_400_000;
const monday = Date.parse("2026-11-16T10:00:00Z");

test("zones: top promotes, bottom demotes, edges and small groups are safe", () => {
  const league = resolveConfig(config).leagues[0];
  // bronze (index 0) never demotes, gold (index 2) never promotes
  assert.equal(zoneFor(league, 0, 3, 3), "safe");
  assert.equal(zoneFor(league, 2, 1, 3), "safe");
  assert.equal(zoneFor(league, 1, 1, 3), "promotion");
  assert.equal(zoneFor(league, 1, 2, 3), "safe");
  assert.equal(zoneFor(league, 1, 3, 3), "demotion");
  // a lone member is not promoted just for showing up
  assert.equal(zoneFor(league, 0, 1, 1), "safe");
  // with two members the zones still never overlap
  assert.equal(zoneFor(league, 1, 1, 2), "promotion");
  assert.equal(zoneFor(league, 1, 2, 2), "demotion");
});

test("league config mistakes fail fast", () => {
  const base = { currencies: ["xp"] };
  assert.throws(() => resolveConfig({ ...base, leagues: [{ id: "l", currency: "xp", tiers: ["only"] }] }), /two tiers/);
  assert.throws(
    () => resolveConfig({ ...base, leagues: [{ id: "l", currency: "xp", tiers: ["a", "b"], groupSize: 4, promote: 3, demote: 2 }] }),
    /cannot exceed groupSize/,
  );
  assert.throws(() => resolveConfig({ ...base, leagues: [{ id: "l", currency: "gold", tiers: ["a", "b"] }] }), /unknown currency/);
});

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: groups fill up, then rounds settle into promotions and demotions`, async (t) => {
    let now = monday;
    const engine = new Engine(config, await makeStore(t), () => now);
    const win = (userId, value) => engine.track({ userId, event: "win", value });

    // Week 1, everyone starts in bronze. Groups hold 3.
    const first = await win("u1", 30);
    assert.deepEqual(first.leagues.arena, { tier: "bronze", group: 1, joined: true, previous: null });
    assert.equal((await win("u1", 0.5)).leagues.arena.joined, false, "second event the same week keeps the seat");
    await win("u2", 20);
    await win("u3", 10);
    assert.equal((await win("u4", 5)).leagues.arena.group, 2, "group 1 is full");
    await win("u5", 15);

    const g1 = await engine.league("arena", "u3");
    assert.equal(g1.tier, "bronze");
    assert.deepEqual(
      g1.group.entries.map((e) => [e.rank, e.userId, e.zone]),
      [
        [1, "u1", "promotion"],
        [2, "u2", "safe"],
        [3, "u3", "safe"], // bronze is the bottom tier
      ],
    );
    assert.deepEqual(g1.you, { rank: 3, userId: "u3", score: 10, zone: "safe" });
    assert.equal(g1.round.startsAt, "2026-11-16T00:00:00.000Z");
    assert.equal(g1.round.endsAt, "2026-11-23T00:00:00.000Z");

    // Week 2.
    now += 7 * DAY;
    const u1 = await win("u1", 40);
    assert.deepEqual(u1.leagues.arena, {
      tier: "silver",
      group: 1,
      joined: true,
      previous: { round: "2026-11-16", tier: "bronze", rank: 1, outcome: "promoted", nextTier: "silver" },
    });
    const u5 = await win("u5", 10);
    assert.equal(u5.leagues.arena.tier, "silver", "top of a 2-person group also goes up");
    assert.equal((await win("u2", 5)).leagues.arena.previous.outcome, "stayed");

    // u3 sat this week out: still bronze, no group yet, last result kept.
    const idle = await engine.league("arena", "u3");
    assert.equal(idle.tier, "bronze");
    assert.equal(idle.group, null);
    assert.equal(idle.you, null);
    assert.deepEqual(idle.previous, { round: "2026-11-16", tier: "bronze", rank: 3, outcome: "stayed", nextTier: "bronze" });

    const silver = await engine.league("arena", "u1");
    assert.deepEqual(
      silver.group.entries.map((e) => [e.userId, e.zone]),
      [
        ["u1", "promotion"],
        ["u5", "demotion"],
      ],
    );

    // Week 3: u1 reaches gold, u5 drops back to bronze.
    now += 7 * DAY;
    assert.equal((await win("u1", 1)).leagues.arena.tier, "gold");
    const down = await win("u5", 1);
    assert.equal(down.leagues.arena.tier, "bronze");
    assert.equal(down.leagues.arena.previous.outcome, "demoted");

    // Settling is stored once: asking again gives the same answer.
    assert.deepEqual((await engine.league("arena", "u5")).previous, down.leagues.arena.previous);
  });

  test(`${name}: events without points, or from a past round, do not seat anyone`, async (t) => {
    const engine = new Engine(
      { ...config, points: [...config.points, { event: "login", currency: "xp", amount: 0 }] },
      await makeStore(t),
      () => monday,
    );
    assert.deepEqual((await engine.track({ userId: "a", event: "login" })).leagues, {});
    const backfill = await engine.track({ userId: "a", event: "win", value: 50, timestamp: monday - 7 * DAY });
    assert.deepEqual(backfill.leagues, {}, "last week's points do not join this week's round");
    assert.equal((await engine.league("arena", "a")).group, null);
  });
}

test("unknown leagues are a 404", async () => {
  const engine = new Engine(config, new MemoryStore());
  await assert.rejects(engine.league("nope", "a"), (e) => e.status === 404);
});
