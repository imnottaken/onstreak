import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { runCommand } from "../dist/cli.js";
import { MIGRATIONS, LATEST_VERSION } from "../dist/index.js";
import { config } from "./fixtures.mjs";
import { PG_URL } from "./helpers.mjs";

const pgOnly = PG_URL ? false : "set TEST_DATABASE_URL";
const MAIN = new URL("../dist/main.js", import.meta.url).pathname;

function writeConfig(content) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "onstreak-cli-")), "onstreak.config.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

async function cli(args, env = {}) {
  const out = [];
  const err = [];
  const code = await runCommand(args, { ...env }, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A schema name for one test, dropped afterwards (the CLI creates it). */
function schemaFor(t) {
  const schema = `cli_${randomBytes(5).toString("hex")}`;
  t.after(async () => {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });
  return schema;
}

test("check accepts a valid config and summarizes it", async () => {
  const r = await cli(["check"], { ONSTREAK_CONFIG: writeConfig(config) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /config OK/);
  assert.match(r.out, /2 currencies \(xp, coins\), 3 point rules, 4 levels, 1 streaks, 3 achievements, 2 leaderboards, 1 leagues/);
  assert.match(r.out, /database: none/);
});

test("check explains what is wrong with a bad config", async () => {
  const unknownCurrency = await cli(["check"], {
    ONSTREAK_CONFIG: writeConfig({ currencies: ["xp"], points: [{ event: "e", currency: "gold", amount: 1 }] }),
  });
  assert.equal(unknownCurrency.code, 1);
  assert.match(unknownCurrency.err, /unknown currency "gold"/);

  const notJson = await cli(["check"], { ONSTREAK_CONFIG: writeConfig("{ nope") });
  assert.equal(notJson.code, 1);
  assert.match(notJson.err, /not valid JSON/);

  const missing = await cli(["check"], { ONSTREAK_CONFIG: "/definitely/not/here.json" });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /config file not found/);
});

test("check reports an unreachable database", async () => {
  const r = await cli(["check"], { ONSTREAK_CONFIG: writeConfig(config), DATABASE_URL: "postgres://nobody@127.0.0.1:1/nothing" });
  assert.equal(r.code, 1);
  assert.match(r.err, /database unreachable/);
});

test("bad settings are rejected before touching the database", async () => {
  const schema = await cli(["migrate"], { DATABASE_URL: "postgres://x@127.0.0.1:1/x", ONSTREAK_DB_SCHEMA: "Bad-Name" });
  assert.equal(schema.code, 1);
  assert.match(schema.err, /ONSTREAK_DB_SCHEMA/);
  const prefix = await cli(["migrate"], { DATABASE_URL: "postgres://x@127.0.0.1:1/x", ONSTREAK_TABLE_PREFIX: "drop table;" });
  assert.equal(prefix.code, 1);
  assert.match(prefix.err, /ONSTREAK_TABLE_PREFIX/);
  const noDb = await cli(["migrate"], {});
  assert.equal(noDb.code, 1);
  assert.match(noDb.err, /DATABASE_URL is not set/);
});

test("help, version and unknown commands", async () => {
  assert.match((await cli(["--help"])).out, /onstreak migrate/);
  assert.match((await cli(["--version"])).out, /^\d+\.\d+\.\d+$/);
  const unknown = await cli(["dance"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown command: dance/);
  assert.equal((await cli([])).code, "serve", "no command means serve");
});

test("pg: migrate creates the schema and tables, check then reports up to date", { skip: pgOnly }, async (t) => {
  const schema = schemaFor(t);
  const env = { DATABASE_URL: PG_URL, ONSTREAK_DB_SCHEMA: schema, ONSTREAK_CONFIG: writeConfig(config) };

  const before = await cli(["check"], env);
  assert.equal(before.code, 0, before.err);
  assert.match(before.out, new RegExp(`${MIGRATIONS.length} migration\\(s\\) pending`));

  const first = await cli(["migrate"], env);
  assert.equal(first.code, 0, first.err);
  assert.equal((first.out.match(/^applied /gm) ?? []).length, MIGRATIONS.length);
  assert.equal((await cli(["migrate"], env)).out, `schema already up to date (version ${LATEST_VERSION})`);
  assert.match((await cli(["check"], env)).out, /schema up to date/);

  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  t.after(() => admin.end());
  const { rows } = await admin.query("select count(*)::int as n from pg_tables where schemaname = $1 and tablename like 'onstreak\\_%'", [schema]);
  assert.ok(rows[0].n >= 9, "tables live in the configured schema");
});

test("pg: ONSTREAK_TABLE_PREFIX names every table", { skip: pgOnly }, async (t) => {
  const schema = schemaFor(t);
  const r = await cli(["migrate"], { DATABASE_URL: PG_URL, ONSTREAK_DB_SCHEMA: schema, ONSTREAK_TABLE_PREFIX: "game_" });
  assert.equal(r.code, 0, r.err);
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  t.after(() => admin.end());
  const { rows } = await admin.query("select tablename from pg_tables where schemaname = $1 order by tablename", [schema]);
  assert.ok(rows.length >= 9);
  assert.ok(rows.every((r) => r.tablename.startsWith("game_")), JSON.stringify(rows));
});

test("pg: with ONSTREAK_AUTO_MIGRATE=false the server refuses to start on an old schema", { skip: pgOnly }, async (t) => {
  const schema = schemaFor(t);
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      DATABASE_URL: PG_URL,
      ONSTREAK_DB_SCHEMA: schema,
      ONSTREAK_AUTO_MIGRATE: "false",
      ONSTREAK_API_KEY: "cli-test-key-0123456789",
      ONSTREAK_CONFIG: writeConfig(config),
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.match(output, /migration\(s\) pending and ONSTREAK_AUTO_MIGRATE=false/);
});
