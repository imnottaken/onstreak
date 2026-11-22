import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, createOnstreakServer, signUserToken, verifyUserToken } from "../dist/index.js";
import { createClient } from "../../sdk/dist/index.js";
import { config } from "./fixtures.mjs";

const WRITE = "write-key-0123456789abcdef";
const READ = "read-key-0123456789abcdef";

async function serve(t, clock) {
  const engine = new Engine(config, new MemoryStore(), clock);
  const server = createOnstreakServer(engine, { apiKeys: [{ key: WRITE, scope: "write" }, { key: READ, scope: "read" }] });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.shutdown({ timeoutMs: 100 }));
  const base = `http://localhost:${server.address().port}`;
  const call = (bearer, method, path, body) =>
    fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({
      status: r.status,
      json: await r.json(),
    }));
  return { base, call };
}

test("a user token reads its own user and shared views, nothing else", async (t) => {
  let now = Date.now();
  const { call } = await serve(t, () => now);
  await call(WRITE, "POST", "/v1/events", { userId: "asha", event: "lesson_completed" });
  await call(WRITE, "POST", "/v1/events", { userId: "ravi", event: "lesson_completed" });
  const issued = await call(WRITE, "POST", "/v1/tokens", { userId: "asha", ttlSeconds: 600 });
  assert.equal(issued.status, 200);
  const { token } = issued.json;
  assert.match(token, /^ust_/);
  assert.equal(Date.parse(issued.json.expiresAt) - Math.floor(now / 1000) * 1000, 600_000);

  for (const path of ["/v1/users/asha", "/v1/users/asha/quests", "/v1/users/asha/achievements", "/v1/leaderboards/xp_all", "/v1/leaderboards/xp_all?userId=asha", "/v1/leagues/study_league/users/asha", "/v1/seasons", "/v1/community-goals?userId=asha"]) {
    assert.equal((await call(token, "GET", path)).status, 200, path);
  }
  for (const path of ["/v1/users/ravi", "/v1/users/ravi/quests", "/v1/leaderboards/xp_all?userId=ravi", "/v1/leagues/study_league/users/ravi", "/v1/users/asha/export", "/v1/streaks/daily_lesson/at-risk", "/v1/webhooks/deliveries"]) {
    const r = await call(token, "GET", path);
    assert.equal(r.status, 403, path);
  }
  const write = await call(token, "POST", "/v1/events", { userId: "asha", event: "lesson_completed" });
  assert.deepEqual([write.status, write.json.error], [403, "a user token can only read its own user"]);
  assert.equal((await call(token, "PATCH", "/v1/users/asha", { displayName: "A" })).status, 403);

  now += 601_000;
  const expired = await call(token, "GET", "/v1/users/asha");
  assert.deepEqual([expired.status, expired.json.error], [401, "user token is invalid or expired"]);
  assert.equal((await call(`${token.slice(0, -2)}xx`, "GET", "/v1/users/asha")).status, 401, "a changed signature");
  assert.equal((await call(signUserToken("some-other-secret-0123456789abcdef", "asha", now + 60_000), "GET", "/v1/users/asha")).status, 401, "signed elsewhere");
});

test("issuing tokens needs a write key and sane input", async (t) => {
  const { call } = await serve(t, Date.now);
  assert.equal((await call(READ, "POST", "/v1/tokens", { userId: "a" })).status, 403);
  for (const body of [{}, { userId: "has space" }, { userId: "a", ttlSeconds: 30 }, { userId: "a", ttlSeconds: 86_401 }, { userId: "a", ttlSeconds: "60" }]) {
    assert.equal((await call(WRITE, "POST", "/v1/tokens", body)).status, 400, JSON.stringify(body));
  }
});

test("the SDK issues tokens and reads with them", async (t) => {
  const { base, call } = await serve(t, Date.now);
  await call(WRITE, "POST", "/v1/events", { userId: "zara", event: "lesson_completed" });
  const server = createClient({ baseUrl: base, apiKey: WRITE });
  const { token } = await server.createToken("zara");
  const browser = createClient({ baseUrl: base, token });
  assert.equal((await browser.getUser("zara")).points.xp, 10);
  const err = await browser.track({ userId: "zara", event: "lesson_completed" }).catch((e) => e);
  assert.equal(err.status, 403);
  assert.throws(() => createClient({ baseUrl: base }), /apiKey or token/);
  assert.throws(() => createClient({ baseUrl: base, apiKey: WRITE, token }), /apiKey or token/);
});

test("tokens: round trip, expiry and tampering", () => {
  const secret = "s".repeat(40);
  const now = 1_800_000_000_000;
  const tok = signUserToken(secret, "user:1", now + 60_000);
  assert.equal(verifyUserToken(secret, tok, now), "user:1");
  assert.equal(verifyUserToken(secret, tok, now + 60_000), null);
  assert.equal(verifyUserToken("t".repeat(40), tok, now), null);
  assert.equal(verifyUserToken(secret, "ust_garbage", now), null);
  assert.equal(verifyUserToken(secret, "not-a-token", now), null);
});
