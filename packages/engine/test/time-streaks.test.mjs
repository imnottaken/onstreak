import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, startOfDay, weekStart, leaderboardWindow, recordActivity, streakStatus, initialStreak } from "../dist/index.js";

test("dayKey follows the user's time zone, not UTC", () => {
  // 19:00 UTC on Jan 1 is 00:30 on Jan 2 in India.
  const t = Date.parse("2026-01-01T19:00:00Z");
  assert.equal(dayKey(t, "UTC"), "2026-01-01");
  assert.equal(dayKey(t, "Asia/Kolkata"), "2026-01-02");
  assert.equal(dayKey(t, "America/Los_Angeles"), "2026-01-01");
});

test("startOfDay handles daylight saving changes", () => {
  // New York springs forward on 2026-03-08: midnight is still EST (-05:00).
  assert.equal(new Date(startOfDay("2026-03-08", "America/New_York")).toISOString(), "2026-03-08T05:00:00.000Z");
  // The next day starts in EDT (-04:00).
  assert.equal(new Date(startOfDay("2026-03-09", "America/New_York")).toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(new Date(startOfDay("2026-06-15", "Asia/Kolkata")).toISOString(), "2026-06-14T18:30:00.000Z");
});

test("weeks start on Monday", () => {
  assert.equal(weekStart("2026-11-22"), "2026-11-16"); // Sunday -> Monday before
  assert.equal(weekStart("2026-11-16"), "2026-11-16"); // Monday stays
});

test("leaderboard windows cover the current day, week and month", () => {
  const now = Date.parse("2026-11-22T10:00:00Z");
  const day = leaderboardWindow("daily", now, "UTC");
  assert.equal(new Date(day.from).toISOString(), "2026-11-22T00:00:00.000Z");
  assert.equal(new Date(day.to).toISOString(), "2026-11-23T00:00:00.000Z");
  const week = leaderboardWindow("weekly", now, "UTC");
  assert.equal(new Date(week.from).toISOString(), "2026-11-16T00:00:00.000Z");
  const month = leaderboardWindow("monthly", now, "UTC");
  assert.equal(new Date(month.to).toISOString(), "2026-12-01T00:00:00.000Z");
  assert.deepEqual(leaderboardWindow("all", now, "UTC"), { from: null, to: null });
});

const daily = { id: "s", event: "e", period: "daily" };

function run(rule, days) {
  let state = initialStreak(rule);
  const updates = [];
  for (const d of days) {
    const u = recordActivity(rule, state, d);
    updates.push(u);
    state = u.state;
  }
  return { state, updates };
}

test("consecutive days grow the streak; same day counts once", () => {
  const { state, updates } = run(daily, ["2026-11-01", "2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.equal(state.current, 3);
  assert.equal(state.longest, 3);
  assert.equal(updates[1].extended, false);
});

test("a missed day resets the streak but keeps the longest", () => {
  const { state, updates } = run(daily, ["2026-11-01", "2026-11-02", "2026-11-04"]);
  assert.equal(state.current, 1);
  assert.equal(state.longest, 2);
  assert.equal(updates[2].reset, true);
});

test("freezes cover missed days, and are earned back on schedule", () => {
  const rule = { ...daily, freezes: { start: 1, max: 2, earnEvery: 3 } };
  const { state, updates } = run(rule, ["2026-11-01", "2026-11-03"]);
  assert.equal(state.current, 2);
  assert.equal(updates[1].freezesUsed, 1);
  assert.equal(state.freezes, 0);
  const after = recordActivity(rule, state, "2026-11-04");
  assert.equal(after.state.current, 3);
  assert.equal(after.state.freezes, 1, "earned a freeze at 3 days");
});

test("late events never rewrite a streak", () => {
  const { state } = run(daily, ["2026-11-05", "2026-11-06"]);
  const late = recordActivity(daily, state, "2026-11-01");
  assert.equal(late.extended, false);
  assert.deepEqual(late.state, state);
});

test("weekly streaks count calendar weeks", () => {
  const weekly = { id: "w", event: "e", period: "weekly" };
  const { state } = run(weekly, ["2026-11-02", "2026-11-09", "2026-11-16"]);
  assert.equal(state.current, 3);
});

test("streakStatus shows done, pending and broken", () => {
  const { state } = run(daily, ["2026-11-01", "2026-11-02"]);
  assert.equal(streakStatus(daily, state, "2026-11-02").status, "done");
  assert.equal(streakStatus(daily, state, "2026-11-03").status, "pending");
  const broken = streakStatus(daily, state, "2026-11-05");
  assert.equal(broken.status, "broken");
  assert.equal(broken.current, 0);
  assert.equal(broken.longest, 2);
});
