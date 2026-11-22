import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, createOnstreakServer } from "../dist/index.js";
import { createClient, OnstreakError } from "../../sdk/dist/index.js";
import { config } from "./fixtures.mjs";

const API_KEY = "test-key-0123456789";

async function withServer(fn) {
  const engine = new Engine(config, new MemoryStore());
  const server = createOnstreakServer(engine, { apiKey: API_KEY });
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://localhost:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("SDK talks to the server end to end", async () => {
  await withServer(async (baseUrl) => {
    const xp = createClient({ baseUrl, apiKey: API_KEY });
    const r = await xp.track({ userId: "maya", event: "lesson_completed" });
    assert.equal(r.points.xp.total, 10);
    assert.deepEqual(r.achievements.map((a) => a.id), ["first_lesson"]);

    const user = await xp.getUser("maya");
    assert.equal(user.points.coins, 1);
    assert.equal(user.streaks.daily_lesson.current, 1);

    const board = await xp.leaderboard("xp_all", { limit: 5, userId: "maya" });
    assert.deepEqual(board.user, { rank: 1, userId: "maya", score: 10, displayName: null, avatarUrl: null });

    assert.deepEqual(r.leagues.study_league, { tier: "bronze", group: 1, joined: true, previous: null });
    const league = await xp.league("study_league", "maya");
    assert.equal(league.tier, "bronze");
    assert.deepEqual(league.you, { rank: 1, userId: "maya", score: 10, displayName: null, avatarUrl: null, zone: "safe" });
  });
});

test("server rejects bad keys and bad requests", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200, "health needs no key");

    const wrong = createClient({ baseUrl, apiKey: "wrong-key-000000000" });
    await assert.rejects(wrong.getUser("x"), (e) => e instanceof OnstreakError && e.status === 401);

    const xp = createClient({ baseUrl, apiKey: API_KEY });
    await assert.rejects(xp.track({ userId: "a", event: "bad event" }), (e) => e.status === 400 && /event/.test(e.message));
    await assert.rejects(xp.leaderboard("missing"), (e) => e.status === 404);

    const notJson = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: "{oops",
    });
    assert.equal(notJson.status, 400);

    const unknown = await fetch(`${baseUrl}/v1/nothing`, { headers: { authorization: `Bearer ${API_KEY}` } });
    assert.equal(unknown.status, 404);
  });
});

test("server refuses short API keys", () => {
  assert.throws(() => createOnstreakServer(new Engine(config, new MemoryStore()), { apiKey: "short" }), /16 characters/);
});

test("SDK covers profiles, batches, history, health and request ids", async () => {
  await withServer(async (baseUrl) => {
    const xp = createClient({ baseUrl, apiKey: API_KEY });

    const updated = await xp.updateUser("zara", { displayName: "Zara", metadata: { plan: "pro" } });
    assert.equal(updated.profile.displayName, "Zara");
    assert.deepEqual(updated.profile.metadata, { plan: "pro" });

    const results = await xp.trackBatch([
      { userId: "zara", event: "lesson_completed" },
      { userId: "zara", event: "nope nope" },
    ]);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].result.points.xp.total, 10);
    assert.deepEqual({ ok: results[1].ok, status: results[1].status }, { ok: false, status: 400 });

    const history = await xp.events("zara", { limit: 10 });
    assert.equal(history.events.length, 1);
    assert.equal(history.nextCursor, null);

    const board = await xp.leaderboard("xp_all", { userId: "zara" });
    assert.equal(board.user.displayName, "Zara");

    assert.deepEqual(await xp.health(), { ok: true, database: "ok" });

    assert.equal((await xp.addFriend("zara", "omar")).created, true);
    assert.deepEqual((await xp.friends("omar")).friends.map((f) => [f.userId, f.displayName]), [["zara", "Zara"]]);
    assert.equal((await xp.removeFriend("omar", "zara")).removed, true);
    assert.deepEqual((await xp.friends("zara")).friends, []);

    assert.equal((await xp.addRival("weekly_duel", "zara", "omar")).created, true);
    const duel = await xp.rivals("weekly_duel", "omar");
    assert.equal(duel.rivals[0].rivalId, "zara");
    assert.deepEqual(duel.rivals[0].record, { wins: 0, losses: 0, draws: 0 });
    assert.equal((await xp.removeRival("weekly_duel", "omar", "zara")).removed, true);
    assert.deepEqual((await xp.quests("omar")).quests, [], "no quests configured");
    assert.deepEqual((await xp.calendars("omar")).calendars, [], "no calendars configured");
    assert.deepEqual(await xp.communityGoals({ userId: "omar" }), { goals: [] });
    assert.deepEqual(await xp.seasons({ userId: "omar" }), { seasons: [] });
    await xp.saveTeam("crew", { name: "Crew" });
    assert.equal((await xp.addTeamMember("crew", "omar")).created, true);
    assert.equal((await xp.userTeam("omar")).team.id, "crew");
    assert.equal((await xp.teamLeaderboard("xp_all")).entries[0].teamId, "crew");
    assert.equal((await xp.team("crew")).members.length, 1);
    assert.equal((await xp.removeTeamMember("crew", "omar")).removed, true);
    const noReferrals = await xp.referrals("omar").catch((e) => e);
    assert.equal(noReferrals.status, 404, "referrals are not configured here");

    const shop = await xp.store("zara");
    assert.equal(shop.wallet.coins, 1);
    const bought = await xp.purchase("zara", { item: "sticker", idempotencyKey: "s1" });
    assert.deepEqual([bought.owned, bought.wallet.coins], [1, 0]);
    assert.equal((await xp.purchases("zara", { limit: 5 })).purchases[0].item, "sticker");
    const back = await xp.refundPurchase("zara", bought.purchase.id);
    assert.deepEqual([back.refund.quantity, back.wallet.coins, back.purchase.refunded], [1, 1, 1]);
    await xp.purchase("zara", { item: "sticker" });
    const refused = await xp.purchase("zara", { item: "sticker" }).catch((e) => e);
    assert.ok(refused instanceof OnstreakError);
    assert.deepEqual([refused.status, refused.code], [409, "insufficient_funds"]);
    assert.deepEqual((await xp.getUser("zara")).inventory, { sticker: 1 });
    const used = await xp.useItem("zara", "sticker", { idempotencyKey: "u1" });
    assert.deepEqual([used.used, used.owned, used.effects], [1, 0, {}]);
    assert.equal((await xp.useItem("zara", "sticker", { idempotencyKey: "u1" })).duplicate, true);
    const boost = await xp.grantBoost("zara", { factor: 3, minutes: 5, reason: "support" });
    assert.deepEqual([boost.boost.factor, boost.boost.currency, boost.boosts.length], [3, null, 1]);
    assert.equal((await xp.getUser("zara")).boosts[0].reason, "support");
    const none = await xp.useItem("zara", "sticker").catch((e) => e);
    assert.deepEqual([none.status, none.code], [409, "not_owned"]);

    const err = await xp.updateUser("zara", { nickname: "z" }).catch((e) => e);
    assert.ok(err instanceof OnstreakError);
    assert.equal(err.status, 400);
    assert.match(err.requestId, /^[0-9a-f-]{36}$/, "errors carry the request id for support");
  });
});
