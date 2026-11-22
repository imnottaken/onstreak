import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, EngineError, PostgresStore, fromPgPool, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { PG_URL, freshSchema, poolFor, storeFactories } from "./helpers.mjs";

const start = Date.parse("2026-11-16T06:00:00Z");
const config = { ...base, teams: { maxMembers: 3 } };

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (err) => err instanceof EngineError && err.status === status && err.code === code);
}

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: teams, members and team rankings`, async (t) => {
    let now = start;
    const engine = new Engine(config, await makeStore(t), () => now);
    const lesson = (u) => engine.track({ userId: u, event: "lesson_completed" });

    const made = await engine.saveTeam("owls", { name: " Night owls " });
    assert.deepEqual(made, { team: { id: "owls", name: "Night owls", createdAt: new Date(start).toISOString() }, created: true });
    assert.equal((await engine.saveTeam("owls", { name: "The owls" })).created, false);
    await engine.saveTeam("larks", { name: "Early larks" });
    await engine.saveTeam("empty", { name: "Nobody yet" });

    await lesson("asha"); // before joining: does not count for the team
    now += 1000;
    assert.deepEqual(await engine.addTeamMember("owls", "asha"), { teamId: "owls", userId: "asha", created: true });
    assert.equal((await engine.addTeamMember("owls", "asha")).created, false);
    await engine.addTeamMember("owls", "ravi");
    await engine.addTeamMember("larks", "maya");
    await rejectsWith(engine.addTeamMember("larks", "asha"), 409, "already_in_team");
    await engine.addTeamMember("owls", "zoe");
    await rejectsWith(engine.addTeamMember("owls", "omar"), 409, "team_full");

    now += 1000;
    await lesson("asha");
    await lesson("asha");
    await lesson("ravi");
    await lesson("maya");
    await lesson("maya");
    await lesson("maya");
    await lesson("loner");

    let board = await engine.teamLeaderboard("xp_all", { teamId: "empty" });
    assert.deepEqual(board.entries.map((e) => [e.teamId, e.name, e.rank, e.score]), [
      ["larks", "Early larks", 1, 30],
      ["owls", "The owls", 1, 30],
      ["empty", "Nobody yet", 3, 0],
    ], "ties share a rank; asha's lesson before joining does not count");
    assert.deepEqual(board.team, { rank: 3, teamId: "empty", name: "Nobody yet", score: 0 });

    const owls = await engine.team("owls", { leaderboard: "xp_all" });
    assert.deepEqual(owls.members.map((m) => [m.userId, m.score]), [["asha", 20], ["ravi", 10], ["zoe", 0]]);
    assert.deepEqual([owls.maxMembers, owls.leaderboard], [3, { id: "xp_all", score: 30, rank: 1 }]);
    assert.equal((await engine.team("owls")).members[0].score, undefined);
    assert.equal((await engine.team("owls")).leaderboard, null);

    // Leaving takes a member's points with them.
    assert.deepEqual(await engine.removeTeamMember("owls", "asha"), { teamId: "owls", userId: "asha", removed: true });
    assert.equal((await engine.removeTeamMember("owls", "asha")).removed, false);
    board = await engine.teamLeaderboard("xp_all", { limit: 1 });
    assert.deepEqual(board.entries.map((e) => [e.teamId, e.score]), [["larks", 30]]);
    assert.deepEqual(await engine.userTeam("asha"), { userId: "asha", team: null });
    const ravi = await engine.userTeam("ravi");
    assert.deepEqual([ravi.team.id, ravi.team.name, ravi.team.joinedAt], ["owls", "The owls", new Date(start + 1000).toISOString()]);

    // Now asha can join the larks; only her new points count there.
    now += 1000;
    await engine.addTeamMember("larks", "asha");
    await lesson("asha");
    assert.equal((await engine.team("larks", { leaderboard: "xp_all" })).leaderboard.score, 40);
  });

  test(`${name}: team input is validated`, async (t) => {
    const engine = new Engine(config, await makeStore(t), () => start);
    await rejectsWith(engine.saveTeam("bad id", { name: "x" }), 400, undefined);
    await rejectsWith(engine.saveTeam("ok", { name: "" }), 400, undefined);
    await rejectsWith(engine.saveTeam("ok", { name: "x".repeat(81) }), 400, undefined);
    await rejectsWith(engine.saveTeam("ok", null), 400, undefined);
    await rejectsWith(engine.team("nope"), 404, undefined);
    await rejectsWith(engine.addTeamMember("nope", "a"), 404, undefined);
    await engine.saveTeam("ok", { name: "OK" });
    await rejectsWith(engine.addTeamMember("ok", "bad user"), 400, undefined);
    await rejectsWith(engine.team("ok", { leaderboard: "nope" }), 404, undefined);
    await rejectsWith(engine.teamLeaderboard("nope"), 404, undefined);
    await rejectsWith(engine.teamLeaderboard("xp_all", { limit: 0 }), 400, undefined);
  });
}

test("teams config is validated", () => {
  assert.equal(resolveConfig(base).teams.maxMembers, 50);
  for (const maxMembers of [0, 1.5, 100_001]) assert.throws(() => resolveConfig({ ...base, teams: { maxMembers } }), /teams.maxMembers/);
});

test("pg: concurrent joins never overfill a team or put a user in two", { skip: PG_URL ? false : "set TEST_DATABASE_URL" }, async (t) => {
  const pool = poolFor(await freshSchema(t), t, 20);
  const store = new PostgresStore(fromPgPool(pool));
  await store.migrate();
  const engine = new Engine(config, store, () => start);
  await engine.saveTeam("a", { name: "A" });
  await engine.saveTeam("b", { name: "B" });
  const joins = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => engine.addTeamMember("a", `u${i}`)));
  assert.equal(joins.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal((await engine.team("a")).members.length, 3);
  const both = await Promise.allSettled([engine.addTeamMember("b", "solo"), engine.addTeamMember("a", "solo"), engine.addTeamMember("b", "solo")]);
  assert.ok(both.some((r) => r.status === "fulfilled"));
  const teamOf = (await engine.userTeam("solo")).team.id;
  assert.ok(["a", "b"].includes(teamOf));
  const inA = (await engine.team("a")).members.some((m) => m.userId === "solo");
  const inB = (await engine.team("b")).members.some((m) => m.userId === "solo");
  assert.equal(Number(inA) + Number(inB), 1, "in exactly one team");
});
