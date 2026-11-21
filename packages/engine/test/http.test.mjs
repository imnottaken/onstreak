import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Engine, MemoryStore, createOnstreakServer, createLogger } from "../dist/index.js";
import { config } from "./fixtures.mjs";

const API_KEY = "http-test-key-0123456789";
const auth = { authorization: `Bearer ${API_KEY}` };

/** Start a server on a random port with a log capture. */
async function serve(t, { store = new MemoryStore(), healthTimeoutMs } = {}) {
  const lines = [];
  const logger = createLogger({ level: "debug", write: (l) => lines.push(JSON.parse(l)) });
  const engine = new Engine(config, store);
  const server = createOnstreakServer(engine, { apiKey: API_KEY, logger, ...(healthTimeoutMs ? { healthTimeoutMs } : {}) });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.shutdown({ timeoutMs: 100 }));
  const base = `http://localhost:${server.address().port}`;
  const call = (method, route, body, headers = {}) =>
    fetch(`${base}${route}`, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  return { server, base, call, lines, store };
}

test("every response carries a request id, and logs record it", async (t) => {
  const { call, lines } = await serve(t);
  const generated = await call("GET", "/v1/users/a");
  const id = generated.headers.get("x-request-id");
  assert.match(id, /^[0-9a-f-]{36}$/, "generated when the client sends none");

  const echoed = await call("GET", "/v1/users/a", undefined, { "x-request-id": "client-abc.123" });
  assert.equal(echoed.headers.get("x-request-id"), "client-abc.123", "a safe client id is kept");

  const unsafe = await call("GET", "/v1/users/a", undefined, { "x-request-id": "bad id with spaces" });
  assert.notEqual(unsafe.headers.get("x-request-id"), "bad id with spaces", "an unsafe id is replaced");

  const entry = lines.find((l) => l.requestId === "client-abc.123");
  assert.equal(entry.msg, "request");
  assert.equal(entry.level, "info");
  assert.equal(entry.method, "GET");
  assert.equal(entry.path, "/v1/users/a");
  assert.equal(entry.status, 200);
  assert.equal(typeof entry.durationMs, "number");
  assert.ok(!JSON.stringify(lines).includes(API_KEY), "the API key never appears in logs");

  const notFound = await call("GET", "/v1/nope");
  const body = await notFound.json();
  assert.equal(body.requestId, notFound.headers.get("x-request-id"), "error bodies include the id for support");
});

test("unexpected errors are logged with the request id and hidden from clients", async (t) => {
  const store = new MemoryStore();
  store.snapshot = async () => {
    throw new Error("disk on fire");
  };
  const { call, lines } = await serve(t, { store });
  const res = await call("GET", "/v1/users/a");
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "internal error", "no internals leak to the client");
  const logged = lines.find((l) => l.msg === "unhandled error");
  assert.equal(logged.requestId, body.requestId);
  assert.equal(logged.err.message, "disk on fire");
  assert.equal(lines.find((l) => l.msg === "request" && l.requestId === body.requestId).level, "error");
});

test("health checks the database; liveness does not", async (t) => {
  const store = new MemoryStore();
  const { base } = await serve(t, { store, healthTimeoutMs: 100 });

  let res = await fetch(`${base}/health`);
  assert.equal(res.status, 200, "no API key needed");
  assert.deepEqual(await res.json(), { ok: true, database: "ok" });

  store.ping = async () => {
    throw new Error("connection refused");
  };
  res = await fetch(`${base}/health`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, database: "unreachable" });

  store.ping = () => new Promise(() => {}); // hangs forever
  const t0 = Date.now();
  res = await fetch(`${base}/health`);
  assert.equal(res.status, 503, "a hung database counts as down");
  assert.ok(Date.now() - t0 < 2000, "and the check gives up quickly");

  res = await fetch(`${base}/health/live`);
  assert.equal(res.status, 200, "liveness ignores the database");
});

test("profile, history and batch routes", async (t) => {
  const { call } = await serve(t);
  let res = await call("PATCH", "/v1/users/maya", { displayName: "Maya", timezone: "Asia/Kolkata" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).profile.displayName, "Maya");

  res = await call("PATCH", "/v1/users/maya", { nickname: "x" });
  assert.equal(res.status, 400);

  res = await call("POST", "/v1/events/batch", {
    events: [
      { userId: "maya", event: "lesson_completed" },
      { userId: "maya", event: "nope nope" },
      { userId: "maya", event: "minutes_studied", value: 5 },
    ],
  });
  const batch = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(batch.results.map((r) => r.ok), [true, false, true]);

  res = await call("POST", "/v1/events/batch", [{ userId: "maya", event: "x" }]);
  assert.equal(res.status, 400, "the batch body must be an object with events");

  res = await call("GET", "/v1/users/maya/events?limit=1");
  const page = await res.json();
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].event, "minutes_studied");
  res = await call("GET", `/v1/users/maya/events?limit=5&cursor=${page.nextCursor}`);
  assert.deepEqual((await res.json()).events.map((e) => e.event), ["lesson_completed"]);

  res = await call("GET", "/v1/leaderboards/xp_all");
  assert.equal((await res.json()).entries[0].displayName, "Maya");
});

/** A store whose first write waits until the test lets it go. */
function gatedStore() {
  const store = new MemoryStore();
  let open;
  const gate = new Promise((r) => (open = r));
  let entered;
  store.entered = new Promise((r) => (entered = r));
  store.release = open;
  store.closed = false;
  const withUser = store.withUser.bind(store);
  store.withUser = async (id, fn) => {
    entered();
    await gate;
    return withUser(id, fn);
  };
  store.close = async () => {
    store.closed = true;
  };
  return store;
}

test("shutdown waits for in-flight requests, refuses new work, then closes the database", async (t) => {
  const store = gatedStore();
  const { server, call, base } = await serve(t, { store });
  const inflight = call("POST", "/v1/events", { userId: "u", event: "lesson_completed" });
  await store.entered;

  let done = false;
  const closing = server.shutdown({ timeoutMs: 5000 }).then((r) => ((done = true), r));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false, "shutdown waits for the request in flight");
  assert.equal(store.closed, false, "the database stays open while requests run");
  await assert.rejects(fetch(`${base}/health/live`), "new connections are refused");

  store.release();
  const res = await inflight;
  assert.equal(res.status, 200, "the in-flight request completes normally");
  assert.equal(res.headers.get("connection"), "close", "keep-alive clients are told to reconnect elsewhere");
  assert.deepEqual(await closing, { forced: false });
  assert.equal(store.closed, true, "database connections are released last");
});

test("shutdown cuts requests that outlive the timeout", async (t) => {
  const store = gatedStore();
  const { server, call } = await serve(t, { store });
  const inflight = call("POST", "/v1/events", { userId: "u", event: "lesson_completed" });
  await store.entered;
  const result = await server.shutdown({ timeoutMs: 100 });
  assert.deepEqual(result, { forced: true });
  await assert.rejects(inflight, "the stuck request was cut");
  assert.equal(store.closed, true);
  store.release();
});

test("the server process stops cleanly on SIGTERM", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "onstreak-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [new URL("../dist/main.js", import.meta.url).pathname], {
    env: { ...process.env, DATABASE_URL: "", ONSTREAK_API_KEY: API_KEY, ONSTREAK_CONFIG: configPath, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start: ${out}`)), 10_000);
    child.stdout.on("data", () => {
      if (out.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, out);
  const logs = out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  assert.ok(logs.some((l) => l.msg === "shutting down" && l.signal === "SIGTERM"));
  assert.ok(logs.some((l) => l.msg === "stopped" && l.forced === false));
});
