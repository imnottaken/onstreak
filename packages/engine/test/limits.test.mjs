import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, RateLimiter, createOnstreakServer } from "../dist/index.js";
import { config } from "./fixtures.mjs";

const API_KEY = "limits-test-key-0123456789";

async function serve(t, options) {
  const server = createOnstreakServer(new Engine(config, new MemoryStore()), { apiKey: API_KEY, ...options });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.shutdown({ timeoutMs: 100 }));
  return `http://localhost:${server.address().port}`;
}

test("the token bucket allows bursts, then refills steadily", () => {
  const limiter = new RateLimiter(60, 3); // one a second, bursts of 3
  const t0 = 1_000_000;
  assert.deepEqual([limiter.take("a", t0), limiter.take("a", t0), limiter.take("a", t0)], [0, 0, 0]);
  assert.equal(limiter.take("a", t0), 1, "wait a second");
  assert.equal(limiter.take("b", t0), 0, "clients are separate");
  assert.equal(limiter.take("a", t0 + 1000), 0);
  assert.equal(limiter.take("a", t0 + 1000), 1);
  assert.equal(limiter.take("a", t0 + 60_000), 0, "refilled");
  assert.throws(() => new RateLimiter(0), /perMinute/);
});

test("the server answers 429 with retry-after past the limit, but never for health", async (t) => {
  const base = await serve(t, { rateLimit: { perMinute: 60, burst: 2 } });
  const get = (path, headers = {}) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${API_KEY}`, ...headers } });
  assert.equal((await get("/v1/users/a")).status, 200);
  assert.equal((await get("/v1/users/a")).status, 200);
  const limited = await get("/v1/users/a");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.match((await limited.json()).error, /too many requests/);
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await get("/v1/users/a", { authorization: "Bearer wrong-key-000000000000" })).status, 429, "bad keys are limited too");
});

test("with trustProxy, clients are told apart by x-forwarded-for", async (t) => {
  const base = await serve(t, { rateLimit: { perMinute: 60, burst: 1, trustProxy: true } });
  const get = (ip) => fetch(`${base}/v1/users/a`, { headers: { authorization: `Bearer ${API_KEY}`, "x-forwarded-for": `${ip}, 10.0.0.1` } });
  assert.equal((await get("1.1.1.1")).status, 200);
  assert.equal((await get("1.1.1.1")).status, 429);
  assert.equal((await get("2.2.2.2")).status, 200);
});

test("CORS: allowed origins get headers and preflights; others get none", async (t) => {
  const base = await serve(t, { corsOrigins: ["https://app.example.com"] });
  const ok = await fetch(`${base}/v1/users/a`, { headers: { authorization: `Bearer ${API_KEY}`, origin: "https://app.example.com" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.equal(ok.headers.get("vary"), "origin");
  const other = await fetch(`${base}/v1/users/a`, { headers: { authorization: `Bearer ${API_KEY}`, origin: "https://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  const pre = await fetch(`${base}/v1/events`, { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /authorization/);
  const preBad = await fetch(`${base}/v1/events`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.deepEqual([preBad.status, preBad.headers.get("access-control-allow-methods")], [204, null]);

  const any = await serve(t, { corsOrigins: ["*"] });
  const star = await fetch(`${any}/health/live`, { headers: { origin: "https://x.example" } });
  assert.deepEqual([star.headers.get("access-control-allow-origin"), star.headers.get("vary")], ["*", null]);
  const none = await serve(t, {});
  assert.equal((await fetch(`${none}/health/live`, { headers: { origin: "https://x.example" } })).headers.get("access-control-allow-origin"), null);
});
