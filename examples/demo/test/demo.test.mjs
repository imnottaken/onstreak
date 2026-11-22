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

test("friends can be challenged, and a duel's week settles into a record", async (t) => {
  const { view, press, base } = await start(t);
  let doc = await view();
  assert.deepEqual([...doc.querySelectorAll(".os-friend__name")].map((n) => n.textContent).sort(), ["Maya", "Ravi", "Zoe"]);
  assert.deepEqual([...doc.querySelectorAll(".os-rival__name")].map((n) => n.textContent), ["You vs Maya"], "you start in a duel with Maya");
  const friendsBoard = [...doc.querySelectorAll(".os-board")].find((b) => b.getAttribute("aria-label") === "Friends this week");
  assert.ok(friendsBoard.querySelector(".os-row--you"), "you are ranked among your friends");

  await press("/rival/ravi");
  doc = await view();
  assert.equal(doc.querySelectorAll(".os-rival").length, 2);
  await press("/do/study");
  doc = await view();
  assert.match(doc.querySelector(".os-rival__you").textContent, /^15 /, "your duel score counts this week's XP");

  await press("/next-week");
  doc = await view();
  for (const card of doc.querySelectorAll(".os-rival")) {
    const record = card.querySelector(".os-rival__stats dd").textContent;
    assert.match(record, /^\d+W \d+L \d+D$/);
    assert.notEqual(record, "0W 0L 0D", "last week was settled");
  }

  await press("/unrival/ravi");
  doc = await view();
  assert.equal(doc.querySelectorAll(".os-rival").length, 1);
  assert.equal((await fetch(`${base}/rival/nobody`, { method: "POST" })).status, 404, "only known players");
});

test("quests fill up as you study, pay out, and the daily ones reset", async (t) => {
  const { view, press } = await start(t);
  const quest = (doc, name) => [...doc.querySelectorAll(".os-quest")].find((q) => q.querySelector(".os-quest__name").textContent === name);
  let doc = await view();
  assert.equal(doc.querySelector(".os-quests__count").textContent, "0 / 3 done");
  await press("/do/lesson");
  await press("/do/lesson");
  doc = await view();
  assert.ok(quest(doc, "Two lessons").classList.contains("os-quest--done"));
  assert.equal(doc.querySelector(".stats .muted").textContent, "5 coins", "2 from lessons plus the 3 coin reward");
  await press("/do/study");
  doc = await view();
  assert.equal(quest(doc, "Earn 40 XP").querySelector(".os-quest__progress").textContent, "35 / 40 xp", "two lessons and 15 minutes");
  await press("/do/lesson");
  doc = await view();
  assert.ok(quest(doc, "Earn 40 XP").classList.contains("os-quest--done"), "a third lesson passes 40");
  assert.equal(quest(doc, "Study for an hour").querySelector(".os-quest__progress").textContent, "15 / 60 min");
  await press("/next-day");
  doc = await view();
  assert.equal(doc.querySelector(".os-quests__count").textContent, "0 / 3 done", "daily quests start over");
  assert.equal(quest(doc, "Study for an hour").querySelector(".os-quest__progress").textContent, "15 / 60 min", "the weekly one carries on");
});
