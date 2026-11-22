import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");
const config = {
  ...base,
  referrals: { referrer: [{ currency: "coins", amount: 5 }] },
  quests: [{ id: "two", name: "Two", period: "daily", goal: { event: "lesson_completed", target: 2 } }],
  calendars: [{ id: "login", event: "app_opened", days: [{ rewards: [{ currency: "coins", amount: 1 }] }] }],
  communityGoals: [{ id: "together", name: "Together", goal: { event: "lesson_completed", target: 1 }, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", rewards: [{ currency: "coins", amount: 1 }] }],
  teamGoals: [{ id: "tg", name: "TG", period: "weekly", goal: { event: "lesson_completed", target: 1 }, rewards: [{ currency: "coins", amount: 1 }] }],
  levels: { ...base.levels, prestige: {} },
  webhooks: [{ id: "all", url: "https://example.test/h", events: ["*"], secret: "whsec_0123456789abcdef" }],
};

/** Give `u` a bit of everything. */
async function busyUser(engine, u) {
  await engine.updateUser(u, { displayName: "Gone Soon", metadata: { country: "IN" } });
  await engine.addReferral(u, "host");
  await engine.addReferral("newbie", u);
  for (let i = 0; i < 6; i++) await engine.track({ userId: u, event: "lesson_completed", properties: { n: i } });
  await engine.track({ userId: u, event: "app_opened" });
  await engine.addFriend(u, "pal");
  await engine.addRival("weekly_duel", u, "pal");
  await engine.saveTeam("crew", { name: "Crew" });
  await engine.addTeamMember("crew", u);
  await engine.purchase(u, { item: "sticker" });
  await engine.useItem(u, "sticker");
  await engine.grantBoost(u, { factor: 2, minutes: 30 });
  await engine.communityGoals({ userId: u });
  await engine.teamGoals("crew", { userId: u });
  await engine.track({ userId: "pal", event: "lesson_completed" });
}

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: export holds everything about a user`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    await busyUser(engine, "gone");
    const x = await engine.exportUser("gone");
    assert.equal(x.user.profile.displayName, "Gone Soon");
    assert.equal(x.events.length, 7);
    assert.ok(x.events.some((e) => e.properties.n === 5));
    assert.deepEqual(x.purchases.map((p) => p.item), ["sticker"]);
    assert.deepEqual(x.friends.map((f) => f.userId), ["pal"]);
    assert.deepEqual(x.team.id, "crew");
    assert.deepEqual(x.referrals, { referredBy: "host", referred: ["newbie"] });
    assert.ok(x.user.boosts.length === 1 && x.user.achievements.length > 0);
  });

  test(`${name}: delete removes the user everywhere and leaves others alone`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    await busyUser(engine, "gone");
    assert.deepEqual(await engine.deleteUser("gone"), { userId: "gone", deleted: true });
    assert.deepEqual(await engine.deleteUser("gone"), { userId: "gone", deleted: false });

    const user = await engine.getUser("gone");
    assert.deepEqual([user.points.xp, user.achievements, user.profile.displayName, user.boosts], [0, [], null, []]);
    assert.deepEqual((await engine.events("gone")).events, []);
    assert.deepEqual((await engine.leaderboard("xp_all")).entries.map((e) => e.userId), ["pal"]);
    assert.deepEqual((await engine.friends("pal")).friends, []);
    assert.deepEqual((await engine.rivals("weekly_duel", "pal")).rivals, []);
    assert.deepEqual((await engine.team("crew")).members, []);
    assert.equal((await engine.referrals("newbie")).referredBy, null);
    assert.deepEqual((await engine.referrals("host")).referred, []);
    assert.equal((await engine.league("study_league", "pal")).group.entries.length, 1);
    assert.ok((await engine.webhookDeliveries({ limit: 100 })).deliveries.every((d) => d.userId !== "gone"));
    assert.equal((await engine.getUser("pal")).points.xp, 10, "others keep their points");

    // The id can be used again, starting from nothing.
    const fresh = await engine.track({ userId: "gone", event: "lesson_completed" });
    assert.deepEqual([fresh.points.xp.total, fresh.streaks.daily_lesson.current], [10, 1]);
  });
}
