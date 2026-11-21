import { useEffect, useState, type ReactNode } from "react";
import type { LeaderboardEntry, LeaderboardResult, LeagueStatus, UserProfile } from "@onstreak/sdk";
import { countdownTick, cx, displayNameOf, formatTimeLeft, initials, levelProgress, streakLabel } from "./helpers.js";

type Streak = UserProfile["streaks"][string];
type Level = NonNullable<UserProfile["level"]>;

const defaultFormat = (n: number) => n.toLocaleString();

/* ---------- StreakFlame ---------- */

export interface StreakFlameProps {
  streak: Streak;
  /** Whether the streak counts days or weeks. Default "day". */
  unit?: "day" | "week";
  className?: string;
}

/** The streak count with a flame, dimmed until today's activity is done. */
export function StreakFlame({ streak, unit = "day", className }: StreakFlameProps) {
  const label = streakLabel(streak, unit);
  return (
    <div className={cx("os-streak", `os-streak--${streak.current === 0 ? "none" : streak.status}`, className)} role="img" aria-label={label} title={label}>
      <span className="os-streak__flame" aria-hidden="true">
        🔥
      </span>
      <span className="os-streak__count" aria-hidden="true">
        {streak.current}
      </span>
      {streak.freezes > 0 && (
        <span className="os-streak__freezes" aria-hidden="true">
          ❄️{streak.freezes}
        </span>
      )}
    </div>
  );
}

/* ---------- LevelBar ---------- */

export interface LevelBarProps {
  level: Level;
  /** Name of the points, shown after the numbers. Default "XP". */
  unitLabel?: string;
  className?: string;
}

