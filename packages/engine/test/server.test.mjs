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
    assert.deepEqual(board.user, { rank: 1, userId: "maya", score: 10 });

    assert.deepEqual(r.leagues.study_league, { tier: "bronze", group: 1, joined: true, previous: null });
    const league = await xp.league("study_league", "maya");
    assert.equal(league.tier, "bronze");
    assert.deepEqual(league.you, { rank: 1, userId: "maya", score: 10, zone: "safe" });
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
