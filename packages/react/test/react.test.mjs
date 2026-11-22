import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A browser-like DOM must exist before react-dom loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 21+ has a global navigator; Node 20 does not, and react-dom reads it.
if (typeof globalThis.navigator === "undefined") globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const lib = await import("../dist/index.js");
const { StreakFlame, LevelBar, BadgeGrid, Leaderboard, LeagueTable, AchievementToast, FriendsList, RivalCard, RivalList, QuestList, RewardStore, RewardCalendar } = lib;
const h = React.createElement;

/** Mount into the fake DOM; returns the container and an unmount function. */
function mount(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    rerender: (el) => act(() => root.render(el)),
    unmount: () => act(() => root.unmount()),
  };
}

const fragment = (html) => JSDOM.fragment(html);

test("helpers", () => {
  assert.equal(lib.levelProgress({ points: 45, startsAt: 30, nextAt: 60 }), 0.5);
  assert.equal(lib.levelProgress({ points: 999, startsAt: 500, nextAt: null }), 1, "max level is full");
  assert.equal(lib.levelProgress({ points: 10, startsAt: 30, nextAt: 60 }), 0, "never negative");
  assert.equal(lib.initials("Asha Kumar"), "AK");
  assert.equal(lib.initials("asha"), "AS");
  assert.equal(lib.initials("user_42"), "U4");
  assert.equal(lib.initials("   "), "?");
  assert.equal(lib.formatTimeLeft(0), "ended");
  assert.equal(lib.formatTimeLeft(30_000), "less than a minute");
  assert.equal(lib.formatTimeLeft(12 * 60_000), "12m");
  assert.equal(lib.formatTimeLeft((3 * 60 + 12) * 60_000), "3h 12m");
  assert.equal(lib.formatTimeLeft((2 * 24 + 4) * 3_600_000), "2d 4h");
  assert.equal(lib.formatTimeLeft(2 * 24 * 3_600_000), "2d");
  assert.equal(lib.streakLabel({ current: 7, status: "done", freezes: 0 }), "7 day streak, done today");
  assert.equal(lib.streakLabel({ current: 7, status: "pending", freezes: 2 }), "7 day streak, do it today to keep it, 2 freezes left");
  assert.equal(lib.streakLabel({ current: 3, status: "done", freezes: 1 }, "week"), "3 week streak, done this week, 1 freeze left");
  assert.equal(lib.streakLabel({ current: 0, status: "broken", freezes: 0 }), "Streak broken");
  assert.equal(lib.streakLabel({ current: 0, status: "none", freezes: 0 }), "No streak yet");
  assert.equal(lib.countdownTick(30_000), 1000);
  assert.equal(lib.countdownTick(10 * 60_000), 30_000);
});

test("StreakFlame describes the streak for screen readers and dims until done", () => {
  const done = fragment(renderToStaticMarkup(h(StreakFlame, { streak: { current: 12, longest: 20, freezes: 1, lastPeriod: "2026-11-21", status: "done" } })));
  const el = done.querySelector(".os-streak");
  assert.equal(el.getAttribute("role"), "img");
  assert.equal(el.getAttribute("aria-label"), "12 day streak, done today, 1 freeze left");
  assert.ok(el.classList.contains("os-streak--done"));
  assert.equal(done.querySelector(".os-streak__count").textContent, "12");
  assert.ok(done.querySelector(".os-streak__freezes"));

  const broken = fragment(renderToStaticMarkup(h(StreakFlame, { streak: { current: 0, longest: 5, freezes: 0, lastPeriod: null, status: "broken" } })));
  assert.ok(broken.querySelector(".os-streak").classList.contains("os-streak--none"));
  assert.equal(broken.querySelector(".os-streak__freezes"), null);
});

test("LevelBar is an accessible progress bar", () => {
  const f = fragment(renderToStaticMarkup(h(LevelBar, { level: { current: 3, points: 100, startsAt: 60, nextAt: 120 } })));
  const bar = f.querySelector("[role=progressbar]");
  assert.equal(bar.getAttribute("aria-valuenow"), "67");
  assert.equal(bar.getAttribute("aria-valuetext"), "67% to level 4");
  assert.equal(f.querySelector(".os-level__fill").style.width, "67%");
  assert.equal(f.querySelector(".os-level__progress").textContent, "40 / 60 XP");

  const max = fragment(renderToStaticMarkup(h(LevelBar, { level: { current: 6, points: 900, startsAt: 500, nextAt: null } })));
  assert.equal(max.querySelector("[role=progressbar]").getAttribute("aria-valuetext"), "Max level");
  assert.equal(max.querySelector(".os-level__progress").textContent, "Max level");
});

