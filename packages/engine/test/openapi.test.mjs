import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Engine, MemoryStore, createOnstreakServer, packageVersion } from "../dist/index.js";
import { config } from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

const API_KEY = "openapi-test-key-0123456789";

async function serve(t, store = new MemoryStore(), cfg = config) {
  const engine = new Engine(cfg, store);
  const server = createOnstreakServer(engine, { apiKey: API_KEY });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.shutdown({ timeoutMs: 100 }));
  return { base: `http://localhost:${server.address().port}`, store };
}

/** Validates responses against the spec and records which operations were covered. */
function contract(spec) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...spec, $id: "spec" });
  const covered = new Set();
  return {
    covered,
    check(method, template, status, body) {
      const op = spec.paths[template]?.[method];
      assert.ok(op, `${method.toUpperCase()} ${template} is not in the spec`);
      const response = op.responses[String(status)];
      assert.ok(response, `${method.toUpperCase()} ${template} returned ${status}, which the spec does not list`);
      const schema = response.content["application/json"].schema;
      const validate = ajv.compile({ $ref: schema.$ref ? `spec${schema.$ref}` : undefined, ...(schema.$ref ? {} : schema) });
      const valid = validate(body);
      assert.ok(valid, `${method.toUpperCase()} ${template} ${status} does not match the spec:\n${ajv.errorsText(validate.errors, { separator: "\n" })}\n${JSON.stringify(body, null, 2).slice(0, 1500)}`);
      covered.add(`${method} ${template}`);
    },
  };
}

