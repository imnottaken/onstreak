# @onstreak/react

Accessible React components for [onstreak](https://github.com/imnottaken/onstreak): `StreakFlame`, `LevelBar`, `BadgeGrid`, `Leaderboard`, `LeagueTable` and `AchievementToast`.

They render data from `@onstreak/sdk`. Fetch it on your server (the API key must never reach a browser) and pass it as props.

```tsx
import { LevelBar, Leaderboard } from "@onstreak/react";
import "@onstreak/react/styles.css"; // optional

<LevelBar level={user.level} />
<Leaderboard board={board} currentUserId={user.userId} />
```

Every component takes a `className`. The optional stylesheet uses `os-*` classes and `--os-*` CSS variables, follows the system dark mode, and respects reduced motion.

MIT licensed.
