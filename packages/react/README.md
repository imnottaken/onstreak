# @onstreak/react

Accessible React components for [onstreak](https://github.com/imnottaken/onstreak): `StreakFlame`, `LevelBar`, `BadgeGrid`, `Leaderboard`, `LeagueTable`, `AchievementToast`, `FriendsList`, `RivalCard`, `RivalList` and `QuestList`.

They render data from `@onstreak/sdk`. Fetch it on your server (the API key must never reach a browser) and pass it as props.

```tsx
import { LevelBar, Leaderboard } from "@onstreak/react";
import "@onstreak/react/styles.css"; // optional

<LevelBar level={user.level} />
<Leaderboard board={board} currentUserId={user.userId} />
<RivalList status={await sdk.rivals("weekly_duel", userId)} />
<FriendsList friends={friends} renderAction={(f) => <ChallengeButton friendId={f.userId} />} />
```

`FriendsList` takes a `renderAction` so you can add your own buttons (challenge, remove). They should call your server, which calls the SDK.

Every component takes a `className`. The optional stylesheet uses `os-*` classes and `--os-*` CSS variables, follows the system dark mode, and respects reduced motion.

MIT licensed.
