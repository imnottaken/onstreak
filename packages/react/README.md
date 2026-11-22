# @onstreak/react

Accessible React components for [onstreak](https://github.com/imnottaken/onstreak): `StreakFlame`, `LevelBar`, `BadgeGrid`, `Leaderboard`, `LeagueTable`, `AchievementToast`, `FriendsList`, `RivalCard`, `RivalList`, `QuestList`, `RewardStore` and `RewardCalendar`.

They render data from `@onstreak/sdk`. Fetch it on your server (the API key must never reach a browser) and pass it as props, or fetch in the browser with a user token from `createToken`, which can only read that user's own data.

```tsx
import { LevelBar, Leaderboard } from "@onstreak/react";
import "@onstreak/react/styles.css"; // optional

<LevelBar level={user.level} />
<Leaderboard board={board} currentUserId={user.userId} />
<BadgeGrid achievements={await sdk.achievements(userId)} /> // tiers, progress, secrets
<RivalList status={await sdk.rivals("weekly_duel", userId)} />
<RewardStore store={await sdk.store(userId)} renderAction={(item) => <BuyButton item={item} />} />
<FriendsList friends={friends} renderAction={(f) => <ChallengeButton friendId={f.userId} />} />
```

`FriendsList`, `RewardStore` and `RewardCalendar` take a `renderAction` so you can add your own buttons (challenge, remove, buy, claim). They should call your server, which calls the SDK. `RewardStore` passes each item, so you can disable the button when `item.canBuy` is false; it already explains why ("Need 3 more coins", "Limit reached").

Every component takes a `className`. The optional stylesheet uses `os-*` classes and `--os-*` CSS variables, follows the system dark mode, and respects reduced motion.

MIT licensed.
