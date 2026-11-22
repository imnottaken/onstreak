import { useEffect, useState, type ReactNode } from "react";
import type { FriendList as FriendListData, LeaderboardEntry, LeaderboardResult, LeagueStatus, QuestList as QuestListData, RivalryStatus, UserProfile } from "@onstreak/sdk";
import { countdownTick, cx, displayNameOf, formatTimeLeft, initials, levelProgress, questProgressText, recordText, rewardText, rivalScoreText, rivalShare, rivalStreakText, streakLabel } from "./helpers.js";

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

/* ---------- FriendsList ---------- */

type Friend = FriendListData["friends"][number];

export interface FriendsListProps {
  /** The result of sdk.friends(userId). */
  friends: FriendListData;
  title?: string;
  /** Extra controls per friend, e.g. a "Challenge" or "Remove" button that calls your server. */
  renderAction?: (friend: Friend) => ReactNode;
  emptyText?: string;
  className?: string;
}

/** A user's friends with avatars and how long they have been friends. */
export function FriendsList({ friends, title, renderAction, emptyText = "No friends yet.", className }: FriendsListProps) {
  return (
    <section className={cx("os-friends", className)} aria-label={title ?? "Friends"}>
      {title && <h3 className="os-friends__title">{title}</h3>}
      {friends.friends.length === 0 ? (
        <p className="os-friends__empty">{emptyText}</p>
      ) : (
        <ul className="os-friends__list">
          {friends.friends.map((f) => (
            <li key={f.userId} className="os-friend">
              <Avatar entry={f} />
              <span className="os-friend__name">{displayNameOf(f)}</span>
              <time className="os-friend__since" dateTime={f.since}>
                since {new Date(f.since).toLocaleDateString()}
              </time>
              {renderAction && <span className="os-friend__action">{renderAction(f)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- Rivals ---------- */

type Rival = RivalryStatus["rivals"][number];

const LAST_TEXT = { won: "Won", lost: "Lost", draw: "Drew" } as const;

export interface RivalCardProps {
  rival: Rival;
  /** The round the live scores belong to (status.round). */
  round: RivalryStatus["round"];
  unitLabel?: string;
  formatScore?: (n: number) => string;
  /** Clock for the first render (pass the server's time to avoid hydration differences). */
  now?: number;
  className?: string;
}

/** One head-to-head: this round's score bar, time left, record, streak and last result. */
export function RivalCard({ rival, round, unitLabel = "XP", formatScore = defaultFormat, now, className }: RivalCardProps) {
  const left = useCountdown(round.endsAt, now);
  const name = displayNameOf({ userId: rival.rivalId, displayName: rival.displayName });
  const pct = Math.round(rivalShare(rival.current) * 100);
  const streak = rivalStreakText(rival.streak);
  const r = rival.record;
  return (
    <article className={cx("os-rival", `os-rival--${rival.current.leading}`, className)} aria-label={`You vs ${name}`}>
      <header className="os-rival__header">
        <Avatar entry={{ userId: rival.rivalId, displayName: rival.displayName, avatarUrl: rival.avatarUrl }} />
        <h3 className="os-rival__name">You vs {name}</h3>
        <span className="os-rival__ends">{left > 0 ? `Ends in ${formatTimeLeft(left)}` : "Round ended"}</span>
      </header>
      <p className="os-rival__status">{rivalScoreText(rival.current, name)}</p>
      <div className="os-rival__scores" aria-hidden="true">
        <span className="os-rival__you">
          {formatScore(rival.current.you)} <span className="os-row__unit">{unitLabel}</span>
        </span>
        <span className="os-rival__them">
          {formatScore(rival.current.them)} <span className="os-row__unit">{unitLabel}</span>
        </span>
      </div>
      <div className="os-rival__bar" aria-hidden="true">
        <div className="os-rival__bar-you" style={{ width: `${pct}%` }} />
      </div>
      <dl className="os-rival__stats">
        <div>
          <dt>Record</dt>
          <dd aria-label={`${r.wins} wins, ${r.losses} losses, ${r.draws} draws`}>{recordText(r)}</dd>
        </div>
        {streak && (
          <div>
            <dt>Streak</dt>
            <dd className={`os-rival__streak--${rival.streak!.outcome}`}>{streak}</dd>
          </div>
        )}
        {rival.last && (
          <div>
            <dt>Last round</dt>
            <dd className={`os-rival__last--${rival.last.outcome}`}>
              {LAST_TEXT[rival.last.outcome]} {formatScore(rival.last.you)} to {formatScore(rival.last.them)}
            </dd>
          </div>
        )}
      </dl>
    </article>
  );
}

export interface RivalListProps extends Omit<RivalCardProps, "rival" | "round"> {
  /** The result of sdk.rivals(rivalryId, userId). */
  status: RivalryStatus;
  title?: string;
  emptyText?: string;
}

/** Every rival in a rivalry, one card each. */
export function RivalList({ status, title, emptyText = "No rivals yet. Challenge a friend.", className, ...card }: RivalListProps) {
  return (
    <section className={cx("os-rivals", className)} aria-label={title ?? "Rivals"}>
      {title && <h3 className="os-rivals__title">{title}</h3>}
      {status.rivals.length === 0 ? (
        <p className="os-rivals__empty">{emptyText}</p>
      ) : (
        status.rivals.map((rival) => <RivalCard key={rival.rivalId} rival={rival} round={status.round} {...card} />)
      )}
    </section>
  );
}

/* ---------- Quests ---------- */

type Quest = QuestListData["quests"][number];

function QuestItem({ quest, now, unitLabel, formatScore }: { quest: Quest; now?: number; unitLabel?: (quest: Quest) => string | undefined; formatScore: (n: number) => string }) {
  const left = useCountdown(quest.endsAt, now);
  const pct = Math.round(Math.min(1, quest.progress / quest.target) * 100);
  const unit = unitLabel?.(quest) ?? ("points" in quest.goal ? quest.goal.points : undefined);
  const reward = rewardText(quest.rewards);
  return (
    <li className={cx("os-quest", quest.completed && "os-quest--done")}>
      <span className="os-quest__check" aria-hidden="true">
        {quest.completed ? "✓" : ""}
      </span>
      <div className="os-quest__body">
        <div className="os-quest__header">
          <span className="os-quest__name">{quest.name}</span>
          {reward && <span className="os-quest__reward">{reward}</span>}
        </div>
        {quest.description && <p className="os-quest__description">{quest.description}</p>}
        <div
          className="os-quest__track"
          role="progressbar"
          aria-label={quest.name}
          aria-valuemin={0}
          aria-valuemax={quest.target}
          aria-valuenow={quest.progress}
          aria-valuetext={quest.completed ? "Done" : questProgressText(quest, formatScore, unit)}
        >
          <div className="os-quest__fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="os-quest__meta">
          <span className="os-quest__progress">{quest.completed ? "Done" : questProgressText(quest, formatScore, unit)}</span>
          <span className="os-quest__ends">{left > 0 ? `${quest.completed ? "New quest" : "Ends"} in ${formatTimeLeft(left)}` : "Ended"}</span>
        </div>
      </div>
    </li>
  );
}

export interface QuestListProps {
  /** The result of sdk.quests(userId). */
  quests: QuestListData;
  title?: string;
  /** Only show quests of one period. */
  period?: "daily" | "weekly";
  /** Unit after the numbers, e.g. "min" for a minutes goal. Default: the currency for points goals, none for event goals. */
  unitLabel?: (quest: Quest) => string | undefined;
  formatScore?: (n: number) => string;
  /** Clock for the first render (pass the server's time to avoid hydration differences). */
  now?: number;
  emptyText?: string;
  className?: string;
}

/** Quests with progress bars, rewards and when each one resets. Finished quests move to the end. */
export function QuestList({ quests, title, period, unitLabel, formatScore = defaultFormat, now, emptyText = "No quests right now.", className }: QuestListProps) {
  const shown = quests.quests.filter((q) => !period || q.period === period);
  const ordered = [...shown.filter((q) => !q.completed), ...shown.filter((q) => q.completed)];
  const done = shown.length - ordered.filter((q) => !q.completed).length;
  return (
    <section className={cx("os-quests", className)} aria-label={title ?? "Quests"}>
      {title && (
        <header className="os-quests__header">
          <h3 className="os-quests__title">{title}</h3>
          {shown.length > 0 && <span className="os-quests__count">{done} / {shown.length} done</span>}
        </header>
      )}
      {ordered.length === 0 ? (
        <p className="os-quests__empty">{emptyText}</p>
      ) : (
        <ul className="os-quests__list">
          {ordered.map((q) => (
            <QuestItem key={q.id} quest={q} now={now} unitLabel={unitLabel} formatScore={formatScore} />
          ))}
        </ul>
      )}
    </section>
  );
}
