# @onstreak/sdk

Tiny, dependency-free TypeScript client for an [onstreak](https://github.com/imnottaken/onstreak) server. Works in Node 20+, Deno, Bun and edge runtimes.

```ts
import { createClient } from "@onstreak/sdk";

const onstreak = createClient({ baseUrl: "https://onstreak.example.com", apiKey: process.env.ONSTREAK_API_KEY! });
const result = await onstreak.track({ userId: "asha", event: "lesson_completed" });
```

Methods: `track`, `trackBatch`, `getUser`, `updateUser`, `events`, `leaderboard`, `league`, `health`.

MIT licensed.
