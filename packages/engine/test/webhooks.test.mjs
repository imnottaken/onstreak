import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Engine, PostgresStore, fromPgPool, resolveConfig, signWebhook, verifyWebhookSignature, MAX_WEBHOOK_ATTEMPTS } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const SECRET = "whsec_test_0123456789abcdef";
const start = Date.parse("2026-11-16T06:00:00Z");

/** A local receiver that records what it gets and answers with `status`. */
async function receiver(t, status = 200) {
  const got = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      res.writeHead(status).end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://localhost:${server.address().port}/hooks`, got };
}

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: events queue signed webhooks that are delivered once`, async (t) => {
    const hook = await receiver(t);
    const config = { ...base, webhooks: [{ id: "all", url: hook.url, events: ["*"], secret: SECRET }, { id: "levels", url: hook.url, events: ["level.up"], secret: SECRET }] };
    const engine = new Engine(config, await makeStore(t), () => start);
    await engine.track({ userId: "asha", event: "lesson_completed", idempotencyKey: "k1" });
    await engine.track({ userId: "asha", event: "lesson_completed", idempotencyKey: "k1" }); // duplicate: nothing new

    let log = await engine.webhookDeliveries();
    assert.deepEqual(log.deliveries.map((d) => [d.webhookId, d.type, d.status]).sort(), [["all", "achievement.unlocked", "pending"], ["all", "streak.extended", "pending"]]);

    const r = await engine.deliverWebhooks();
    assert.deepEqual(r, { attempted: 2, delivered: 2, failed: 0 });
    assert.equal(hook.got.length, 2);
    for (const g of hook.got) {
      assert.ok(verifyWebhookSignature(SECRET, g.body, g.headers["onstreak-signature"], { now: start }), "signature checks out (signed on the engine clock)");
      const payload = JSON.parse(g.body);
      assert.equal(payload.userId, "asha");
      assert.equal(g.headers["onstreak-event"], payload.type);
      assert.equal(g.headers["onstreak-delivery"], payload.id);
    }
    const unlocked = hook.got.map((g) => JSON.parse(g.body)).find((p) => p.type === "achievement.unlocked");
    assert.equal(unlocked.data.id, "first_lesson");

    assert.deepEqual(await engine.deliverWebhooks(), { attempted: 0, delivered: 0, failed: 0 }, "nothing left");
    log = await engine.webhookDeliveries({ status: "delivered" });
    assert.equal(log.deliveries.length, 2);
    assert.ok(log.deliveries.every((d) => d.deliveredAt && d.attempts === 1 && d.nextAttemptAt === null));

    // Level ups go to both hooks.
    await engine.track({ userId: "asha", event: "minutes_studied", value: 10 }); // 30 xp: level 2
    log = await engine.webhookDeliveries({ status: "pending" });
    assert.deepEqual(log.deliveries.filter((d) => d.type === "level.up").map((d) => d.webhookId).sort(), ["all", "levels"]);
  });

  test(`${name}: failed deliveries retry with backoff, then give up`, async (t) => {
    let now = start;
    const config = { ...base, webhooks: [{ id: "flaky", url: "https://example.test/hook", events: ["achievement.unlocked"], secret: SECRET }] };
    const engine = new Engine(config, await makeStore(t), () => now);
    await engine.track({ userId: "a", event: "lesson_completed" });
    let calls = 0;
    const failing = async () => {
      calls++;
      return new Response("nope", { status: 503 });
    };
    let r = await engine.deliverWebhooks({ fetch: failing });
    assert.deepEqual(r, { attempted: 1, delivered: 0, failed: 0 });
    let d = (await engine.webhookDeliveries()).deliveries[0];
    assert.deepEqual([d.status, d.attempts, d.lastError, d.nextAttemptAt], ["pending", 1, "HTTP 503", new Date(start + 30_000).toISOString()]);
    assert.equal((await engine.deliverWebhooks({ fetch: failing })).attempted, 0, "not due yet");

    for (let i = 2; i <= MAX_WEBHOOK_ATTEMPTS; i++) {
      now += 7 * 3_600_000;
      r = await engine.deliverWebhooks({ fetch: async () => { throw new Error("connection refused"); } });
      assert.equal(r.attempted, 1);
    }
    d = (await engine.webhookDeliveries()).deliveries[0];
    assert.deepEqual([d.status, d.attempts, d.lastError], ["failed", MAX_WEBHOOK_ATTEMPTS, "connection refused"]);
    assert.equal(calls, 1);
    now += 7 * 3_600_000;
    assert.equal((await engine.deliverWebhooks({ fetch: failing })).attempted, 0, "failed ones are not retried");

    // A webhook removed from the config fails its pending deliveries.
    const later = new Engine({ ...config, webhooks: [] }, engine["store"], () => now);
    await new Engine(config, engine["store"], () => now).track({ userId: "b", event: "lesson_completed" });
    r = await later.deliverWebhooks({ fetch: failing });
    assert.deepEqual([r.attempted, r.failed], [1, 1]);
  });
}

test("signatures: tampering and replays are rejected", () => {
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const header = signWebhook(SECRET, '{"a":1}', t);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.ok(verifyWebhookSignature(SECRET, '{"a":1}', header, { now }));
  assert.ok(!verifyWebhookSignature(SECRET, '{"a":2}', header, { now }), "changed body");
  assert.ok(!verifyWebhookSignature("another_secret_0123456", '{"a":1}', header, { now }), "wrong secret");
  assert.ok(!verifyWebhookSignature(SECRET, '{"a":1}', header, { now: now + 301_000 }), "too old");
  assert.ok(!verifyWebhookSignature(SECRET, '{"a":1}', "garbage", { now }));
  assert.ok(!verifyWebhookSignature(SECRET, '{"a":1}', undefined, { now }));
});

test("webhook config is validated", () => {
  const w = { id: "w", url: "https://example.com/hook", events: ["*"], secret: SECRET };
  const bad = (extra, re) => assert.throws(() => resolveConfig({ ...base, webhooks: [{ ...w, ...extra }] }), re);
  bad({ url: "ftp://example.com" }, /http\(s\) url/);
  bad({ url: "not a url" }, /http\(s\) url/);
  bad({ events: [] }, /needs events/);
  bad({ events: ["level.down"] }, /unknown event/);
  bad({ secret: "short" }, /at least 16/);
  bad({ secretEnv: "X" }, /not both/);
  bad({ secret: undefined, secretEnv: "ONSTREAK_TEST_MISSING_SECRET" }, /set ONSTREAK_TEST_MISSING_SECRET/);
  process.env.ONSTREAK_TEST_HOOK_SECRET = SECRET;
  assert.equal(resolveConfig({ ...base, webhooks: [{ ...w, secret: undefined, secretEnv: "ONSTREAK_TEST_HOOK_SECRET" }] }).webhooks[0].secret, SECRET);
  assert.equal(resolveConfig({ ...base, webhooks: [w] }).webhooks[0].events.size, 8);
});

test("pg: concurrent workers never send a delivery twice", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const config = { ...base, webhooks: [{ id: "all", url: "https://example.test/hook", events: ["*"], secret: SECRET }] };
  const engine = new Engine(config, store, () => start);
  for (let i = 0; i < 10; i++) await engine.track({ userId: `u${i}`, event: "lesson_completed" }); // 2 deliveries each
  const sent = [];
  const ok = async (_url, init) => {
    sent.push(JSON.parse(init.body).id);
    return new Response(null, { status: 204 });
  };
  const runs = await Promise.all(Array.from({ length: 5 }, () => engine.deliverWebhooks({ fetch: ok, limit: 10 })));
  assert.equal(runs.reduce((n, r) => n + r.delivered, 0), 20);
  assert.equal(new Set(sent).size, sent.length, "no delivery sent twice");
  assert.equal(sent.length, 20);
});