test("BadgeGrid shows unlocked badges and the rest as locked", () => {
  const unlocked = [{ id: "first", name: "First steps", unlockedAt: "2026-11-20T10:00:00.000Z" }];
  const all = [{ id: "first", name: "First steps" }, { id: "week", name: "Week warrior", description: "7 days in a row" }];
  const f = fragment(renderToStaticMarkup(h(BadgeGrid, { unlocked, all })));
  const items = [...f.querySelectorAll(".os-badge")];
  assert.equal(items.length, 2, "first is not shown twice");
  assert.ok(items[0].classList.contains("os-badge--unlocked"));
  assert.equal(items[0].querySelector("time").getAttribute("datetime"), "2026-11-20T10:00:00.000Z");
  assert.equal(items[1].getAttribute("aria-label"), "Week warrior (locked)");
  assert.equal(f.querySelector(".os-badges__empty"), null);
  assert.ok(fragment(renderToStaticMarkup(h(BadgeGrid, { unlocked: [] }))).querySelector(".os-badges__empty"));
});

const board = {
  id: "xp_all",
  currency: "xp",
  period: "all",
  from: null,
  to: null,
  entries: [
    { rank: 1, userId: "a", score: 1500, displayName: "Asha Kumar", avatarUrl: "https://example.com/a.png" },
    { rank: 2, userId: "b", score: 900, displayName: null, avatarUrl: null },
  ],
  user: { rank: 7, userId: "me", score: 120, displayName: "Me", avatarUrl: null },
};

test("Leaderboard ranks users, shows avatars or initials, and adds your row below", () => {
  const f = fragment(renderToStaticMarkup(h(Leaderboard, { board, currentUserId: "me", title: "All time", formatScore: (n) => String(n) })));
  assert.equal(f.querySelector("section").getAttribute("aria-label"), "All time");
  const rows = [...f.querySelectorAll(".os-row")];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].getAttribute("value"), "1");
  assert.equal(rows[0].querySelector("img").getAttribute("alt"), "", "decorative avatar");
  assert.equal(rows[1].querySelector(".os-avatar--initials").textContent, "B", "falls back to user id initials");
  assert.equal(rows[1].querySelector(".os-row__name").textContent, "b");
  const mine = rows[2];
  assert.equal(mine.getAttribute("value"), "7", "your real rank, not 3");
  assert.equal(mine.getAttribute("aria-current"), "true");
  assert.ok(mine.classList.contains("os-row--you"));
  assert.match(mine.textContent, /Me \(you\)/);
  assert.match(rows[0].querySelector(".os-row__score").textContent, /1500 xp/);

  const inTop = fragment(renderToStaticMarkup(h(Leaderboard, { board: { ...board, user: board.entries[0] }, currentUserId: "a" })));
  assert.equal(inTop.querySelectorAll(".os-row").length, 2, "no duplicate row when you are in the top");
  const empty = fragment(renderToStaticMarkup(h(Leaderboard, { board: { ...board, entries: [], user: null } })));
  assert.ok(empty.querySelector(".os-board__empty"));
});

