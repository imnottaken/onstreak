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

  const page = await call("get", "/v1/users/asha/events?limit=2", "/v1/users/{userId}/events");
  await call("get", `/v1/users/asha/events?limit=2&cursor=${page.json.nextCursor}`, "/v1/users/{userId}/events");
  await call("get", "/v1/users/asha/events?limit=0", "/v1/users/{userId}/events"); // 400

  await call("get", "/v1/leaderboards/xp_all?userId=ravi", "/v1/leaderboards/{leaderboardId}");
  await call("get", "/v1/leaderboards/xp_weekly?limit=1", "/v1/leaderboards/{leaderboardId}");
  await call("get", "/v1/leaderboards/nope", "/v1/leaderboards/{leaderboardId}"); // 404
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
