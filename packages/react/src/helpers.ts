/** Small pure helpers behind the components. Exported so apps can reuse them. */

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/** How far through the current level, from 0 to 1. A max-level user is full. */
export function levelProgress(level: { points: number; startsAt: number; nextAt: number | null }): number {
  if (level.nextAt === null) return 1;
  const span = level.nextAt - level.startsAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (level.points - level.startsAt) / span));
}

/** Up to two letters for an avatar placeholder: "Asha Kumar" -> "AK", "asha" -> "AS". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? `${[...words[0]!][0]}${[...words[1]!][0]}` : [...words[0]!].slice(0, 2).join("");
  return letters.toUpperCase();
}

/** "2d 4h", "3h 12m", "12m", "less than a minute", or "ended". */
export function formatTimeLeft(ms: number): string {
  if (ms <= 0) return "ended";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export type StreakStatus = "none" | "done" | "pending" | "broken";

/** A sentence describing a streak, for screen readers and tooltips. */
export function streakLabel(streak: { current: number; status: StreakStatus; freezes: number }, unit: "day" | "week" = "day"): string {
  const period = unit === "day" ? "today" : "this week";
  const freezes = streak.freezes > 0 ? `, ${streak.freezes} freeze${streak.freezes === 1 ? "" : "s"} left` : "";
  if (streak.status === "none" || streak.current === 0) return streak.status === "broken" ? "Streak broken" : "No streak yet";
  const length = `${streak.current} ${unit} streak`;
  if (streak.status === "done") return `${length}, done ${period}${freezes}`;
  return `${length}, do it ${period} to keep it${freezes}`;
}

/** The name to show for a ranked user. */
export function displayNameOf(entry: { userId: string; displayName: string | null }): string {
  return entry.displayName ?? entry.userId;
}

/** Milliseconds until the next countdown refresh: every second in the last minute, else every 30 s. */
export function countdownTick(msLeft: number): number {
  return msLeft <= 60_000 ? 1000 : 30_000;
}

/** "3W 1L 2D". */
export function recordText(record: { wins: number; losses: number; draws: number }): string {
  return `${record.wins}W ${record.losses}L ${record.draws}D`;
}

/** Who is ahead this round, in words: "You lead 30 to 20", "Maya leads 20 to 10", "Tied at 10", "No points yet". */
export function rivalScoreText(current: { you: number; them: number; leading: "you" | "them" | "tied" }, rivalName: string): string {
  if (current.leading === "you") return `You lead ${current.you.toLocaleString()} to ${current.them.toLocaleString()}`;
  if (current.leading === "them") return `${rivalName} leads ${current.them.toLocaleString()} to ${current.you.toLocaleString()}`;
  return current.you === 0 ? "No points yet" : `Tied at ${current.you.toLocaleString()}`;
}

/** "Won 3 in a row", "Lost the last one", "2 draws in a row", or null without a streak. */
export function rivalStreakText(streak: { outcome: "won" | "lost" | "draw"; length: number } | null): string | null {
  if (!streak || streak.length < 1) return null;
  if (streak.outcome === "draw") return streak.length === 1 ? "Drew the last one" : `${streak.length} draws in a row`;
  const verb = streak.outcome === "won" ? "Won" : "Lost";
  return streak.length === 1 ? `${verb} the last one` : `${verb} ${streak.length} in a row`;
}

/** Your share of this round's points, 0 to 1; 0.5 when nobody has scored. */
export function rivalShare(current: { you: number; them: number }): number {
  const total = current.you + current.them;
  return total <= 0 ? 0.5 : Math.min(1, Math.max(0, current.you / total));
}
