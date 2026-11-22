import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, resolveConfig } from "../dist/index.js";
import { config as base } from "./fixtures.mjs";
import { storeFactories } from "./helpers.mjs";

/** 10:00 UTC on a day in November 2026 (the 16th is a Monday). */
const at = (day, hour = 10) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`);
const config = {
  ...base,
  defaultTimezone: "UTC",
  achievements: [],
  items: [],
  streaks: [
    { id: "three_a_day", event: "lesson_completed", period: "daily", minimum: 3 },
    { id: "weekdays", event: "minutes_studied", period: "daily", skipWeekends: true, repair: { withinHours: 24 } },
    { id: "study_week", event: "minutes_studied", period: "weekly", minimum: 60 },
  ],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: a day only counts once the minimum is reached`, async (t) => {
    let now = at(16);
    const engine = new Engine(config, await makeStore(t), () => now);
    const lesson = (extra = {}) => engine.track({ userId: "asha", event: "lesson_completed", ...extra });

    let r = await lesson();
    assert.deepEqual(r.streaks.three_a_day, { current: 0, longest: 0, freezes: 0, extended: false, freezesUsed: 0, reset: false, progress: 1 });
    await lesson();
    let u = await engine.getUser("asha");
    assert.deepEqual([u.streaks.three_a_day.status, u.streaks.three_a_day.progress], ["none", 2]);
    r = await lesson();
    assert.deepEqual([r.streaks.three_a_day.current, r.streaks.three_a_day.extended, r.streaks.three_a_day.progress], [1, true, 3]);
    r = await lesson();
    assert.deepEqual([r.streaks.three_a_day.extended, r.streaks.three_a_day.progress], [false, 4]);

    now = at(17);
    u = await engine.getUser("asha");
    assert.deepEqual([u.streaks.three_a_day.status, u.streaks.three_a_day.progress], ["pending", 0], "a new day starts from zero");
    await lesson();
    await lesson();
    r = await lesson({ timestamp: at(16, 20) }); // a late event for yesterday
    assert.equal(r.streaks.three_a_day.progress, 2, "a late event for an earlier day changes nothing");
    r = await lesson();
    assert.deepEqual([r.streaks.three_a_day.current, r.streaks.three_a_day.progress], [2, 3]);

    now = at(19); // the 18th had too little
    await lesson();
    u = await engine.getUser("asha");
    assert.deepEqual([u.streaks.three_a_day.status, u.streaks.three_a_day.current], ["broken", 0]);
  });

  test(`${name}: values add up toward a weekly minimum`, async (t) => {
    let now = at(16);
    const engine = new Engine(config, await makeStore(t), () => now);
    let r = await engine.track({ userId: "w", event: "minutes_studied", value: 40 });
    assert.deepEqual([r.streaks.study_week.current, r.streaks.study_week.progress], [0, 40]);
    now = at(19);
    r = await engine.track({ userId: "w", event: "minutes_studied", value: 25 });
    assert.deepEqual([r.streaks.study_week.current, r.streaks.study_week.progress], [1, 65]);
    now = at(22); // Sunday, same week
    r = await engine.track({ userId: "w", event: "minutes_studied", value: 5 });
    assert.deepEqual([r.streaks.study_week.current, r.streaks.study_week.progress], [1, 70]);
    now = at(23); // Monday: a new week
    r = await engine.track({ userId: "w", event: "minutes_studied", value: 60 });
    assert.deepEqual([r.streaks.study_week.current, r.streaks.study_week.progress], [2, 60]);
  });

  test(`${name}: weekends off keep a weekday streak over Saturday and Sunday`, async (t) => {
    let now = at(20); // Friday
    const engine = new Engine(config, await makeStore(t), () => now);
    const study = () => engine.track({ userId: "m", event: "minutes_studied", value: 5 });
    await study();
    now = at(22); // Sunday, nothing done this weekend
    assert.equal((await engine.getUser("m")).streaks.weekdays.status, "pending");
    now = at(23); // Monday
    let r = await study();
    assert.deepEqual([r.streaks.weekdays.current, r.streaks.weekdays.freezesUsed, r.streaks.weekdays.reset], [2, 0, false]);
    now = at(28); // Saturday; Tuesday to Friday were missed, so this starts over
    r = await study();
    assert.deepEqual([r.streaks.weekdays.current, r.streaks.weekdays.reset], [1, true], "weekend activity still counts");
    now = at(30); // Monday
    r = await study();
    assert.equal(r.streaks.weekdays.current, 2, "Saturday then Monday: Sunday is not required");
  });

  test(`${name}: a Friday streak breaks on Tuesday when Monday is missed, and can be repaired`, async (t) => {
    let now = at(20);
    const engine = new Engine(config, await makeStore(t), () => now);
    await engine.track({ userId: "f", event: "minutes_studied", value: 5 });
    now = at(23, 23); // late Monday
    assert.equal((await engine.getUser("f")).streaks.weekdays.status, "pending");
    now = at(24); // Tuesday
    const u = await engine.getUser("f");
    assert.deepEqual([u.streaks.weekdays.status, u.streaks.weekdays.repairableUntil], ["broken", "2026-11-25T00:00:00.000Z"], "24 hours from the start of Tuesday");
    const fixed = await engine.repairStreak("f", "weekdays");
    assert.deepEqual([fixed.current, fixed.status], [1, "pending"]);
    const r = await engine.track({ userId: "f", event: "minutes_studied", value: 5 });
    assert.equal(r.streaks.weekdays.current, 2);
  });
}

