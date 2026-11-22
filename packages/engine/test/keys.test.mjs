import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, createOnstreakServer } from "../dist/index.js";
import { config } from "./fixtures.mjs";

const ADMIN = "admin-key-0123456789abcdef";
const READ = "read-key-0123456789abcdef";
const WRITE = "write-key-0123456789abcdef";
const NEXT = "next-write-key-0123456789";

async function serve(t, options) {
  const server = createOnstreakServer(new Engine(config, new MemoryStore()), options);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.shutdown({ timeoutMs: 100 }));
  const base = `http://localhost:${server.address().port}`;
  return (key, method, path, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
}

test("scoped keys: read only reads, write does app work, admin does the rest", async (t) => {
  const call = await serve(t, { apiKey: ADMIN, apiKeys: [{ key: READ, scope: "read" }, { key: WRITE, scope: "write" }] });
  const tracked = await call(WRITE, "POST", "/v1/events", { userId: "u", event: "lesson_completed" });
  assert.equal(tracked.status, 200);
  assert.equal((await call(READ, "GET", "/v1/users/u")).status, 200);
  assert.equal((await call(READ, "GET", "/v1/leaderboards/xp_all")).status, 200);

  const denied = await call(READ, "POST", "/v1/events", { userId: "u", event: "lesson_completed" });
  assert.deepEqual([denied.status, denied.json.error], [403, "this key can only read (GET)"]);
  assert.equal((await call(READ, "PATCH", "/v1/users/u", { displayName: "U" })).status, 403);

  for (const [method, path, body] of [
    ["GET", "/v1/users/u/export"],
    ["DELETE", "/v1/users/u"],
    ["POST", `/v1/users/u/events/${tracked.json.eventId}/reverse`],
    ["DELETE", "/v1/users/u/achievements/first_lesson"],
    ["POST", "/v1/config/preview", config],
    ["GET", "/v1/webhooks/deliveries"],
  ]) {
    const r = await call(WRITE, method, path, body);
    assert.deepEqual([r.status, r.json.error], [403, "this needs an admin key"], `${method} ${path}`);
    assert.equal((await call(READ, method, path, body)).status, 403);
  }
  assert.equal((await call(WRITE, "PUT", "/v1/users/u/friends/v")).status, 200, "write can do app work");
  assert.equal((await call(ADMIN, "GET", "/v1/users/u/export")).status, 200);
  assert.equal((await call(ADMIN, "DELETE", "/v1/users/u")).status, 200);
  assert.equal((await call("nope-not-a-key-0000000", "GET", "/v1/users/u")).status, 401);
});

test("several keys of one scope make rotation easy", async (t) => {
  const call = await serve(t, { apiKeys: [{ key: WRITE, scope: "write" }, { key: NEXT, scope: "write" }] });
  assert.equal((await call(WRITE, "GET", "/v1/users/a")).status, 200);
  assert.equal((await call(NEXT, "GET", "/v1/users/a")).status, 200);
  assert.equal((await call(ADMIN, "GET", "/v1/users/a")).status, 401, "no admin key configured");
});

test("key options are checked", () => {
  const make = (o) => () => createOnstreakServer(new Engine(config, new MemoryStore()), o);
  assert.throws(make({}), /apiKey or apiKeys/);
  assert.throws(make({ apiKeys: [{ key: "short", scope: "read" }] }), /16 characters/);
  assert.throws(make({ apiKeys: [{ key: READ, scope: "root" }] }), /read, write or admin/);
});