/** Current level and an accessible progress bar to the next one. */
export function LevelBar({ level, unitLabel = "XP", className }: LevelBarProps) {
  const pct = Math.round(levelProgress(level) * 100);
  const max = level.nextAt === null;
  const progressText = max ? "Max level" : `${defaultFormat(level.points - level.startsAt)} / ${defaultFormat(level.nextAt! - level.startsAt)} ${unitLabel}`;
  return (
    <div className={cx("os-level", max && "os-level--max", className)}>
      <div className="os-level__header">
        <span className="os-level__number">Level {level.current}</span>
        <span className="os-level__progress">{progressText}</span>
      </div>
      <div
        className="os-level__track"
        role="progressbar"
        aria-label={`Level ${level.current} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={max ? "Max level" : `${pct}% to level ${level.current + 1}`}
      >
        <div className="os-level__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------- BadgeGrid ---------- */

export interface BadgeInfo {
  id: string;
  name: string;
  description?: string;
}

export interface BadgeGridProps {
  /** Achievements the user has, e.g. profile.achievements. */
  unlocked: UserProfile["achievements"];
  /** Every achievement your app offers. Those not unlocked are shown locked. */
  all?: BadgeInfo[];
  /** Custom icon per achievement. Default 🏅 (and 🔒 when locked). */
  renderIcon?: (badge: BadgeInfo, unlocked: boolean) => ReactNode;
  className?: string;
}

export function BadgeGrid({ unlocked, all = [], renderIcon, className }: BadgeGridProps) {
  const have = new Set(unlocked.map((a) => a.id));
  const locked = all.filter((a) => !have.has(a.id));
  if (unlocked.length === 0 && locked.length === 0) {
    return <p className={cx("os-badges__empty", className)}>No achievements yet.</p>;
  }
  return (
    <ul className={cx("os-badges", className)} aria-label="Achievements">
      {unlocked.map((a) => (
        <li key={a.id} className="os-badge os-badge--unlocked">
          <span className="os-badge__icon" aria-hidden="true">
            {renderIcon ? renderIcon(a, true) : "🏅"}
          </span>
          <span className="os-badge__name">{a.name}</span>
          {a.description && <span className="os-badge__description">{a.description}</span>}
          <time className="os-badge__date" dateTime={a.unlockedAt}>
            {new Date(a.unlockedAt).toLocaleDateString()}
          </time>
        </li>
      ))}
      {locked.map((a) => (
        <li key={a.id} className="os-badge os-badge--locked" aria-label={`${a.name} (locked)`}>
          <span className="os-badge__icon" aria-hidden="true">
            {renderIcon ? renderIcon(a, false) : "🔒"}
          </span>
          <span className="os-badge__name">{a.name}</span>
          {a.description && <span className="os-badge__description">{a.description}</span>}
        </li>
      ))}
    </ul>
  );
}

/* ---------- Leaderboard ---------- */

function Avatar({ entry }: { entry: Pick<LeaderboardEntry, "userId" | "displayName" | "avatarUrl"> }) {
  if (entry.avatarUrl) return <img className="os-avatar" src={entry.avatarUrl} alt="" width={32} height={32} loading="lazy" />;
  return (
    <span className="os-avatar os-avatar--initials" aria-hidden="true">
      {initials(displayNameOf(entry))}
    </span>
  );
}

function Row({
  entry,
  isYou,
  format,
  unit,
  extra,
  modifier,
}: {
  entry: LeaderboardEntry;
  isYou: boolean;
  format: (n: number) => string;
  unit: string;
  extra?: ReactNode;
  modifier?: string;
}) {
  return (
    <li value={entry.rank} className={cx("os-row", modifier && `os-row--${modifier}`, isYou && "os-row--you")} aria-current={isYou ? "true" : undefined}>
      <span className="os-row__rank">{entry.rank}</span>
      <Avatar entry={entry} />
      <span className="os-row__name">
        {displayNameOf(entry)}
        {isYou && <span className="os-row__you"> (you)</span>}
      </span>
      <span className="os-row__score">
        {format(entry.score)} <span className="os-row__unit">{unit}</span>
      </span>
      {extra}
    </li>
  );
}

export interface LeaderboardProps {
  board: LeaderboardResult;
  /** Highlight this user. */
  currentUserId?: string;
  title?: string;
  /** Shown after scores. Default: the board's currency. */
  unitLabel?: string;
  formatScore?: (n: number) => string;
  className?: string;
}

/** Ranked list. If the current user is outside the top entries, their own row is added below. */
export function Leaderboard({ board, currentUserId, title, unitLabel, formatScore = defaultFormat, className }: LeaderboardProps) {
  const unit = unitLabel ?? board.currency;
  const meInTop = board.user && board.entries.some((e) => e.userId === board.user!.userId);
  return (
    <section className={cx("os-board", className)} aria-label={title ?? "Leaderboard"}>
      {title && <h3 className="os-board__title">{title}</h3>}
      {board.entries.length === 0 ? (
        <p className="os-board__empty">No scores yet.</p>
      ) : (
        <ol className="os-board__list">
          {board.entries.map((e) => (
            <Row key={e.userId} entry={e} isYou={e.userId === currentUserId} format={formatScore} unit={unit} />
          ))}
        </ol>
      )}
      {board.user && !meInTop && (
        <ol className="os-board__list os-board__list--you" aria-label="Your rank">
          <Row entry={board.user} isYou={board.user.userId === currentUserId} format={formatScore} unit={unit} />
        </ol>
      )}
    </section>
  );
}

/* ---------- League ---------- */

/** Milliseconds until `endsAt`, refreshed every 30 s (every second near the end). */
export function useCountdown(endsAt: string, now?: number): number {
  const end = Date.parse(endsAt);
  const [left, setLeft] = useState(() => end - (now ?? Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const ms = end - Date.now();
      setLeft(ms);
      if (ms > 0) timer = setTimeout(tick, countdownTick(ms));
    };
    timer = setTimeout(tick, countdownTick(end - Date.now()));
    return () => clearTimeout(timer);
  }, [end]);
  return left;
}

const OUTCOME_TEXT = {
  promoted: (p: NonNullable<LeagueStatus["previous"]>) => `Promoted to ${p.nextTier}`,
  demoted: (p: NonNullable<LeagueStatus["previous"]>) => `Moved down to ${p.nextTier}`,
  stayed: (p: NonNullable<LeagueStatus["previous"]>) => `Stayed in ${p.tier}`,
};

export interface LeagueTableProps {
  status: LeagueStatus;
  /** Highlight this user. Default: status.you. */
  currentUserId?: string;
  /** Display name for a tier id, e.g. capitalize it. */
  tierLabel?: (tier: string) => string;
  unitLabel?: string;
  formatScore?: (n: number) => string;
  /** Clock for the first render (pass the server's time to avoid hydration differences). */
  now?: number;
  className?: string;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The user's league group with promotion and demotion zones, time left, and last round's result. */
export function LeagueTable({ status, currentUserId, tierLabel = capitalize, unitLabel = "XP", formatScore = defaultFormat, now, className }: LeagueTableProps) {
  const left = useCountdown(status.round.endsAt, now);
  const me = currentUserId ?? status.you?.userId;
  const tier = tierLabel(status.tier);
  return (
    <section className={cx("os-league", className)} aria-label={`${tier} league`}>
      <header className="os-league__header">
        <h3 className="os-league__title">{tier} league</h3>
        <span className="os-league__ends">{left > 0 ? `Ends in ${formatTimeLeft(left)}` : "Round ended"}</span>
      </header>
      {status.previous && (
        <p className={cx("os-league__previous", `os-league__previous--${status.previous.outcome}`)}>
          Last round: {OUTCOME_TEXT[status.previous.outcome](status.previous)}, finished #{status.previous.rank}
        </p>
      )}
      {!status.group ? (
        <p className="os-league__empty">Earn points this round to join a group.</p>
      ) : (
        <ol className="os-league__list">
          {status.group.entries.map((e) => (
            <Row
              key={e.userId}
              entry={e}
              isYou={e.userId === me}
              format={formatScore}
              unit={unitLabel}
              modifier={e.zone}
              extra={
                e.zone !== "safe" && (
                  <span className={cx("os-row__zone", `os-row__zone--${e.zone}`)} title={e.zone === "promotion" ? "Moving up" : "Moving down"}>
                    <span aria-hidden="true">{e.zone === "promotion" ? "↑" : "↓"}</span>
                    <span className="os-sr-only">{e.zone === "promotion" ? "promotion zone" : "demotion zone"}</span>
                  </span>
                )
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/* ---------- AchievementToast ---------- */

export interface AchievementToastProps {
  /** Usually trackResult.achievements. Renders nothing when empty. */
  achievements: BadgeInfo[];
  /** Called when the user closes it, or after `durationMs`. */
  onDismiss?: () => void;
  /** Auto-dismiss after this long. Default 5000; 0 keeps it open. */
  durationMs?: number;
  className?: string;
}

/** A polite, screen-reader-announced notice for newly unlocked achievements. */
export function AchievementToast({ achievements, onDismiss, durationMs = 5000, className }: AchievementToastProps) {
  useEffect(() => {
    if (achievements.length === 0 || !onDismiss || durationMs <= 0) return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [achievements, onDismiss, durationMs]);
  if (achievements.length === 0) return null;
  return (
    <div className={cx("os-toast", className)} role="status" aria-live="polite">
      <span className="os-toast__icon" aria-hidden="true">
        🏆
      </span>
      <div className="os-toast__body">
        <strong className="os-toast__title">
          {achievements.length === 1 ? "Achievement unlocked" : `${achievements.length} achievements unlocked`}
        </strong>
        <ul className="os-toast__list">
          {achievements.map((a) => (
            <li key={a.id}>
              {a.name}
              {a.description && <span className="os-toast__description"> {a.description}</span>}
            </li>
          ))}
        </ul>
      </div>
      {onDismiss && (
        <button type="button" className="os-toast__close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