const NOW = Date.parse("2026-11-21T10:00:00Z");
const league = {
  id: "weekly",
  tier: "silver",
  tiers: ["bronze", "silver", "gold"],
  round: { key: "2026-11-16", startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-23T00:00:00.000Z" },
  group: {
    number: 1,
    size: 3,
    entries: [
      { rank: 1, userId: "a", score: 300, displayName: "A", avatarUrl: null, zone: "promotion" },
      { rank: 2, userId: "me", score: 200, displayName: "Me", avatarUrl: null, zone: "safe" },
      { rank: 3, userId: "c", score: 100, displayName: "C", avatarUrl: null, zone: "demotion" },
    ],
  },
  you: { rank: 2, userId: "me", score: 200, displayName: "Me", avatarUrl: null, zone: "safe" },
  previous: { round: "2026-11-09", tier: "bronze", rank: 1, outcome: "promoted", nextTier: "silver" },
};

test("LeagueTable shows zones, time left, last round, and highlights you", () => {
  const f = fragment(renderToStaticMarkup(h(LeagueTable, { status: league, now: NOW })));
  assert.equal(f.querySelector(".os-league__title").textContent, "Silver league");
  assert.equal(f.querySelector(".os-league__ends").textContent, "Ends in 1d 14h");
  assert.equal(f.querySelector(".os-league__previous").textContent, "Last round: Promoted to silver, finished #1");
  const rows = [...f.querySelectorAll(".os-row")];
  assert.ok(rows[0].classList.contains("os-row--promotion"));
  assert.equal(rows[0].querySelector(".os-sr-only").textContent, "promotion zone");
  assert.equal(rows[1].getAttribute("aria-current"), "true", "you, from status.you");
  assert.equal(rows[1].querySelector(".os-row__zone"), null, "safe rows have no marker");
  assert.equal(rows[2].querySelector(".os-sr-only").textContent, "demotion zone");

  const waiting = fragment(renderToStaticMarkup(h(LeagueTable, { status: { ...league, group: null, you: null, previous: null }, now: NOW })));
  assert.ok(waiting.querySelector(".os-league__empty"));
  assert.equal(waiting.querySelector(".os-league__previous"), null);
});

test("LeagueTable counts down live", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-22T23:58:00Z") });
  try {
    const { container, unmount } = mount(h(LeagueTable, { status: league }));
    const ends = () => container.querySelector(".os-league__ends").textContent;
    assert.equal(ends(), "Ends in 2m");
    act(() => mock.timers.tick(61_000));
    assert.equal(ends(), "Ends in less than a minute", "refreshes on its own");
    act(() => mock.timers.tick(60_000));
    assert.equal(ends(), "Round ended");
    unmount();
  } finally {
    mock.timers.reset();
  }
});

