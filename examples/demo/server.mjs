// onstreak demo: a tiny study app showing streaks, levels, badges, a
// leaderboard, a league, quests, a login calendar, a reward store, friends and head-to-head rivals, with simulated players and a "next day" button.
// Runs entirely in memory: no database, no keys.
//
//   npm run build && npm run demo     # then open http://localhost:3000
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Engine, MemoryStore } from "@onstreak/engine";
import { StreakFlame, LevelBar, BadgeGrid, Leaderboard, LeagueTable, AchievementToast, FriendsList, RivalList, QuestList, RewardStore, RewardCalendar } from "@onstreak/react";

const DAY = 86_400_000;
const START = Date.parse("2026-11-16T09:00:00Z"); // a Monday morning
const YOU = "you";

export const demoConfig = {
  defaultTimezone: "UTC",
  currencies: ["xp", "coins"],
  points: [
    { event: "lesson_completed", currency: "xp", amount: 10 },
    { event: "lesson_completed", currency: "coins", amount: 1 },
    { event: "minutes_studied", currency: "xp", amount: 1, multiplyByValue: true },
  ],
  levels: { currency: "xp", thresholds: [30, 80, 150, 250, 400, 600, 900] },
  streaks: [{ id: "daily_lesson", event: "lesson_completed", period: "daily", freezes: { start: 1, max: 2, earnEvery: 7 } }],
  achievements: [
    { id: "first_lesson", name: "First steps", description: "Finish a lesson", when: { metric: "lesson_completed", gte: 1 } },
    { id: "streak_3", name: "On fire", description: "3 days in a row", when: { streak: "daily_lesson", gte: 3 } },
    { id: "streak_7", name: "Week warrior", description: "7 days in a row", when: { streak: "daily_lesson", gte: 7 } },
    { id: "lessons_10", name: "Dedicated", description: "Finish 10 lessons", when: { metric: "lesson_completed", gte: 10 } },
    { id: "xp_100", name: "Centurion", description: "Earn 100 XP", when: { points: "xp", gte: 100 } },
    { id: "xp_500", name: "Scholar", description: "Earn 500 XP", when: { points: "xp", gte: 500 } },
  ],
  leaderboards: [
    { id: "xp_weekly", currency: "xp", period: "weekly" },
    { id: "xp_all", currency: "xp", period: "all" },
  ],
  leagues: [{ id: "weekly_league", currency: "xp", tiers: ["bronze", "silver", "gold", "sapphire", "diamond"], groupSize: 8, promote: 2, demote: 2 }],
  rivalries: [{ id: "weekly_duel", currency: "xp", max: 3 }],
  quests: [
    { id: "two_lessons", name: "Two lessons", description: "Finish 2 lessons today", period: "daily", goal: { event: "lesson_completed", target: 2 }, rewards: [{ currency: "coins", amount: 3 }] },
    { id: "daily_xp", name: "Earn 40 XP", period: "daily", goal: { points: "xp", target: 40 }, rewards: [{ currency: "xp", amount: 10 }] },
    { id: "study_hour", name: "Study for an hour", description: "Across the week", period: "weekly", goal: { event: "minutes_studied", target: 60 }, rewards: [{ currency: "coins", amount: 10 }, { currency: "xp", amount: 50 }] },
  ],
  calendars: [
    {
      id: "daily_login",
      name: "Daily check-in",
      event: "checked_in",
      days: [2, 3, 3, 5, 5, 8].map((amount) => ({ rewards: [{ currency: "coins", amount }] })).concat([{ rewards: [{ currency: "coins", amount: 15 }, { currency: "xp", amount: 50 }] }]),
    },
  ],
  items: [
    { id: "streak_freeze", name: "Streak freeze", description: "Use it to cover a missed day", price: { currency: "coins", amount: 4 }, limit: 2, effect: { streakFreeze: "daily_lesson" }, metadata: { icon: "🧊" } },
    { id: "xp_potion", name: "XP potion", description: "Double XP for 30 minutes", price: { currency: "coins", amount: 3 }, effect: { boost: { factor: 2, minutes: 30, currency: "xp" } }, metadata: { icon: "🧪" } },
    { id: "sticker_pack", name: "Sticker pack", description: "Show off in chat", price: { currency: "coins", amount: 2 }, metadata: { icon: "🌟" } },
    { id: "night_theme", name: "Night theme", price: { currency: "coins", amount: 5 }, limit: 1, metadata: { icon: "🌙" } },
    { id: "gold_frame", name: "Gold frame", description: "A frame for your avatar", price: { currency: "coins", amount: 8 }, limit: 1, metadata: { icon: "🖼️" } },
  ],
};

