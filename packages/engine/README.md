# @onstreak/engine

The onstreak gamification engine: points, levels, time-zone-aware streaks, achievements, leaderboards and leagues, on your own Postgres. Includes the HTTP server and the `onstreak` command.

```bash
npm install @onstreak/engine
ONSTREAK_API_KEY=... ONSTREAK_CONFIG=onstreak.config.json DATABASE_URL=postgres://... npx onstreak
```

Or use it as a library:

```ts
import { Engine, PostgresStore, fromPgPool } from "@onstreak/engine";
```

Full documentation: https://github.com/imnottaken/onstreak#readme

MIT licensed.