test("AchievementToast announces unlocks, closes on click, and auto-dismisses", () => {
  assert.equal(renderToStaticMarkup(h(AchievementToast, { achievements: [] })), "", "nothing to show");

  let dismissed = 0;
  const onDismiss = () => dismissed++;
  const two = [{ id: "a", name: "First steps" }, { id: "b", name: "On fire", description: "3 days in a row" }];
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { container, unmount } = mount(h(AchievementToast, { achievements: two, onDismiss, durationMs: 4000 }));
    const toast = container.querySelector(".os-toast");
    assert.equal(toast.getAttribute("role"), "status");
    assert.equal(toast.getAttribute("aria-live"), "polite");
    assert.equal(container.querySelector(".os-toast__title").textContent, "2 achievements unlocked");

    act(() => container.querySelector(".os-toast__close").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(dismissed, 1, "the close button dismisses");

    act(() => mock.timers.tick(3999));
    assert.equal(dismissed, 1, "not before the duration");
    act(() => mock.timers.tick(1));
    assert.equal(dismissed, 2, "auto-dismissed after the duration");
    unmount();

    const sticky = mount(h(AchievementToast, { achievements: two, onDismiss, durationMs: 0 }));
    act(() => mock.timers.tick(60_000));
    assert.equal(dismissed, 2, "durationMs 0 stays open");
    sticky.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("components accept a className and render on the server without a browser API", () => {
  const html = renderToStaticMarkup(
    h("div", null, h(StreakFlame, { streak: { current: 1, longest: 1, freezes: 0, lastPeriod: "x", status: "done" }, className: "mine" }), h(Leaderboard, { board, className: "board" })),
  );
  assert.match(html, /class="os-streak os-streak--done mine"/);
  assert.match(html, /class="os-board board"/);
});

test("rivalry helpers", () => {
  assert.equal(lib.recordText({ wins: 3, losses: 1, draws: 2 }), "3W 1L 2D");
  assert.equal(lib.rivalScoreText({ you: 1200, them: 900, leading: "you" }, "Maya"), `You lead ${(1200).toLocaleString()} to 900`);
  assert.equal(lib.rivalScoreText({ you: 10, them: 20, leading: "them" }, "Maya"), "Maya leads 20 to 10");
  assert.equal(lib.rivalScoreText({ you: 10, them: 10, leading: "tied" }, "Maya"), "Tied at 10");
  assert.equal(lib.rivalScoreText({ you: 0, them: 0, leading: "tied" }, "Maya"), "No points yet");
  assert.equal(lib.rivalStreakText(null), null);
  assert.equal(lib.rivalStreakText({ outcome: "won", length: 3 }), "Won 3 in a row");
  assert.equal(lib.rivalStreakText({ outcome: "lost", length: 1 }), "Lost the last one");
  assert.equal(lib.rivalStreakText({ outcome: "draw", length: 2 }), "2 draws in a row");
  assert.equal(lib.rivalShare({ you: 0, them: 0 }), 0.5, "an empty round is even");
  assert.equal(lib.rivalShare({ you: 30, them: 10 }), 0.75);
});

test("FriendsList shows friends, custom actions, and an empty state", () => {
  const list = {
    userId: "asha",
    friends: [
      { userId: "maya", displayName: "Maya", avatarUrl: null, since: "2026-11-20T10:00:00.000Z" },
      { userId: "ravi", displayName: null, avatarUrl: "https://example.com/r.png", since: "2026-11-01T10:00:00.000Z" },
    ],
  };
  const f = fragment(renderToStaticMarkup(h(FriendsList, { friends: list, title: "Friends", renderAction: (fr) => h("button", { type: "button" }, `Challenge ${fr.userId}`) })));
  assert.equal(f.querySelector(".os-friends").getAttribute("aria-label"), "Friends");
  const rows = [...f.querySelectorAll(".os-friend")];
  assert.deepEqual(rows.map((r) => r.querySelector(".os-friend__name").textContent), ["Maya", "ravi"], "falls back to the user id");
  assert.equal(rows[0].querySelector(".os-avatar--initials").textContent, "MA");
  assert.equal(rows[1].querySelector("img").getAttribute("src"), "https://example.com/r.png");
  assert.equal(rows[0].querySelector("time").getAttribute("datetime"), "2026-11-20T10:00:00.000Z");
  assert.equal(rows[1].querySelector(".os-friend__action button").textContent, "Challenge ravi");

  const empty = fragment(renderToStaticMarkup(h(FriendsList, { friends: { userId: "asha", friends: [] }, emptyText: "Invite someone" })));
  assert.equal(empty.querySelector(".os-friends__empty").textContent, "Invite someone");
});

const RIVAL_NOW = Date.parse("2026-11-21T10:00:00Z");
const rivalry = {
  rivalryId: "weekly_duel",
  userId: "asha",
  round: { key: "2026-11-16", startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-23T00:00:00.000Z" },
  rivals: [
    {
      rivalId: "maya",
      displayName: "Maya",
      avatarUrl: null,
      since: "2026-11-01T00:00:00.000Z",
      current: { you: 30, them: 10, leading: "you" },
      record: { wins: 3, losses: 1, draws: 0 },
      streak: { outcome: "won", length: 2 },
      last: { round: "2026-11-09", you: 50, them: 40, outcome: "won" },
    },
    {
      rivalId: "ravi",
      displayName: null,
      avatarUrl: null,
      since: "2026-11-20T00:00:00.000Z",
      current: { you: 0, them: 0, leading: "tied" },
      record: { wins: 0, losses: 0, draws: 0 },
      streak: null,
      last: null,
    },
  ],
};

test("RivalCard shows the live score, time left, record, streak and last round", () => {
  const f = fragment(renderToStaticMarkup(h(RivalCard, { rival: rivalry.rivals[0], round: rivalry.round, now: RIVAL_NOW })));
  const card = f.querySelector(".os-rival");
  assert.ok(card.classList.contains("os-rival--you"));
  assert.equal(card.getAttribute("aria-label"), "You vs Maya");
  assert.equal(f.querySelector(".os-rival__ends").textContent, "Ends in 1d 14h");
  assert.equal(f.querySelector(".os-rival__status").textContent, "You lead 30 to 10");
  assert.equal(f.querySelector(".os-rival__bar-you").style.width, "75%");
  const stats = [...f.querySelectorAll(".os-rival__stats dd")].map((d) => d.textContent);
  assert.deepEqual(stats, ["3W 1L 0D", "Won 2 in a row", "Won 50 to 40"]);
  assert.equal(f.querySelector(".os-rival__stats dd").getAttribute("aria-label"), "3 wins, 1 losses, 0 draws");

  const fresh = fragment(renderToStaticMarkup(h(RivalCard, { rival: rivalry.rivals[1], round: rivalry.round, now: RIVAL_NOW })));
  assert.equal(fresh.querySelector(".os-rival__name").textContent, "You vs ravi");
  assert.equal(fresh.querySelector(".os-rival__status").textContent, "No points yet");
  assert.equal(fresh.querySelector(".os-rival__bar-you").style.width, "50%");
  assert.equal(fresh.querySelectorAll(".os-rival__stats dd").length, 1, "no streak or last round yet");
});

test("RivalList renders one card per rival, or an empty state", () => {
  const f = fragment(renderToStaticMarkup(h(RivalList, { status: rivalry, title: "Weekly duels", unitLabel: "min", now: RIVAL_NOW })));
  assert.equal(f.querySelector(".os-rivals__title").textContent, "Weekly duels");
  assert.equal(f.querySelectorAll(".os-rival").length, 2);
  assert.match(f.querySelector(".os-rival__you").textContent, /30 min/);
  const empty = fragment(renderToStaticMarkup(h(RivalList, { status: { ...rivalry, rivals: [] }, now: RIVAL_NOW })));
  assert.equal(empty.querySelector(".os-rivals__empty").textContent, "No rivals yet. Challenge a friend.");
});

test("RivalCard counts down live", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-22T23:59:30Z") });
  try {
    const { container, unmount } = mount(h(RivalCard, { rival: rivalry.rivals[0], round: rivalry.round }));
    const ends = () => container.querySelector(".os-rival__ends").textContent;
    assert.equal(ends(), "Ends in less than a minute");
    act(() => mock.timers.tick(31_000));
    assert.equal(ends(), "Round ended");
    unmount();
  } finally {
    mock.timers.reset();
  }
});

const questData = {
  userId: "asha",
  quests: [
    { id: "three", name: "Three lessons", description: "Finish 3 lessons today", period: "daily", goal: { event: "lesson_completed", target: 3 }, progress: 3, target: 3, completed: true, completedAt: "2026-11-21T08:00:00.000Z", rewards: [{ currency: "coins", amount: 5 }], startsAt: "2026-11-21T00:00:00.000Z", endsAt: "2026-11-22T00:00:00.000Z" },
    { id: "xp", name: "Earn XP", period: "daily", goal: { points: "xp", target: 50 }, progress: 20, target: 50, completed: false, completedAt: null, rewards: [], startsAt: "2026-11-21T00:00:00.000Z", endsAt: "2026-11-22T00:00:00.000Z" },
    { id: "hour", name: "Study an hour", period: "weekly", goal: { event: "minutes_studied", target: 60 }, progress: 75, target: 60, completed: false, completedAt: null, rewards: [{ currency: "xp", amount: 1000 }, { currency: "coins", amount: 2 }], startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-23T00:00:00.000Z" },
  ],
};

test("quest helpers", () => {
  assert.equal(lib.rewardText([]), null);
  assert.equal(lib.rewardText([{ currency: "xp", amount: 1000 }, { currency: "coins", amount: 2 }]), `+${(1000).toLocaleString()} xp, +2 coins`);
  assert.equal(lib.questProgressText({ progress: 2, target: 3 }), "2 / 3");
  assert.equal(lib.questProgressText({ progress: 75, target: 60 }, undefined, "min"), "60 / 60 min", "never shows more than the target");
});

test("QuestList shows progress, rewards and reset time, open quests first", () => {
  const f = fragment(renderToStaticMarkup(h(QuestList, { quests: questData, title: "Quests", now: NOW, unitLabel: (q) => (q.id === "hour" ? "min" : undefined) })));
  assert.equal(f.querySelector(".os-quests__count").textContent, "1 / 3 done");
  const items = [...f.querySelectorAll(".os-quest")];
  assert.deepEqual(items.map((i) => i.querySelector(".os-quest__name").textContent), ["Earn XP", "Study an hour", "Three lessons"], "finished quests go last");
  const [xp, hour, three] = items;
  assert.equal(xp.querySelector(".os-quest__progress").textContent, "20 / 50 xp", "points goals show the currency");
  assert.equal(xp.querySelector(".os-quest__fill").style.width, "40%");
  assert.equal(xp.querySelector(".os-quest__reward"), null);
  assert.equal(xp.querySelector(".os-quest__ends").textContent, "Ends in 14h");
  const bar = hour.querySelector("[role=progressbar]");
  assert.equal(bar.getAttribute("aria-valuetext"), "60 / 60 min");
  assert.equal(hour.querySelector(".os-quest__fill").style.width, "100%", "capped at full");
  assert.equal(hour.querySelector(".os-quest__ends").textContent, "Ends in 1d 14h");
  assert.ok(three.classList.contains("os-quest--done"));
  assert.equal(three.querySelector(".os-quest__progress").textContent, "Done");
  assert.equal(three.querySelector(".os-quest__reward").textContent, "+5 coins");
  assert.equal(three.querySelector(".os-quest__description").textContent, "Finish 3 lessons today");
  assert.equal(three.querySelector(".os-quest__ends").textContent, "New quest in 14h");

  const weekly = fragment(renderToStaticMarkup(h(QuestList, { quests: questData, period: "weekly", now: NOW })));
  assert.equal(weekly.querySelectorAll(".os-quest").length, 1);
  const none = fragment(renderToStaticMarkup(h(QuestList, { quests: { userId: "a", quests: [] }, title: "Quests", now: NOW })));
  assert.equal(none.querySelector(".os-quests__empty").textContent, "No quests right now.");
  assert.equal(none.querySelector(".os-quests__count"), null);
});

const storeData = {
  userId: "asha",
  wallet: { xp: 120, coins: 7 },
  items: [
    { id: "sticker", name: "Sticker", price: { currency: "coins", amount: 1 }, limit: null, owned: 3, canBuy: true, metadata: { icon: "⭐" } },
    { id: "freeze", name: "Streak freeze", description: "Keeps your streak for a day", price: { currency: "coins", amount: 10 }, limit: 2, owned: 0, canBuy: false },
    { id: "frame", name: "Gold frame", price: { currency: "coins", amount: 0 }, limit: 1, owned: 1, canBuy: false },
  ],
};

test("store helpers", () => {
  assert.equal(lib.priceText({ currency: "coins", amount: 0 }), "Free");
  assert.equal(lib.priceText({ currency: "coins", amount: 1500 }), `${(1500).toLocaleString()} coins`);
  assert.equal(lib.ownedText({ owned: 0, limit: null }), null);
  assert.equal(lib.ownedText({ owned: 2, limit: null }), "Owned 2");
  assert.equal(lib.ownedText({ owned: 1, limit: 3 }), "Owned 1 of 3");
  const [sticker, freeze, frame] = storeData.items;
  assert.equal(lib.storeItemBlocker(sticker, storeData.wallet), null);
  assert.equal(lib.storeItemBlocker(freeze, storeData.wallet), "Need 3 more coins");
  assert.equal(lib.storeItemBlocker(frame, storeData.wallet), "Limit reached");
  assert.equal(lib.storeItemBlocker({ ...freeze, price: { currency: "gems", amount: 2 } }, {}), "Need 2 more gems", "missing wallet entries count as 0");
});

test("RewardStore shows prices, owned counts, blockers and your buttons", () => {
  const f = fragment(
    renderToStaticMarkup(
      h(RewardStore, {
        store: storeData,
        title: "Shop",
        renderIcon: (item) => item.metadata?.icon ?? null,
        renderAction: (item) => h("button", { disabled: !item.canBuy, "data-item": item.id }, "Buy"),
      }),
    ),
  );
  assert.equal(f.querySelector("section").getAttribute("aria-label"), "Shop");
  assert.equal(f.querySelector(".os-store__wallet").textContent, "7 coins", "only currencies items are priced in");
  const items = [...f.querySelectorAll(".os-item")];
  assert.deepEqual(items.map((i) => i.querySelector(".os-item__name").textContent), ["Sticker", "Streak freeze", "Gold frame"]);
  const [sticker, freeze, frame] = items;
  assert.equal(sticker.querySelector(".os-item__icon").textContent, "⭐");
  assert.equal(freeze.querySelector(".os-item__icon"), null, "no icon box without an icon");
  assert.equal(sticker.querySelector(".os-item__price").textContent, "1 coins");
  assert.equal(sticker.querySelector(".os-item__owned").textContent, "Owned 3");
  assert.equal(sticker.querySelector(".os-item__blocker"), null);
  assert.equal(sticker.querySelector("button").disabled, false);
  assert.ok(freeze.classList.contains("os-item--blocked"));
  assert.equal(freeze.querySelector(".os-item__description").textContent, "Keeps your streak for a day");
  assert.equal(freeze.querySelector(".os-item__blocker").textContent, "Need 3 more coins");
  assert.equal(freeze.querySelector(".os-item__owned"), null);
  assert.equal(freeze.querySelector("button").disabled, true);
  assert.equal(frame.querySelector(".os-item__price").textContent, "Free");
  assert.equal(frame.querySelector(".os-item__owned").textContent, "Owned 1 of 1");
  assert.equal(frame.querySelector(".os-item__blocker").textContent, "Limit reached");

  const empty = fragment(renderToStaticMarkup(h(RewardStore, { store: { userId: "a", wallet: {}, items: [] } })));
  assert.equal(empty.querySelector(".os-store__empty").textContent, "Nothing to buy yet.");
  assert.equal(empty.querySelector(".os-store__header"), null);
  assert.equal(empty.querySelector("section").getAttribute("aria-label"), "Reward store");
});

const calendarData = (claimedToday) => ({
  id: "login",
  name: "Daily login",
  event: "app_opened",
  day: 2,
  claimedToday,
  days: [
    { day: 1, rewards: [{ currency: "coins", amount: 5 }], status: "claimed" },
    { day: 2, rewards: [{ currency: "coins", amount: 10 }], status: claimedToday ? "claimed" : "today" },
    { day: 3, rewards: [], status: "upcoming" },
  ],
  nextClaimAt: new Date(NOW + 5 * 3_600_000).toISOString(),
});

test("RewardCalendar ticks claimed days, highlights today and offers a claim", () => {
  const f = fragment(renderToStaticMarkup(h(RewardCalendar, { calendar: calendarData(false), now: NOW, renderAction: () => h("button", null, "Claim") })));
  assert.equal(f.querySelector("section").getAttribute("aria-label"), "Daily login");
  assert.equal(f.querySelector(".os-calendar__day").textContent, "Day 2 of 3");
  const cells = [...f.querySelectorAll(".os-calendar__cell")];
  assert.deepEqual(cells.map((c) => c.querySelector(".os-calendar__number").textContent), ["✓", "2", "3"]);
  assert.deepEqual(cells.map((c) => c.querySelector(".os-calendar__reward").textContent), ["+5 coins", "+10 coins", "–"]);
  assert.equal(cells[1].getAttribute("aria-current"), "date");
  assert.equal(cells[1].getAttribute("aria-label"), "Day 2: +10 coins, ready to claim");
  assert.equal(cells[2].getAttribute("aria-label"), "Day 3: nothing, upcoming");
  assert.ok(cells[0].classList.contains("os-calendar__cell--claimed"));
  assert.equal(f.querySelector(".os-calendar__next").textContent, "Today: +10 coins");
  assert.equal(f.querySelector(".os-calendar__action button").textContent, "Claim");

  const done = fragment(renderToStaticMarkup(h(RewardCalendar, { calendar: calendarData(true), title: "Check in", now: NOW, renderAction: () => h("button", null, "Claim") })));
  assert.equal(done.querySelector("h3").textContent, "Check in");
  assert.equal(done.querySelector(".os-calendar__next").textContent, "Next reward in 5h");
  assert.equal(done.querySelector("button"), null, "no claim button once claimed");
  assert.equal(done.querySelector("[aria-current]"), null);

  const unnamed = fragment(renderToStaticMarkup(h(RewardCalendar, { calendar: { ...calendarData(true), name: undefined }, now: NOW })));
  assert.equal(unnamed.querySelector("h3").textContent, "Daily rewards");
});

test("QuestList shows one-off quests without a reset countdown", () => {
  const once = (extra) => ({ id: "first", name: "First lesson", period: "once", goal: { event: "lesson_completed", target: 1 }, progress: 0, target: 1, completed: false, completedAt: null, rewards: [], startsAt: null, endsAt: null, until: null, ...extra });
  const f = fragment(renderToStaticMarkup(h(QuestList, { quests: { userId: "a", quests: [once({}), once({ id: "second", name: "Five lessons", after: "first", target: 5, endsAt: new Date(NOW + 3 * 3_600_000).toISOString() })] }, now: NOW })));
  const [first, second] = [...f.querySelectorAll(".os-quest")];
  assert.equal(first.querySelector(".os-quest__ends"), null, "no end, no countdown");
  assert.equal(second.querySelector(".os-quest__ends").textContent, "Ends in 3h");
  const done = fragment(renderToStaticMarkup(h(QuestList, { quests: { userId: "a", quests: [once({ completed: true, progress: 1, endsAt: new Date(NOW + 3_600_000).toISOString() })] }, now: NOW })));
  assert.equal(done.querySelector(".os-quest__ends"), null, "a finished one-off quest never comes back");
});