test("streak rule options are validated", () => {
  const s = { id: "s", event: "x", period: "daily" };
  const bad = (extra) => assert.throws(() => resolveConfig({ ...base, achievements: [], items: [], streaks: [{ ...s, ...extra }] }), /streak "s"/);
  bad({ minimum: 0 });
  bad({ minimum: "3" });
  bad({ skipWeekends: "yes" });
  bad({ period: "weekly", skipWeekends: true });
  assert.doesNotThrow(() => resolveConfig({ ...base, achievements: [], items: [], streaks: [{ ...s, minimum: 2.5, skipWeekends: true }] }));
});

const periods = {
  ...base,
  defaultTimezone: "UTC",
  achievements: [],
  items: [],
  streaks: [
    { id: "monthly", event: "lesson_completed", period: "monthly", repair: { withinHours: 72 } },
    { id: "sunday_weeks", event: "lesson_completed", period: "weekly", weekStartsOn: "sunday" },
    { id: "monday_weeks", event: "lesson_completed", period: "weekly" },
  ],
};

for (const [name, makeStore] of Object.entries(storeFactories)) {
  test(`${name}: monthly streaks count calendar months`, async (t) => {
    let now = Date.parse("2026-01-31T10:00:00Z");
    const engine = new Engine(periods, await makeStore(t), () => now);
    const lesson = () => engine.track({ userId: "m", event: "lesson_completed" });
    await lesson();
    now = Date.parse("2026-02-01T10:00:00Z"); // the next day is already a new month
    let r = await lesson();
    assert.deepEqual([r.streaks.monthly.current, r.streaks.monthly.extended], [2, true]);
    now = Date.parse("2026-02-28T10:00:00Z");
    r = await lesson();
    assert.equal(r.streaks.monthly.extended, false, "once a month");
    now = Date.parse("2026-03-31T10:00:00Z");
    assert.equal((await engine.getUser("m")).streaks.monthly.status, "pending");
    now = Date.parse("2026-04-02T10:00:00Z"); // March was missed
    const u = await engine.getUser("m");
    assert.deepEqual([u.streaks.monthly.status, u.streaks.monthly.repairableUntil], ["broken", "2026-04-04T00:00:00.000Z"]);
    const fixed = await engine.repairStreak("m", "monthly");
    assert.deepEqual([fixed.current, fixed.status], [2, "pending"]);
    r = await lesson();
    assert.equal(r.streaks.monthly.current, 3);
  });

  test(`${name}: weeks can start on any day`, async (t) => {
    let now = Date.parse("2026-11-21T10:00:00Z"); // Saturday
    const engine = new Engine(periods, await makeStore(t), () => now);
    await engine.track({ userId: "w", event: "lesson_completed" });
    now = Date.parse("2026-11-22T10:00:00Z"); // Sunday
    const r = await engine.track({ userId: "w", event: "lesson_completed" });
    assert.equal(r.streaks.sunday_weeks.current, 2, "Sunday starts a new week");
    assert.equal(r.streaks.monday_weeks.current, 1, "but not for a Monday week");
    assert.equal((await engine.getUser("w")).streaks.sunday_weeks.lastPeriod, "2026-11-22");
  });
}

test("streak periods are validated", () => {
  const s = { id: "s", event: "x" };
  const bad = (extra) => assert.throws(() => resolveConfig({ ...base, achievements: [], items: [], streaks: [{ ...s, ...extra }] }), /streak "s"/);
  bad({ period: "yearly" });
  bad({ period: "daily", weekStartsOn: "sunday" });
  bad({ period: "weekly", weekStartsOn: "funday" });
  bad({ period: "monthly", skipWeekends: true });
  assert.doesNotThrow(() => resolveConfig({ ...base, achievements: [], items: [], streaks: [{ ...s, period: "monthly", minimum: 10 }] }));
});
