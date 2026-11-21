/** Shared test config: a small study app. */
export const config = {
  defaultTimezone: "Asia/Kolkata",
  currencies: ["xp", "coins"],
  points: [
    { event: "lesson_completed", currency: "xp", amount: 10 },
    { event: "lesson_completed", currency: "coins", amount: 1 },
    { event: "minutes_studied", currency: "xp", amount: 2, multiplyByValue: true },
  ],
  levels: { currency: "xp", thresholds: [25, 60, 120] },
  streaks: [{ id: "daily_lesson", event: "lesson_completed", period: "daily", freezes: { start: 1, max: 2 } }],
  achievements: [
    { id: "first_lesson", name: "First steps", when: { metric: "lesson_completed", gte: 1 } },
    { id: "streak_3", name: "On fire", when: { streak: "daily_lesson", gte: 3 } },
    { id: "xp_100", name: "Centurion", when: { points: "xp", gte: 100 } },
  ],
  leaderboards: [
    { id: "xp_weekly", currency: "xp", period: "weekly" },
    { id: "xp_all", currency: "xp", period: "all" },
  ],
  leagues: [{ id: "study_league", currency: "xp", tiers: ["bronze", "silver", "gold"] }],
  rivalries: [{ id: "weekly_duel", currency: "xp" }],
};
