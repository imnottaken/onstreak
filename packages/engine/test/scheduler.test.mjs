import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

const SECRET = "whsec_test_0123456789abcdef";
const at = (day, hour) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`);
const config = {
  ...base,
  defaultTimezone: "UTC",
  streaks: [{ ...base.streaks[0], remindBeforeHours: 6 }],
  seasons: [
    { id: "autumn", name: "Autumn", currency: "xp", from: "2026-11-01T00:00:00Z", to: "2026-11-17T00:00:00Z" },
    { id: "old", name: "Old", currency: "xp", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
  ],
  webhooks: [{ id: "all", url: "https://example.test/hook", events: ["*"], secret: SECRET }],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: reminders go out once per period, close to its end`, async (t) => {
    let now = at(16, 10); // Monday
    const engine = new Engine(config, await makeStore(t), () => now);
    await engine.track({ userId: "a", event: "lesson_completed" });
    await engine.track({ userId: "b", event: "lesson_completed" });
    const types = async () => (await engine.webhookDeliveries({ limit: 100 })).deliveries.filter((d) => d.type === "streak.at_risk");

    now = at(17, 10); // Tuesday morning: 14 hours left
    assert.equal((await engine.runScheduledJobs()).reminders, 0);
    await engine.track({ userId: "b", event: "lesson_completed" }); // b is done today
    now = at(17, 19); // 5 hours left
    assert.equal((await engine.runScheduledJobs()).reminders, 1);
    assert.equal((await engine.runScheduledJobs()).reminders, 0, "once per period");
    let sent = await types();
    assert.deepEqual(sent.map((d) => [d.userId, d.payload.data.endsAt, d.payload.data.lastChance]), [["a", "2026-11-18T00:00:00.000Z", false]]);
    assert.equal(sent[0].payload.eventId, null);

    now = at(18, 20); // Wednesday evening: a missed Tuesday, the freeze covers it, so today is the last chance
    assert.equal((await engine.runScheduledJobs()).reminders, 2, "a again, and b, who has not acted today");
    sent = await types();
    const last = sent.find((d) => d.userId === "a" && d.payload.data.endsAt === "2026-11-19T00:00:00.000Z");
    assert.equal(last.payload.data.lastChance, true);
  });

  test(`${name}: a season end is announced once, with its top 3`, async (t) => {
    let now = at(18, 10);
    const engine = new Engine(config, await makeStore(t), () => now);
    let r = await engine.runScheduledJobs();
    assert.deepEqual(r, { reminders: 0, seasonsEnded: 1 }, "autumn ended yesterday; old ended too long ago");
    assert.equal((await engine.runScheduledJobs()).seasonsEnded, 0);
    const d = (await engine.webhookDeliveries()).deliveries.find((x) => x.type === "season.ended");
    assert.deepEqual([d.payload.data.season, d.payload.userId, d.userId], ["autumn", null, ""]);
    assert.deepEqual(d.payload.data.top, []);
  });

  test(`${name}: nothing is scheduled without a webhook that wants it`, async (t) => {
    const engine = new Engine({ ...config, webhooks: [{ ...config.webhooks[0], events: ["level.up"] }] }, await makeStore(t), () => at(18, 10));
    await engine.track({ userId: "a", event: "lesson_completed", timestamp: at(17, 10) });
    assert.deepEqual(await engine.runScheduledJobs(), { reminders: 0, seasonsEnded: 0 });
  });
}

test("remindBeforeHours is validated", () => {
  for (const remindBeforeHours of [0, -1, 745, "6"]) {
    assert.throws(() => resolveConfig({ ...config, streaks: [{ ...base.streaks[0], remindBeforeHours }] }), /remindBeforeHours/);
  }
});