/** Players you start out friends with. */
const FRIENDS = ["maya", "ravi", "zoe"];

const RIVALS = [
  { id: "maya", name: "Maya", effort: 0.9 },
  { id: "ravi", name: "Ravi", effort: 0.7 },
  { id: "zoe", name: "Zoe", effort: 0.55 },
  { id: "arjun", name: "Arjun", effort: 0.45 },
  { id: "lena", name: "Lena", effort: 0.3 },
];

/** Small seeded random generator, so the demo (and its tests) are repeatable. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const styles = readFileSync(new URL("../../packages/react/styles.css", import.meta.url), "utf8");

const page = (body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>onstreak demo</title>
<style>
${styles}
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: Canvas; color: CanvasText; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
header.top { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 20px; }
h1 { font-size: 1.4rem; margin: 0; }
.muted { color: GrayText; font-size: 0.875rem; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.actions form { margin: 0; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #d0d7de; background: Canvas; color: CanvasText; cursor: pointer; }
button.primary { background: #f97316; border-color: #f97316; color: #fff; font-weight: 600; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.card { border: 1px solid #d0d7de; border-radius: 12px; padding: 16px; }
.card h2 { font-size: 1rem; margin: 0 0 12px; }
.stats { display: flex; align-items: center; gap: 20px; margin-bottom: 14px; }
.toast-wrap { position: fixed; right: 16px; bottom: 16px; }
.events { list-style: none; padding: 0; margin: 0; font-size: 0.875rem; }
button.small { padding: 4px 10px; font-size: 0.8125rem; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.item-actions { display: flex; gap: 6px; }
.boost { margin: 0 0 12px; font-size: 0.875rem; font-weight: 600; color: #8250df; }
.spaced { margin-top: 16px; }
.events li { padding: 4px 0; border-top: 1px solid #d0d7de33; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export function createDemo({ seed = 42 } = {}) {
  let offset = 0;
  let engine;
  let random;

  const now = () => START + offset;

  async function reset() {
    offset = 0;
    random = rng(seed);
    engine = new Engine(demoConfig, new MemoryStore(), now);
    await engine.updateUser(YOU, { displayName: "You" });
    for (const r of RIVALS) await engine.updateUser(r.id, { displayName: r.name });
    for (const f of FRIENDS) await engine.addFriend(YOU, f);
    await engine.addRival("weekly_duel", YOU, "maya");
    await rivalsPlay();
  }

  /** Each rival may study today, more often the keener they are. */
  async function rivalsPlay() {
    for (const r of RIVALS) {
      if (random() > r.effort) continue;
      const lessons = 1 + Math.floor(random() * 3);
      for (let i = 0; i < lessons; i++) await engine.track({ userId: r.id, event: "lesson_completed" });
      await engine.track({ userId: r.id, event: "minutes_studied", value: 5 + Math.floor(random() * 25) });
    }
  }

  async function render(unlocked) {
    const [user, weekly, league, history, friends, rivals, friendsBoard, quests, shop, calendars] = await Promise.all([
      engine.getUser(YOU),
      engine.leaderboard("xp_weekly", { userId: YOU, limit: 10 }),
      engine.league("weekly_league", YOU),
      engine.events(YOU, { limit: 6 }),
      engine.friends(YOU),
      engine.rivals("weekly_duel", YOU),
      engine.leaderboard("xp_weekly", { userId: YOU, scope: "friends" }),
      engine.quests(YOU),
      engine.rewardStore(YOU),
      engine.calendars(YOU),
    ]);
    const freezesFull = user.streaks.daily_lesson.freezes >= demoConfig.streaks[0].freezes.max;
    const buyButton = (item) =>
      h(
        "span",
        { className: "item-actions" },
        item.owned > 0 &&
          demoConfig.items.find((i) => i.id === item.id)?.effect &&
          h(
            "form",
            { method: "post", action: `/use/${item.id}` },
            h("button", { type: "submit", className: "small", disabled: item.id === "streak_freeze" && freezesFull, title: item.id === "streak_freeze" && freezesFull ? "You already hold the most freezes" : undefined }, "Use"),
          ),
        h("form", { method: "post", action: `/buy/${item.id}` }, h("button", { type: "submit", className: "small", disabled: !item.canBuy }, "Buy")),
      );
    const rivalIds = new Set(rivals.rivals.map((r) => r.rivalId));
    const rivalButton = (f) =>
      rivalIds.has(f.userId)
        ? h("form", { method: "post", action: `/unrival/${f.userId}` }, h("button", { type: "submit", className: "small" }, "End rivalry"))
        : h("form", { method: "post", action: `/rival/${f.userId}` }, h("button", { type: "submit", className: "small" }, "Challenge"));
    const day = new Date(now()).toISOString().slice(0, 10);
    const weekday = new Date(now()).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const toast = unlocked.length > 0 ? demoConfig.achievements.filter((a) => unlocked.includes(a.id)) : [];
    const markup = renderToStaticMarkup(
      h(
        Fragment,
        null,
        h(
          "header",
          { className: "top" },
          h("div", null, h("h1", null, "onstreak demo"), h("div", { className: "muted" }, `${weekday}, ${day}. Rivals study on their own each day.`)),
          h(
            "div",
            { className: "actions" },
            h("form", { method: "post", action: "/do/lesson" }, h("button", { className: "primary", type: "submit" }, "Finish a lesson (+10 XP)")),
            h("form", { method: "post", action: "/do/study" }, h("button", { type: "submit" }, "Study 15 min (+15 XP)")),
            h("form", { method: "post", action: "/next-day" }, h("button", { type: "submit" }, "Next day ⏭")),
            h("form", { method: "post", action: "/next-week" }, h("button", { type: "submit" }, "Skip a week")),
            h("form", { method: "post", action: "/reset" }, h("button", { type: "submit" }, "Reset")),
          ),
        ),
        h(
          "div",
          { className: "grid" },
          h(
            "section",
            { className: "card" },
            h("h2", null, "Your progress"),
            h("div", { className: "stats" }, h(StreakFlame, { streak: user.streaks.daily_lesson }), h("span", { className: "muted" }, `${user.wallet.coins} coins`)),
            user.boosts.length > 0 &&
              h(
                "p",
                { className: "boost" },
                `🧪 ${user.boosts[0].factor}x ${user.boosts[0].currency ?? "points"} for ${Math.max(1, Math.round((Date.parse(user.boosts[user.boosts.length - 1].endsAt) - now()) / 60_000))} more min`,
              ),
            user.level && h(LevelBar, { level: user.level }),
          ),
          h(
            "section",
            { className: "card" },
            h(QuestList, { quests, title: "Quests", now: now(), unitLabel: (q) => (q.id === "study_hour" ? "min" : undefined) }),
          ),
          h(
            "section",
            { className: "card" },
            h(RewardCalendar, {
              calendar: calendars.calendars[0],
              now: now(),
              renderAction: () => h("form", { method: "post", action: "/check-in" }, h("button", { type: "submit", className: "small primary" }, "Claim")),
            }),
          ),
          h(
            "section",
            { className: "card" },
            h(RewardStore, { store: shop, title: "Shop", renderIcon: (item) => item.metadata?.icon ?? null, renderAction: buyButton }),
          ),
          h("section", { className: "card" }, h(LeagueTable, { status: league, now: now() })),
          h("section", { className: "card" }, h(Leaderboard, { board: weekly, currentUserId: YOU, title: "This week" })),
          h("section", { className: "card" }, h(RivalList, { status: rivals, title: "Weekly duels", now: now() })),
          h(
            "section",
            { className: "card" },
            h(FriendsList, { friends, title: "Friends", renderAction: rivalButton }),
            h("div", { className: "spaced" }, h(Leaderboard, { board: friendsBoard, currentUserId: YOU, title: "Friends this week" })),
          ),
          h(
            "section",
            { className: "card" },
            h("h2", null, "Achievements"),
            h(BadgeGrid, { unlocked: user.achievements, all: demoConfig.achievements }),
          ),
          h(
            "section",
            { className: "card" },
            h("h2", null, "Recent activity"),
            history.events.length === 0
              ? h("p", { className: "muted" }, "Nothing yet. Finish a lesson!")
              : h(
                  "ul",
                  { className: "events" },
                  history.events.map((e) =>
                    h("li", { key: e.id }, `${e.timestamp.slice(0, 10)}: ${e.event.replace("_", " ")}${e.result?.points.xp ? `, +${e.result.points.xp.awarded} XP` : ""}`),
                  ),
                ),
          ),
        ),
        toast.length > 0 && h("div", { className: "toast-wrap" }, h(AchievementToast, { achievements: toast })),
      ),
    );
    return page(markup);
  }

  const ready = reset();

  const server = createServer(async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url ?? "/", "http://localhost");
      const back = (unlocked = []) => {
        res.writeHead(303, { location: unlocked.length ? `/?unlocked=${unlocked.join(",")}` : "/" });
        res.end();
      };
      if (req.method === "GET" && url.pathname === "/") {
        const unlocked = (url.searchParams.get("unlocked") ?? "").split(",").filter(Boolean);
        const html = await render(unlocked);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      if (req.method === "POST" && url.pathname === "/do/lesson") {
        const r = await engine.track({ userId: YOU, event: "lesson_completed" });
        return back(r.achievements.map((a) => a.id));
      }
      if (req.method === "POST" && url.pathname === "/check-in") {
        const r = await engine.track({ userId: YOU, event: "checked_in" });
        return back(r.achievements.map((a) => a.id));
      }
      if (req.method === "POST" && url.pathname === "/do/study") {
        const r = await engine.track({ userId: YOU, event: "minutes_studied", value: 15 });
        return back(r.achievements.map((a) => a.id));
      }
      if (req.method === "POST" && (url.pathname === "/next-day" || url.pathname === "/next-week")) {
        const days = url.pathname === "/next-day" ? 1 : 7;
        for (let i = 0; i < days; i++) {
          offset += DAY;
          await rivalsPlay();
        }
        return back();
      }
      const rival = /^\/(un)?rival\/([a-z]+)$/.exec(url.pathname);
      if (req.method === "POST" && rival && RIVALS.some((r) => r.id === rival[2])) {
        const [, un, id] = rival;
        if (un) await engine.removeRival("weekly_duel", YOU, id);
        else await engine.addRival("weekly_duel", YOU, id).catch((e) => { if (e.status !== 409) throw e; });
        return back();
      }
      const buy = /^\/buy\/([a-z_]+)$/.exec(url.pathname);
      if (req.method === "POST" && buy && demoConfig.items.some((i) => i.id === buy[1])) {
        // The button is disabled when you cannot buy; a refusal from a stale page just reloads it.
        await engine.purchase(YOU, { item: buy[1] }).catch((e) => { if (e.status !== 409) throw e; });
        return back();
      }
      const use = /^\/use\/([a-z_]+)$/.exec(url.pathname);
      if (req.method === "POST" && use && demoConfig.items.some((i) => i.id === use[1])) {
        await engine.useItem(YOU, use[1]).catch((e) => { if (e.status !== 409) throw e; });
        return back();
      }
      if (req.method === "POST" && url.pathname === "/reset") {
        await reset();
        return back();
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("demo error");
    }
  });

  return { server, ready, now };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3000);
  const { server } = createDemo();
  server.listen(port, () => console.log(`onstreak demo on http://localhost:${port}`));
}