test("every response the server sends matches the OpenAPI spec", async (t) => {
  const { base, store } = await serve(t);
  const specRes = await fetch(`${base}/openapi.json`);
  assert.equal(specRes.status, 200, "the spec is public");
  const spec = await specRes.json();
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.version, packageVersion());

  const c = contract(spec);
  c.check("get", "/openapi.json", 200, spec);
  const call = async (method, path, template, body, { key = API_KEY } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: method.toUpperCase(),
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();
    c.check(method, template, res.status, json);
    return { status: res.status, json };
  };

  // Tracking, including a level-up, an achievement, a streak and a league seat.
  const first = await call("post", "/v1/events", "/v1/events", { userId: "asha", event: "lesson_completed", timezone: "Asia/Kolkata", idempotencyKey: "a1" });
  assert.equal(first.status, 200);
  assert.ok(first.json.achievements.length > 0 && first.json.leagues.study_league);
  await call("post", "/v1/events", "/v1/events", { userId: "asha", event: "lesson_completed", idempotencyKey: "a1" }); // duplicate
  await call("post", "/v1/events", "/v1/events", { userId: "asha", event: "app_opened", properties: { platform: "ios", build: 42, beta: false } });
  await call("post", "/v1/events", "/v1/events", { userId: "asha", event: "app_opened", properties: { nested: { a: 1 } } }); // 400
  await call("post", "/v1/events", "/v1/events", { userId: "asha", event: "minutes_studied", value: 30 }); // level up
  await call("post", "/v1/events", "/v1/events", { userId: "asha", event: "bad event" }); // 400
  await call("post", "/v1/events", "/v1/events", { userId: "asha", event: "x" }, { key: "wrong-key-0000000000000" }); // 401

  await call("post", "/v1/events/batch", "/v1/events/batch", {
    events: [{ userId: "ravi", event: "lesson_completed" }, { userId: "ravi", event: "bad event" }],
  });
  await call("post", "/v1/events/batch", "/v1/events/batch", { events: [] }); // 400

  await call("patch", "/v1/users/asha", "/v1/users/{userId}", { displayName: "Asha", avatarUrl: "https://example.com/a.png", metadata: { a: 1 } });
  await call("patch", "/v1/users/asha", "/v1/users/{userId}", { nickname: "x" }); // 400
  await call("get", "/v1/users/asha", "/v1/users/{userId}");
  await call("get", "/v1/users/never-seen", "/v1/users/{userId}");
  await call("get", "/v1/users/asha?locale=es", "/v1/users/{userId}");
  await call("get", "/v1/users/asha?locale=nope_nope", "/v1/users/{userId}"); // 400

  const page = await call("get", "/v1/users/asha/events?limit=2", "/v1/users/{userId}/events");
  await call("get", `/v1/users/asha/events?limit=2&cursor=${page.json.nextCursor}`, "/v1/users/{userId}/events");
  await call("get", "/v1/users/asha/events?limit=0", "/v1/users/{userId}/events"); // 400

  await call("get", "/v1/leaderboards/xp_all?userId=ravi", "/v1/leaderboards/{leaderboardId}");
  await call("get", "/v1/leaderboards/xp_weekly?limit=1", "/v1/leaderboards/{leaderboardId}");
  await call("get", "/v1/leaderboards/nope", "/v1/leaderboards/{leaderboardId}"); // 404
  await call("get", "/v1/leaderboards/xp_all?userId=asha&around=2", "/v1/leaderboards/{leaderboardId}");
  await call("get", "/v1/leaderboards/xp_all?segment=plan:pro", "/v1/leaderboards/{leaderboardId}");
  await call("get", "/v1/leaderboards/xp_all?segment=nocolon", "/v1/leaderboards/{leaderboardId}"); // 400
  await call("get", "/v1/leaderboards/xp_weekly/history?periods=2&top=1", "/v1/leaderboards/{leaderboardId}/history");
  await call("get", "/v1/leaderboards/xp_all/history", "/v1/leaderboards/{leaderboardId}/history"); // 400
  await call("get", "/v1/leaderboards/nope/history", "/v1/leaderboards/{leaderboardId}/history"); // 404
  await call("get", "/v1/streaks/daily_lesson/at-risk?limit=5&endingWithinHours=48", "/v1/streaks/{streakId}/at-risk");
  await call("get", "/v1/streaks/daily_lesson/at-risk?limit=0", "/v1/streaks/{streakId}/at-risk"); // 400
  await call("get", "/v1/streaks/nope/at-risk", "/v1/streaks/{streakId}/at-risk"); // 404
  await call("put", "/v1/users/asha/friends/maya", "/v1/users/{userId}/friends/{friendId}");
  const friendsBoard = await call("get", "/v1/leaderboards/xp_weekly?userId=asha&scope=friends", "/v1/leaderboards/{leaderboardId}");
  assert.deepEqual(friendsBoard.json.entries.map((e) => e.userId), ["asha", "maya"]);
  await call("get", "/v1/leaderboards/xp_weekly?scope=friends", "/v1/leaderboards/{leaderboardId}"); // 400

  await call("get", "/v1/leagues/study_league/users/asha", "/v1/leagues/{leagueId}/users/{userId}");
  await call("get", "/v1/leagues/study_league/users/never-seen", "/v1/leagues/{leagueId}/users/{userId}"); // no group yet
  await call("get", "/v1/leagues/nope/users/asha", "/v1/leagues/{leagueId}/users/{userId}"); // 404

  await call("put", "/v1/users/asha/friends/ravi", "/v1/users/{userId}/friends/{friendId}");
  await call("put", "/v1/users/ravi/friends/asha", "/v1/users/{userId}/friends/{friendId}"); // already friends
  await call("put", "/v1/users/asha/friends/asha", "/v1/users/{userId}/friends/{friendId}"); // 400
  await call("get", "/v1/users/asha/friends", "/v1/users/{userId}/friends");
  await call("delete", "/v1/users/asha/friends/ravi", "/v1/users/{userId}/friends/{friendId}");
  await call("delete", "/v1/users/asha/friends/ravi", "/v1/users/{userId}/friends/{friendId}"); // not friends

  // A second server with a tiny friend limit, to see the 409 shape.
  const small = await serve(t, new MemoryStore(), { ...config, friends: { max: 1 } });
  const add = (a, b) => fetch(`${small.base}/v1/users/${a}/friends/${b}`, { method: "PUT", headers: { authorization: `Bearer ${API_KEY}` } });
  await add("x", "y");
  const full = await add("x", "z");
  c.check("put", "/v1/users/{userId}/friends/{friendId}", full.status, await full.json());
  assert.equal(full.status, 409);

  await call("put", "/v1/rivalries/weekly_duel/users/asha/rivals/ravi", "/v1/rivalries/{rivalryId}/users/{userId}/rivals/{rivalId}");
  await call("put", "/v1/rivalries/weekly_duel/users/ravi/rivals/asha", "/v1/rivalries/{rivalryId}/users/{userId}/rivals/{rivalId}"); // already
  await call("put", "/v1/rivalries/nope/users/asha/rivals/ravi", "/v1/rivalries/{rivalryId}/users/{userId}/rivals/{rivalId}"); // 404
  await call("put", "/v1/rivalries/weekly_duel/users/asha/rivals/asha", "/v1/rivalries/{rivalryId}/users/{userId}/rivals/{rivalId}"); // 400
  const rivals = await call("get", "/v1/rivalries/weekly_duel/users/asha", "/v1/rivalries/{rivalryId}/users/{userId}");
  assert.equal(rivals.json.rivals[0].rivalId, "ravi");
  await call("get", "/v1/rivalries/nope/users/asha", "/v1/rivalries/{rivalryId}/users/{userId}"); // 404
  await call("delete", "/v1/rivalries/weekly_duel/users/asha/rivals/ravi", "/v1/rivalries/{rivalryId}/users/{userId}/rivals/{rivalId}");
  const smallRivals = await serve(t, new MemoryStore(), { ...config, rivalries: [{ id: "weekly_duel", currency: "xp", max: 1 }] });
  const rival = (a, b) => fetch(`${smallRivals.base}/v1/rivalries/weekly_duel/users/${a}/rivals/${b}`, { method: "PUT", headers: { authorization: `Bearer ${API_KEY}` } });
  await rival("x", "y");
  const tooMany = await rival("x", "z");
  c.check("put", "/v1/rivalries/{rivalryId}/users/{userId}/rivals/{rivalId}", tooMany.status, await tooMany.json());
  assert.equal(tooMany.status, 409);

  const questy = await serve(t, new MemoryStore(), { ...config, quests: [{ id: "two_lessons", name: "Two lessons", period: "daily", goal: { event: "lesson_completed", target: 2 }, rewards: [{ currency: "coins", amount: 3 }] }, { id: "xp_goal", name: "Earn XP", period: "weekly", goal: { points: "xp", target: 1000 } }, { id: "first", name: "First", period: "once", goal: { event: "lesson_completed", target: 1 } }, { id: "next", name: "Next", period: "once", after: "first", goal: { event: "lesson_completed", target: 3 } }, { id: "mission", name: "Mission", period: "daily", goals: [{ event: "lesson_completed", target: 2 }, { points: "xp", target: 500 }] }] });
  const questCall = async (method, path, template, body) => {
    const res = await fetch(`${questy.base}${path}`, { method: method.toUpperCase(), headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json();
    c.check(method, template, res.status, json);
    return json;
  };
  await questCall("post", "/v1/events", "/v1/events", { userId: "q", event: "lesson_completed" });
  const finished = await questCall("post", "/v1/events", "/v1/events", { userId: "q", event: "lesson_completed" });
  assert.equal(finished.quests.two_lessons.completed, true);
  const questList = await questCall("get", "/v1/users/q/quests", "/v1/users/{userId}/quests");
  assert.equal(questList.quests[0].completed, true);
  await questCall("get", "/v1/users/q/quests?timezone=UTC", "/v1/users/{userId}/quests");
  await questCall("get", "/v1/users/q/quests?timezone=Nope", "/v1/users/{userId}/quests"); // 400

  // Reward store: asha has 1 coin from her one counted lesson.
  const shop = await call("get", "/v1/users/asha/store", "/v1/users/{userId}/store");
  assert.equal(shop.json.wallet.coins, 1);
  const bought = await call("post", "/v1/users/asha/purchases", "/v1/users/{userId}/purchases", { item: "sticker", idempotencyKey: "p1" });
  assert.equal(bought.status, 200);
  await call("post", "/v1/users/asha/purchases", "/v1/users/{userId}/purchases", { item: "sticker", idempotencyKey: "p1" }); // duplicate
  const broke = await call("post", "/v1/users/asha/purchases", "/v1/users/{userId}/purchases", { item: "sticker" });
  assert.deepEqual([broke.status, broke.json.code], [409, "insufficient_funds"]);
  await call("post", "/v1/users/asha/purchases", "/v1/users/{userId}/purchases", { item: "gold_frame" });
  const capped = await call("post", "/v1/users/asha/purchases", "/v1/users/{userId}/purchases", { item: "gold_frame" });
  assert.deepEqual([capped.status, capped.json.code], [409, "limit_reached"]);
  await call("post", "/v1/users/asha/purchases", "/v1/users/{userId}/purchases", { item: "nope" }); // 404
  await call("post", "/v1/users/asha/purchases", "/v1/users/{userId}/purchases", { item: "sticker", quantity: 0 }); // 400
  const refundPath = (id) => `/v1/users/asha/purchases/${id}/refund`;
  const refundTpl = "/v1/users/{userId}/purchases/{purchaseId}/refund";
  const refunded = await call("post", refundPath(bought.json.purchase.id), refundTpl, {});
  assert.deepEqual([refunded.json.refund.amount, refunded.json.wallet.coins], [1, 1]);
  const twice = await call("post", refundPath(bought.json.purchase.id), refundTpl);
  assert.deepEqual([twice.status, twice.json.code], [409, "already_refunded"]);
  await call("post", refundPath("00000000-0000-4000-8000-000000000000"), refundTpl, {}); // 404
  await call("post", refundPath("not-a-uuid"), refundTpl, {}); // 404
  await call("post", "/v1/users/asha/purchases", "/v1/users/{userId}/purchases", { item: "sticker" }); // buy it again with the refund
  const history = await call("get", "/v1/users/asha/purchases?limit=1", "/v1/users/{userId}/purchases");
  await call("get", `/v1/users/asha/purchases?limit=1&cursor=${history.json.nextCursor}`, "/v1/users/{userId}/purchases");
  await call("get", "/v1/users/asha", "/v1/users/{userId}"); // with a wallet and inventory
  const use = await call("post", "/v1/users/asha/inventory/sticker/use", "/v1/users/{userId}/inventory/{itemId}/use", { idempotencyKey: "u1" });
  assert.equal(use.json.owned, 0);
  await call("post", "/v1/users/asha/inventory/sticker/use", "/v1/users/{userId}/inventory/{itemId}/use", { idempotencyKey: "u1" }); // duplicate
  const notOwned = await call("post", "/v1/users/asha/inventory/sticker/use", "/v1/users/{userId}/inventory/{itemId}/use");
  assert.deepEqual([notOwned.status, notOwned.json.code], [409, "not_owned"]);
  await call("post", "/v1/users/asha/inventory/nope/use", "/v1/users/{userId}/inventory/{itemId}/use", {}); // 404
  await call("post", "/v1/users/asha/inventory/sticker/use", "/v1/users/{userId}/inventory/{itemId}/use", { quantity: 0 }); // 400
  // A streak freeze: asha holds 1 of max 2, so one more fits.
  const rich = await serve(t, new MemoryStore());
  const richCall = async (path, body) => {
    const res = await fetch(`${rich.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    c.check("post", path.endsWith("/use") ? "/v1/users/{userId}/inventory/{itemId}/use" : "/v1/users/{userId}/purchases", res.status, json);
    return json;
  };
  await Promise.all(Array.from({ length: 10 }, () => fetch(`${rich.base}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ userId: "r", event: "lesson_completed" }) })));
  await richCall("/v1/users/r/purchases", { item: "streak_freeze", quantity: 2 });
  const frozen = await richCall("/v1/users/r/inventory/streak_freeze/use", {});
  assert.deepEqual(frozen.effects, { streakFreeze: { streak: "daily_lesson", freezes: 2 } });
  const granted = await call("post", "/v1/users/asha/boosts", "/v1/users/{userId}/boosts", { factor: 2, minutes: 60, currency: "xp", reason: "welcome_back", idempotencyKey: "b1" });
  assert.equal(granted.json.boosts.length, 1);
  await call("post", "/v1/users/asha/boosts", "/v1/users/{userId}/boosts", { factor: 2, minutes: 60, currency: "xp", idempotencyKey: "b1" }); // duplicate
  await call("post", "/v1/users/asha/boosts", "/v1/users/{userId}/boosts", { factor: 0, minutes: 60 }); // 400
  await call("get", "/v1/users/asha", "/v1/users/{userId}"); // with a boost
  const boosted = await call("post", "/v1/events", "/v1/events", { userId: "asha", event: "lesson_completed" });
  assert.equal(boosted.json.points.xp.awarded, 20);
  const maxed = await richCall("/v1/users/r/inventory/streak_freeze/use", {});
  assert.equal(maxed.code, "limit_reached");

  const cal = await serve(t, new MemoryStore(), { ...config, calendars: [{ id: "login", name: "Daily login", event: "app_opened", days: [{ rewards: [{ currency: "coins", amount: 5 }] }, { rewards: [] }] }] });
  const calCall = async (method, path, template, body) => {
    const res = await fetch(`${cal.base}${path}`, { method: method.toUpperCase(), headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json();
    c.check(method, template, res.status, json);
    return json;
  };
  const claim = await calCall("post", "/v1/events", "/v1/events", { userId: "c", event: "app_opened" });
  assert.deepEqual(claim.calendars.login, { day: 1, rewards: [{ currency: "coins", amount: 5 }] });
  const calendars = await calCall("get", "/v1/users/c/calendars", "/v1/users/{userId}/calendars");
  assert.equal(calendars.calendars[0].claimedToday, true);
  await calCall("get", "/v1/users/c/calendars?timezone=Nope", "/v1/users/{userId}/calendars"); // 400

  await call("get", "/v1/users/asha/referrals", "/v1/users/{userId}/referrals"); // 404: not configured
  await call("put", "/v1/users/asha/referred-by/ravi", "/v1/users/{userId}/referred-by/{referrerId}"); // 404: not configured
  const refs = await serve(t, new MemoryStore(), { ...config, referrals: { referrer: [{ currency: "coins", amount: 10 }], referred: [{ currency: "coins", amount: 5 }], qualify: { event: "lesson_completed", target: 2 }, max: 1 } });
  const refCall = async (method, path, template) => {
    const res = await fetch(`${refs.base}${path}`, { method: method.toUpperCase(), headers: { authorization: `Bearer ${API_KEY}` } });
    const json = await res.json();
    c.check(method, template, res.status, json);
    return { status: res.status, json };
  };
  const linked = await refCall("put", "/v1/users/new1/referred-by/host", "/v1/users/{userId}/referred-by/{referrerId}");
  assert.deepEqual([linked.json.created, linked.json.qualified], [true, false]);
  await refCall("put", "/v1/users/new1/referred-by/host", "/v1/users/{userId}/referred-by/{referrerId}"); // already, same referrer
  const other = await refCall("put", "/v1/users/new1/referred-by/someone", "/v1/users/{userId}/referred-by/{referrerId}");
  assert.deepEqual([other.status, other.json.code], [409, "already_referred"]);
  await refCall("put", "/v1/users/host/referred-by/host", "/v1/users/{userId}/referred-by/{referrerId}"); // 400
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${refs.base}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ userId: "new1", event: "lesson_completed" }) });
    const json = await res.json();
    c.check("post", "/v1/events", res.status, json);
    if (i === 1) assert.deepEqual(json.referral, { referrerId: "host", rewards: [{ currency: "coins", amount: 5 }] });
  }
  const hostRefs = await refCall("get", "/v1/users/host/referrals", "/v1/users/{userId}/referrals");
  assert.deepEqual([hostRefs.json.rewarded, hostRefs.json.referred[0].rewarded], [1, true]);
  await refCall("get", "/v1/users/new1/referrals", "/v1/users/{userId}/referrals");

  await call("get", "/v1/community-goals", "/v1/community-goals"); // none configured
  await call("put", "/v1/teams/owls", "/v1/teams/{teamId}", { name: "Owls" });
  await call("put", "/v1/teams/owls", "/v1/teams/{teamId}", { name: "" }); // 400
  await call("put", "/v1/teams/owls/members/asha", "/v1/teams/{teamId}/members/{userId}");
  await call("put", "/v1/teams/larks", "/v1/teams/{teamId}", { name: "Larks" });
  const twoTeams = await call("put", "/v1/teams/larks/members/asha", "/v1/teams/{teamId}/members/{userId}");
  assert.deepEqual([twoTeams.status, twoTeams.json.code], [409, "already_in_team"]);
  await call("put", "/v1/teams/nope/members/asha", "/v1/teams/{teamId}/members/{userId}"); // 404
  await call("get", "/v1/teams/owls?leaderboard=xp_all", "/v1/teams/{teamId}");
  await call("get", "/v1/teams/owls", "/v1/teams/{teamId}");
  await call("get", "/v1/teams/nope", "/v1/teams/{teamId}"); // 404
  await call("get", "/v1/users/asha/achievements", "/v1/users/{userId}/achievements");
  await call("post", "/v1/users/asha/prestige", "/v1/users/{userId}/prestige"); // 404: not configured here
  const prestigious = await serve(t, new MemoryStore(), { ...config, levels: { currency: "xp", thresholds: [5], prestige: {} } });
  const pres = async (path, method = "POST", body) => {
    const res = await fetch(`${prestigious.base}${path}`, { method, headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json() };
  };
  const early = await pres("/v1/users/p/prestige");
  c.check("post", "/v1/users/{userId}/prestige", early.status, early.json);
  assert.equal(early.json.code, "not_max_level");
  await pres("/v1/events", "POST", { userId: "p", event: "lesson_completed" });
  const done = await pres("/v1/users/p/prestige");
  c.check("post", "/v1/users/{userId}/prestige", done.status, done.json);
  assert.equal(done.json.prestige, 1);
  await call("get", "/v1/users/asha/team", "/v1/users/{userId}/team");
  await call("get", "/v1/teams/owls/goals?userId=asha", "/v1/teams/{teamId}/goals"); // none configured here
  await call("get", "/v1/teams/nope/goals", "/v1/teams/{teamId}/goals"); // 404
  const teamy = await serve(t, new MemoryStore(), { ...config, teamGoals: [{ id: "tg", name: "Together", period: "weekly", goal: { event: "lesson_completed", target: 1 }, rewards: [{ currency: "coins", amount: 1 }] }] });
  const teamyCall = (method, path, body) => fetch(`${teamy.base}${path}`, { method, headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await teamyCall("PUT", "/v1/teams/t1", { name: "T1" });
  await teamyCall("PUT", "/v1/teams/t1/members/m1");
  await teamyCall("POST", "/v1/events", { userId: "m1", event: "lesson_completed" });
  const tgRes = await teamyCall("GET", "/v1/teams/t1/goals?userId=m1");
  const tg = await tgRes.json();
  c.check("get", "/v1/teams/{teamId}/goals", tgRes.status, tg);
  assert.deepEqual([tg.goals[0].completed, tg.goals[0].you.paidNow.length], [true, 1]);
  await call("get", "/v1/leaderboards/xp_all/teams?teamId=larks", "/v1/leaderboards/{leaderboardId}/teams");
  await call("get", "/v1/leaderboards/nope/teams", "/v1/leaderboards/{leaderboardId}/teams"); // 404
  await call("delete", "/v1/teams/owls/members/asha", "/v1/teams/{teamId}/members/{userId}");
  await call("delete", "/v1/teams/nope/members/asha", "/v1/teams/{teamId}/members/{userId}"); // 404
  await call("get", "/v1/users/asha/team", "/v1/users/{userId}/team"); // no team
  const seasonal = await serve(t, new MemoryStore(), {
    ...config,
    seasons: [
      { id: "forever", name: "Forever", currency: "xp", from: "2020-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z", rewards: [{ top: 1, title: "Champion", rewards: [{ currency: "coins", amount: 5 }] }] },
      { id: "old", name: "Old", currency: "xp", from: "2020-01-01T00:00:00Z", to: "2021-01-01T00:00:00Z" },
    ],
  });
  const seasonCall = async (path, template) => {
    const res = await fetch(`${seasonal.base}${path}`, { headers: { authorization: `Bearer ${API_KEY}` } });
    const json = await res.json();
    c.check("get", template, res.status, json);
    return json;
  };
  await fetch(`${seasonal.base}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ userId: "s", event: "lesson_completed" }) });
  const seasonsList = await seasonCall("/v1/seasons?userId=s", "/v1/seasons");
  assert.deepEqual([seasonsList.seasons[0].you.rank, seasonsList.seasons[0].you.award.title, seasonsList.seasons[1].status], [1, "Champion", "ended"]);
  await seasonCall("/v1/seasons", "/v1/seasons");
  const standings = await seasonCall("/v1/seasons/forever/standings?userId=s&limit=5", "/v1/seasons/{seasonId}/standings");
  assert.deepEqual([standings.final, standings.user.score], [false, 10]);
  await seasonCall("/v1/seasons/old/standings", "/v1/seasons/{seasonId}/standings");
  await seasonCall("/v1/seasons/nope/standings", "/v1/seasons/{seasonId}/standings"); // 404
  const together = await serve(t, new MemoryStore(), { ...config, communityGoals: [{ id: "minutes", name: "A thousand minutes", description: "Together", goal: { event: "minutes_studied", target: 50 }, from: "2020-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z", rewards: [{ currency: "coins", amount: 3 }] }] });
  const goalCall = async (path, body) => {
    const res = await fetch(`${together.base}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json();
    c.check(body ? "post" : "get", body ? "/v1/events" : "/v1/community-goals", res.status, json);
    return json;
  };
  await goalCall("/v1/events", { userId: "g", event: "minutes_studied", value: 60 });
  const goals = await goalCall("/v1/community-goals?userId=g");
  assert.deepEqual([goals.goals[0].completed, goals.goals[0].you.paidNow], [true, [{ currency: "coins", amount: 3 }]]);
  await goalCall("/v1/community-goals");
  await goalCall("/v1/community-goals?userId=bad%20id"); // 400

  await call("post", "/v1/users/asha/streaks/daily_lesson/repair", "/v1/users/{userId}/streaks/{streakId}/repair"); // 400: no repair rule
  const fixable = await serve(t, new MemoryStore(), { ...config, streaks: [{ ...config.streaks[0], repair: { withinHours: 72, cost: { currency: "coins", amount: 1 } } }] });
  const fixCall = async (method, path, template, body) => {
    const res = await fetch(`${fixable.base}${path}`, { method: method.toUpperCase(), headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json();
    c.check(method, template, res.status, json);
    return { status: res.status, json };
  };
  await fixCall("post", "/v1/events", "/v1/events", { userId: "f", event: "lesson_completed", timestamp: Date.now() - 5 * 86_400_000 });
  const brokenUser = await fixCall("get", "/v1/users/f", "/v1/users/{userId}");
  assert.equal(brokenUser.json.streaks.daily_lesson.status, "broken");
  assert.ok(brokenUser.json.streaks.daily_lesson.repairableUntil);
  const fixed = await fixCall("post", "/v1/users/f/streaks/daily_lesson/repair", "/v1/users/{userId}/streaks/{streakId}/repair");
  assert.deepEqual([fixed.json.status, fixed.json.cost], ["pending", { currency: "coins", amount: 1 }]);
  const again = await fixCall("post", "/v1/users/f/streaks/daily_lesson/repair", "/v1/users/{userId}/streaks/{streakId}/repair");
  assert.deepEqual([again.status, again.json.code], [409, "not_broken"]);
  await fixCall("post", "/v1/users/f/streaks/nope/repair", "/v1/users/{userId}/streaks/{streakId}/repair"); // 404

  await call("get", "/health", "/health", undefined, { key: null });
  store.ping = async () => {
    throw new Error("down");
  };
  await call("get", "/health", "/health", undefined, { key: null }); // 503
  await call("get", "/health/live", "/health/live", undefined, { key: null });

  // Every documented operation was exercised at least once.
  const documented = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item).filter((k) => ["get", "post", "patch", "put", "delete"].includes(k)).map((m) => `${m} ${path}`),
  );
  assert.deepEqual(documented.filter((op) => !c.covered.has(op)), [], "operations in the spec that no test exercised");
});

test("the spec references only schemas it defines", async (t) => {
  const { base } = await serve(t);
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((name) => !spec.components.schemas[name]);
  assert.deepEqual(missing, []);
  const unused = Object.keys(spec.components.schemas).filter((name) => !refs.includes(name));
  assert.deepEqual(unused, [], "schemas nothing uses");
  const ids = Object.values(spec.paths).flatMap((item) => Object.values(item).map((op) => op.operationId).filter(Boolean));
  assert.equal(new Set(ids).size, ids.length, "operationIds are unique");
});

test("the contract check really catches drift", async (t) => {
  const { base } = await serve(t);
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  const res = await fetch(`${base}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ userId: "d", event: "lesson_completed" }),
  });
  const good = await res.json();
  const c = contract(spec);
  c.check("post", "/v1/events", 200, good); // sanity: the real body passes

  const { leagues: _dropped, ...missingField } = good;
  for (const [label, body] of [
    ["an undocumented extra field", { ...good, surprise: 1 }],
    ["a missing required field", missingField],
    ["a wrong type", { ...good, duplicate: "no" }],
    ["a bad nested value", { ...good, points: { xp: { awarded: "10", total: 10 } } }],
  ]) {
    assert.throws(() => c.check("post", "/v1/events", 200, body), /does not match the spec/, label);
  }
  assert.throws(() => c.check("post", "/v1/events", 418, good), /which the spec does not list/);
});
