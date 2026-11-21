import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createDemo } from "../server.mjs";

async function start(t) {
  const { server, ready } = createDemo({ seed: 7 });
  await ready;
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://localhost:${server.address().port}`;
  const view = async (path = "/") => {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200);
    return JSDOM.fragment(await res.text());
  };
  const press = async (action) => {
    const res = await fetch(`${base}${action}`, { method: "POST", redirect: "manual" });
    assert.equal(res.status, 303, `${action} redirects back`);
    return res.headers.get("location");
  };
  return { view, press, base };
}

const streakLabel = (doc) => doc.querySelector(".os-streak").getAttribute("aria-label");

test("the demo page shows every component for a new user", async (t) => {
  const { view } = await start(t);
  const doc = await view();
  assert.equal(streakLabel(doc), "No streak yet");
  assert.match(doc.querySelector(".os-level__number").textContent, /Level 1/);
  assert.equal(doc.querySelector(".os-league__title").textContent, "Bronze league");
  assert.ok(doc.querySelectorAll(".os-board .os-row").length >= 1, "rivals already have scores");
  assert.equal(doc.querySelectorAll(".os-badge--locked").length, 6, "every badge starts locked");
  assert.equal(doc.querySelector(".os-toast"), null);
});

test("finishing lessons day after day builds a streak and unlocks badges", async (t) => {
  const { view, press } = await start(t);
  const after = await press("/do/lesson");
  assert.equal(after, "/?unlocked=first_lesson");
  let doc = await view(after);
  assert.equal(doc.querySelector(".os-toast__title").textContent, "Achievement unlocked");
  assert.match(doc.querySelector(".os-toast").textContent, /First steps/);
  assert.equal(streakLabel(doc), "1 day streak, done today, 1 freeze left");
  assert.ok([...doc.querySelectorAll(".os-row--you")].length >= 1, "you are on the leaderboard");

  await press("/next-day");
  doc = await view();
  assert.equal(streakLabel(doc), "1 day streak, do it today to keep it, 1 freeze left", "a new day is pending");

  await press("/do/lesson");
  await press("/next-day");
  const third = await press("/do/lesson");
  assert.match(third, /streak_3/, "three days in a row");
  doc = await view();
  assert.equal(streakLabel(doc), "3 day streak, done today, 1 freeze left");
  assert.equal(doc.querySelectorAll(".os-badge--unlocked").length, 2);
  assert.equal(doc.querySelectorAll(".events li").length, 3, "recent activity lists the lessons");
});

test("skipping a week settles the league and the streak breaks without enough freezes", async (t) => {
  const { view, press } = await start(t);
  await press("/do/study");
  await press("/do/lesson");
  await press("/next-week");
  const doc = await view();
  assert.match(doc.querySelector(".os-league__previous").textContent, /^Last round: /, "last week's result is shown");
  assert.equal(streakLabel(doc), "Streak broken");
});

test("reset starts over, and unknown pages are 404", async (t) => {
  const { view, press, base } = await start(t);
  await press("/do/lesson");
  await press("/reset");
  assert.equal(streakLabel(await view()), "No streak yet");
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/do/lesson`)).status, 404, "actions only accept POST");
});
