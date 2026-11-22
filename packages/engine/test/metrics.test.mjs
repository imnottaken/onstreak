import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStore, Metrics, createOnstreakServer, routeLabel } from "../dist/index.js";
import { config } from "./fixtures.mjs";

const KEY = "metrics-test-key-0123456789";

test("route labels drop ids", () => {
  assert.equal(routeLabel(["v1", "users", "asha", "quests"]), "/v1/users/:id/quests");
  assert.equal(routeLabel(["v1", "users", "asha", "purchases", "0a1b", "refund"]), "/v1/users/:id/purchases/:id/refund");
  assert.equal(routeLabel(["v1", "rivalries", "duel", "users", "a", "rivals", "b"]), "/v1/rivalries/:id/users/:id/rivals/:id");
  assert.equal(routeLabel(["v1", "events", "batch"]), "/v1/events/batch");
  assert.equal(routeLabel(["v1", "config", "preview"]), "/v1/config/preview");
  assert.equal(routeLabel(["health"]), "/health");
  assert.equal(routeLabel([]), "/");
});

test("GET /metrics reports requests, latency and tracked events", async (t) => {
  const server = createOnstreakServer(new Engine(config, new MemoryStore()), { apiKey: KEY, metricsToken: "scrape-token-0123456789" });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.shutdown({ timeoutMs: 100 }));
  const base = `http://localhost:${server.address().port}`;
  const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  await fetch(`${base}/v1/events`, { method: "POST", headers: auth, body: JSON.stringify({ userId: "a", event: "lesson_completed", idempotencyKey: "x" }) });
  await fetch(`${base}/v1/events`, { method: "POST", headers: auth, body: JSON.stringify({ userId: "a", event: "lesson_completed", idempotencyKey: "x" }) }); // duplicate
  await fetch(`${base}/v1/events/batch`, { method: "POST", headers: auth, body: JSON.stringify({ events: [{ userId: "b", event: "lesson_completed" }, { userId: "b", event: "bad event" }] }) });
  await fetch(`${base}/v1/users/asha`, { headers: auth });
  await fetch(`${base}/v1/users/ravi`, { headers: auth });
  await fetch(`${base}/v1/users/ravi`, { headers: { authorization: "Bearer nope-nope-nope-nope" } });
  server.metrics.webhooks.inc({ result: "delivered" }, 2);

  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const res = await fetch(`${base}/metrics`, { headers: { authorization: "Bearer scrape-token-0123456789" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain; version=0.0.4/);
  const text = await res.text();
  assert.match(text, /onstreak_http_requests_total\{method="GET",route="\/v1\/users\/:id",status="200"\} 2/);
  assert.match(text, /onstreak_http_requests_total\{method="GET",route="\/v1\/users\/:id",status="401"\} 1/);
  assert.match(text, /onstreak_http_requests_total\{method="POST",route="\/v1\/events",status="200"\} 2/);
  assert.match(text, /onstreak_events_tracked_total 2/, "one event plus one good batch item; the duplicate does not count");
  assert.match(text, /onstreak_http_request_duration_seconds_bucket\{method="GET",route="\/v1\/users\/:id",le="\+Inf"\} 3/);
  assert.match(text, /onstreak_webhook_deliveries_total\{result="delivered"\} 2/);
  assert.match(text, /onstreak_uptime_seconds \d+/);
  assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${KEY}` } })).status, 200, "an API key works too");
});

test("label values are escaped", () => {
  const m = new Metrics();
  m.requests.inc({ method: "GET", route: 'we"ird\\path', status: "200" });
  assert.match(m.render(), /route="we\\"ird\\\\path"/);
});
