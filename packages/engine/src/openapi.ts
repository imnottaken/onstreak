/**
 * OpenAPI 3.1 description of the HTTP API, served at GET /openapi.json.
 * The contract tests check every real response against these schemas, so
 * this file cannot drift from the server without a test failing.
 */

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const map = (value: Record<string, unknown>) => ({ type: "object", additionalProperties: value });
const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } });
const ok = (description: string, schema: Record<string, unknown>) => ({ description, content: json(schema) });
const errorResponse = (description: string) => ({ description, content: json(ref("Error")) });

const userIdParam = { name: "userId", in: "path", required: true, schema: { type: "string", maxLength: 128 } };
const localeParam = { name: "locale", in: "query", schema: { type: "string" }, description: 'Show translated names, e.g. "es" or "pt-BR" (falls back to the language, then the default).' };
const limitParam = (max = 100) => ({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: max } });

const schemas = {
  Error: {
    type: "object",
    required: ["error"],
    additionalProperties: false,
    properties: {
      error: { type: "string", description: "What went wrong, in plain words." },
      code: { type: "string", description: 'A stable reason to branch on, when there is one: "insufficient_funds", "limit_reached", "not_owned", "streak_broken", "already_referred", "already_refunded", "not_broken", "repair_expired", "team_full", "already_in_team", "not_max_level", "already_reversed".' },
      requestId: { type: "string", description: "Matches the x-request-id header and the server logs." },
    },
  },
  TrackInput: {
    type: "object",
    required: ["userId", "event"],
    properties: {
      userId: { type: "string", maxLength: 128, pattern: "^\\S+$" },
      event: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$" },
      value: { type: "number", exclusiveMinimum: 0, default: 1, description: "How much happened (minutes, steps, lessons)." },
      timestamp: { anyOf: [{ type: "string", format: "date-time" }, { type: "integer" }], description: "When it happened. Default now." },
      timezone: { type: "string", description: "IANA zone for streak days. Remembered for the user." },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200, description: "Retries with the same key return the first result." },
      properties: {
        type: "object",
        maxProperties: 20,
        additionalProperties: { anyOf: [{ type: "string", maxLength: 200 }, { type: "number" }, { type: "boolean" }] },
        description: "Extra facts rules can filter on, e.g. { difficulty: \"hard\" }. At most 2 KB.",
      },
    },
  },
  LeaguePrevious: {
    type: "object",
    required: ["round", "tier", "rank", "outcome", "nextTier", "rewards"],
    additionalProperties: false,
    properties: {
      round: { type: "string" },
      tier: { type: "string" },
      rank: { type: "integer", minimum: 1 },
      outcome: { enum: ["promoted", "demoted", "stayed"] },
      nextTier: { type: "string" },
      rewards: { type: "array", items: ref("QuestReward"), description: "What finishing at this rank paid, once, when the round settled." },
    },
  },
  TrackResult: {
    type: "object",
    required: ["eventId", "userId", "event", "value", "duplicate", "points", "level", "streaks", "achievements", "leagues", "quests", "calendars", "referral", "multipliers"],
    additionalProperties: false,
    properties: {
      eventId: { type: "string", format: "uuid" },
      userId: { type: "string" },
      event: { type: "string" },
      value: { type: "number" },
      duplicate: { type: "boolean", description: "True when an idempotency key matched an earlier event." },
      points: map({
        type: "object",
        required: ["awarded", "total"],
        additionalProperties: false,
        properties: { awarded: { type: "number" }, total: { type: "number" } },
      }),
      level: nullable({
        type: "object",
        required: ["current", "previous", "leveledUp"],
        additionalProperties: false,
        properties: {
          current: { type: "integer" },
          previous: { type: "integer" },
          leveledUp: { type: "boolean" },
          rewards: { type: "array", items: ref("QuestReward"), description: "What reaching new levels paid (already in points)." },
        },
      }),
      streaks: map({
        type: "object",
        required: ["current", "longest", "freezes", "extended", "freezesUsed", "reset"],
        additionalProperties: false,
        properties: {
          current: { type: "integer" },
          longest: { type: "integer" },
          freezes: { type: "integer" },
          extended: { type: "boolean" },
          freezesUsed: { type: "integer" },
          reset: { type: "boolean" },
          progress: { type: "number", description: "This period's total so far, for streaks with a minimum." },
        },
      }),
      achievements: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name"],
          additionalProperties: false,
          properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, tier: { type: "object", required: ["level", "name"], additionalProperties: false, properties: { level: { type: "integer", minimum: 1 }, name: { type: "string" } } }, rewards: { type: "array", items: ref("QuestReward") } },
        },
      },
      leagues: map({
        type: "object",
        required: ["tier", "group", "joined", "previous"],
        additionalProperties: false,
        properties: {
          tier: { type: "string" },
          group: { type: "integer", minimum: 1 },
          joined: { type: "boolean" },
          previous: nullable(ref("LeaguePrevious")),
        },
      }),
      quests: map({
        type: "object",
        description: "Quests this event moved forward. Rewards of a quest it completed are already in points.",
        required: ["progress", "target", "completed", "rewards"],
        additionalProperties: false,
        properties: {
          progress: { type: "number" },
          target: { type: "number" },
          completed: { type: "boolean", description: "True only on the event that completed the quest." },
          rewards: { type: "array", items: ref("QuestReward") },
          goals: {
            type: "array",
            description: "A mission's goals; progress and target then count goals done.",
            items: { type: "object", required: ["progress", "target"], additionalProperties: false, properties: { progress: { type: "number" }, target: { type: "number" } } },
          },
        },
      }),
      calendars: map({
        type: "object",
        description: "Reward calendar days this event claimed. Their rewards are already in points.",
        required: ["day", "rewards"],
        additionalProperties: false,
        properties: { day: { type: "integer", minimum: 1 }, rewards: { type: "array", items: ref("QuestReward") } },
      }),
      referral: nullable({
        type: "object",
        description: "Set when this event qualified the user's referral. Their rewards are already in points; the referrer is paid separately.",
        required: ["referrerId", "rewards"],
        additionalProperties: false,
        properties: { referrerId: { type: "string" }, rewards: { type: "array", items: ref("QuestReward") } },
      }),
      multipliers: map({
        type: "object",
        description: "Multipliers applied to points from point rules. A null currency means every currency.",
        required: ["factor", "currency"],
        additionalProperties: false,
        properties: { factor: { type: "number" }, currency: nullable({ type: "string" }) },
      }),
    },
  },
  QuestReward: {
    type: "object",
    required: ["currency", "amount"],
    additionalProperties: false,
    properties: { currency: { type: "string" }, amount: { type: "number" } },
  },
  QuestList: {
    type: "object",
    required: ["userId", "quests"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      quests: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "period", "progress", "target", "completed", "completedAt", "rewards", "startsAt", "endsAt", "until"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            period: { enum: ["daily", "weekly", "once"] },
            after: { type: "string", description: "The one-off quest this one unlocked after." },
            goal: {
              oneOf: [
                { type: "object", required: ["event", "target"], additionalProperties: false, properties: { event: { type: "string" }, target: { type: "number" }, where: { type: "object", description: "Event properties that must match." } } },
                { type: "object", required: ["points", "target"], additionalProperties: false, properties: { points: { type: "string" }, target: { type: "number" } } },
              ],
            },
            goals: {
              type: "array",
              description: "A mission's goals with their progress; then progress and target count goals done.",
              items: {
                oneOf: [
                  { type: "object", required: ["event", "target", "progress"], additionalProperties: false, properties: { event: { type: "string" }, target: { type: "number" }, where: { type: "object", description: "Event properties that must match." }, progress: { type: "number" } } },
                  { type: "object", required: ["points", "target", "progress"], additionalProperties: false, properties: { points: { type: "string" }, target: { type: "number" }, progress: { type: "number" } } },
                ],
              },
            },
            progress: { type: "number" },
            target: { type: "number" },
            completed: { type: "boolean" },
            completedAt: nullable({ type: "string", format: "date-time" }),
            rewards: { type: "array", items: ref("QuestReward") },
            startsAt: nullable({ type: "string", format: "date-time" }),
            endsAt: nullable({ type: "string", format: "date-time", description: "When progress resets; for one-off quests, their end date or null." }),
            until: nullable({ type: "string", format: "date-time", description: "When a limited-time quest stops running." }),
          },
        },
      },
    },
  },
  Price: {
    type: "object",
    required: ["currency", "amount"],
    additionalProperties: false,
    properties: { currency: { type: "string" }, amount: { type: "number", minimum: 0 } },
  },
  RewardStore: {
    type: "object",
    required: ["userId", "wallet", "items"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      wallet: map({ type: "number" }),
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "price", "limit", "owned", "canBuy"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            price: ref("Price"),
            limit: nullable({ type: "integer", minimum: 1 }),
            metadata: { type: "object" },
            owned: { type: "integer", minimum: 0 },
            canBuy: { type: "boolean", description: "The user can afford one more and is under the limit." },
          },
        },
      },
    },
  },
  PurchaseInput: {
    type: "object",
    required: ["item"],
    additionalProperties: false,
    properties: {
      item: { type: "string" },
      quantity: { type: "integer", minimum: 1, maximum: 1000, default: 1 },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200, description: "Retries with the same key return the first purchase." },
    },
  },
  Purchase: {
    type: "object",
    required: ["id", "item", "name", "quantity", "cost", "purchasedAt", "refunded"],
    additionalProperties: false,
    properties: {
      id: { type: "string", format: "uuid" },
      item: { type: "string" },
      name: nullable({ type: "string" }),
      quantity: { type: "integer", minimum: 1 },
      cost: ref("Price"),
      purchasedAt: { type: "string", format: "date-time" },
      refunded: { type: "integer", minimum: 0, description: "How many of quantity were refunded." },
    },
  },
  StreakRepairResult: {
    type: "object",
    required: ["userId", "streak", "current", "status", "cost", "wallet"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      streak: { type: "string" },
      current: { type: "integer" },
      status: { enum: ["none", "done", "pending", "broken"] },
      cost: nullable(ref("Price")),
      wallet: map({ type: "number" }),
    },
  },
  RefundResult: {
    type: "object",
    required: ["userId", "purchase", "refund", "wallet", "owned"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      purchase: ref("Purchase"),
      refund: {
        type: "object",
        required: ["quantity", "amount", "currency"],
        additionalProperties: false,
        properties: { quantity: { type: "integer", minimum: 1 }, amount: { type: "number" }, currency: { type: "string" } },
      },
      wallet: map({ type: "number" }),
      owned: { type: "integer", minimum: 0 },
    },
  },
  PurchaseResult: {
    type: "object",
    required: ["userId", "purchase", "duplicate", "wallet", "owned"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      purchase: ref("Purchase"),
      duplicate: { type: "boolean" },
      wallet: map({ type: "number" }),
      owned: { type: "integer", minimum: 0 },
    },
  },
  CalendarList: {
    type: "object",
    required: ["userId", "calendars"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      calendars: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "event", "day", "claimedToday", "days", "nextClaimAt"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            event: { type: "string", description: "Tracking this event claims the day." },
            day: { type: "integer", minimum: 1, description: "The day claimed today, or the day the next claim pays." },
            claimedToday: { type: "boolean" },
            days: {
              type: "array",
              items: {
                type: "object",
                required: ["day", "rewards", "status"],
                additionalProperties: false,
                properties: {
                  day: { type: "integer", minimum: 1 },
                  rewards: { type: "array", items: ref("QuestReward") },
                  status: { enum: ["claimed", "today", "upcoming"] },
                },
              },
            },
            nextClaimAt: { type: "string", format: "date-time", description: "When today ends." },
          },
        },
      },
    },
  },
  ReferralResult: {
    type: "object",
    required: ["userId", "referrerId", "created", "qualified", "rewards"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      referrerId: { type: "string" },
      created: { type: "boolean", description: "False if this referral was already recorded." },
      qualified: { type: "boolean", description: "Whether both sides are paid." },
      rewards: { type: "array", items: ref("QuestReward"), description: "What the new user was paid by this call." },
    },
  },
  ReferralList: {
    type: "object",
    required: ["userId", "referredBy", "referred", "rewarded", "max"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      referredBy: nullable({
        type: "object",
        required: ["userId", "qualified"],
        additionalProperties: false,
        properties: { userId: { type: "string" }, qualified: { type: "boolean" } },
      }),
      referred: {
        type: "array",
        items: {
          type: "object",
          required: ["userId", "displayName", "avatarUrl", "since", "qualified", "rewarded"],
          additionalProperties: false,
          properties: {
            userId: { type: "string" },
            displayName: nullable({ type: "string" }),
            avatarUrl: nullable({ type: "string" }),
            since: { type: "string", format: "date-time" },
            qualified: { type: "boolean" },
            rewarded: { type: "boolean", description: "Whether the referrer was paid for this one (false past the limit or before qualifying)." },
          },
        },
      },
      rewarded: { type: "integer", minimum: 0 },
      max: nullable({ type: "integer", minimum: 1 }),
    },
  },
  CommunityGoalList: {
    type: "object",
    required: ["goals"],
    additionalProperties: false,
    properties: {
      goals: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "goal", "progress", "target", "completed", "status", "startsAt", "endsAt", "rewards", "minContribution", "you"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            goal: {
              oneOf: [
                { type: "object", required: ["event", "target"], additionalProperties: false, properties: { event: { type: "string" }, target: { type: "number" }, where: { type: "object", description: "Event properties that must match." } } },
                { type: "object", required: ["points", "target"], additionalProperties: false, properties: { points: { type: "string" }, target: { type: "number" } } },
              ],
            },
            progress: { type: "number", description: "Everyone's total so far." },
            target: { type: "number" },
            completed: { type: "boolean" },
            status: { enum: ["upcoming", "active", "ended"] },
            startsAt: { type: "string", format: "date-time" },
            endsAt: { type: "string", format: "date-time" },
            rewards: { type: "array", items: ref("QuestReward") },
            minContribution: { type: "number", minimum: 0 },
            you: nullable({
              type: "object",
              required: ["contribution", "eligible", "rewarded", "paidNow"],
              additionalProperties: false,
              properties: {
                contribution: { type: "number" },
                eligible: { type: "boolean" },
                rewarded: { type: "boolean" },
                paidNow: { type: "array", items: ref("QuestReward"), description: "Rewards this request paid." },
              },
            }),
          },
        },
      },
    },
  },
  SeasonAward: {
    type: "object",
    required: ["top", "rewards"],
    additionalProperties: false,
    properties: { top: { type: "integer", minimum: 1 }, title: { type: "string" }, rewards: { type: "array", items: ref("QuestReward") } },
  },
  SeasonList: {
    type: "object",
    required: ["seasons"],
    additionalProperties: false,
    properties: {
      seasons: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "currency", "status", "startsAt", "endsAt", "rewards", "you"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            currency: { type: "string" },
            status: { enum: ["upcoming", "active", "ended"] },
            startsAt: { type: "string", format: "date-time" },
            endsAt: { type: "string", format: "date-time" },
            rewards: { type: "array", items: ref("SeasonAward") },
            you: nullable({
              type: "object",
              required: ["score", "rank", "award", "rewarded", "paidNow"],
              additionalProperties: false,
              properties: {
                score: { type: "number" },
                rank: nullable({ type: "integer", minimum: 1 }),
                award: nullable(ref("SeasonAward")),
                rewarded: { type: "boolean" },
                paidNow: { type: "array", items: ref("QuestReward") },
              },
            }),
          },
        },
      },
    },
  },
  SeasonStandings: {
    type: "object",
    required: ["id", "name", "currency", "status", "startsAt", "endsAt", "final", "entries", "user"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      currency: { type: "string" },
      status: { enum: ["upcoming", "active", "ended"] },
      startsAt: { type: "string", format: "date-time" },
      endsAt: { type: "string", format: "date-time" },
      final: { type: "boolean", description: "True once the season has ended: the standings will not change." },
      entries: { type: "array", items: ref("RankedUser") },
      user: nullable(ref("RankedUser")),
    },
  },
  Team: {
    type: "object",
    required: ["id", "name", "createdAt"],
    additionalProperties: false,
    properties: { id: { type: "string" }, name: { type: "string" }, createdAt: { type: "string", format: "date-time" } },
  },
  TeamSaved: {
    type: "object",
    required: ["team", "created"],
    additionalProperties: false,
    properties: { team: ref("Team"), created: { type: "boolean" } },
  },
  TeamStatus: {
    type: "object",
    required: ["id", "name", "createdAt", "maxMembers", "members", "leaderboard"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      maxMembers: { type: "integer", minimum: 1 },
      members: {
        type: "array",
        items: {
          type: "object",
          required: ["userId", "displayName", "avatarUrl", "joinedAt"],
          additionalProperties: false,
          properties: {
            userId: { type: "string" },
            displayName: nullable({ type: "string" }),
            avatarUrl: nullable({ type: "string" }),
            joinedAt: { type: "string", format: "date-time" },
            score: { type: "number", description: "Points earned for the team in the leaderboard's window (only with ?leaderboard=)." },
          },
        },
      },
      leaderboard: nullable({
        type: "object",
        required: ["id", "score", "rank"],
        additionalProperties: false,
        properties: { id: { type: "string" }, score: { type: "number" }, rank: { type: "integer", minimum: 1 } },
      }),
    },
  },
  TeamMembership: {
    type: "object",
    required: ["teamId", "userId"],
    additionalProperties: false,
    properties: { teamId: { type: "string" }, userId: { type: "string" }, created: { type: "boolean" }, removed: { type: "boolean" } },
  },
  UserTeam: {
    type: "object",
    required: ["userId", "team"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      team: nullable({
        type: "object",
        required: ["id", "name", "createdAt", "joinedAt"],
        additionalProperties: false,
        properties: { id: { type: "string" }, name: { type: "string" }, createdAt: { type: "string", format: "date-time" }, joinedAt: { type: "string", format: "date-time" } },
      }),
    },
  },
  TeamGoalList: {
    type: "object",
    required: ["teamId", "goals"],
    additionalProperties: false,
    properties: {
      teamId: { type: "string" },
      goals: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "period", "goal", "progress", "target", "completed", "rewards", "startsAt", "endsAt", "contributions", "you"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            period: { enum: ["daily", "weekly"] },
            goal: {
              oneOf: [
                { type: "object", required: ["event", "target"], additionalProperties: false, properties: { event: { type: "string" }, target: { type: "number" }, where: { type: "object", description: "Event properties that must match." } } },
                { type: "object", required: ["points", "target"], additionalProperties: false, properties: { points: { type: "string" }, target: { type: "number" } } },
              ],
            },
            progress: { type: "number" },
            target: { type: "number" },
            completed: { type: "boolean" },
            rewards: { type: "array", items: ref("QuestReward") },
            startsAt: { type: "string", format: "date-time" },
            endsAt: { type: "string", format: "date-time" },
            contributions: {
              type: "array",
              items: { type: "object", required: ["userId", "amount"], additionalProperties: false, properties: { userId: { type: "string" }, amount: { type: "number" } } },
            },
            you: nullable({
              type: "object",
              required: ["contribution", "rewarded", "paidNow"],
              additionalProperties: false,
              properties: { contribution: { type: "number" }, rewarded: { type: "boolean" }, paidNow: { type: "array", items: ref("QuestReward") } },
            }),
          },
        },
      },
    },
  },
  AchievementList: {
    type: "object",
    required: ["userId", "achievements"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      achievements: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "hidden", "unlocked", "completed", "unlockedAt", "progress"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: nullable({ type: "string", description: "Null for a hidden achievement not unlocked yet." }),
            description: { type: "string" },
            hidden: { type: "boolean" },
            unlocked: { type: "boolean", description: "At least one level unlocked." },
            completed: { type: "boolean", description: "Every level unlocked." },
            unlockedAt: nullable({ type: "string", format: "date-time" }),
            progress: nullable({
              type: "object",
              required: ["current", "target", "percent"],
              additionalProperties: false,
              properties: { current: { type: "number" }, target: { type: "number" }, percent: { type: "integer", minimum: 0, maximum: 100 } },
            }),
            tiers: {
              type: "array",
              items: {
                type: "object",
                required: ["level", "name", "gte", "unlockedAt"],
                additionalProperties: false,
                properties: { level: { type: "integer", minimum: 1 }, name: { type: "string" }, gte: { type: "number" }, unlockedAt: nullable({ type: "string", format: "date-time" }) },
              },
            },
            rewards: { type: "array", items: ref("QuestReward") },
          },
        },
      },
    },
  },
  TeamRank: {
    type: "object",
    required: ["rank", "teamId", "name", "score"],
    additionalProperties: false,
    properties: { rank: { type: "integer", minimum: 1 }, teamId: { type: "string" }, name: { type: "string" }, score: { type: "number" } },
  },
  TeamLeaderboard: {
    type: "object",
    required: ["id", "currency", "period", "from", "to", "entries", "team"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      currency: { type: "string" },
      period: { enum: ["daily", "weekly", "monthly", "all"] },
      from: nullable({ type: "string", format: "date-time" }),
      to: nullable({ type: "string", format: "date-time" }),
      entries: { type: "array", items: ref("TeamRank") },
      team: nullable(ref("TeamRank")),
    },
  },
  Boost: {
    type: "object",
    required: ["id", "factor", "currency", "startsAt", "endsAt", "reason"],
    additionalProperties: false,
    properties: {
      id: { type: "string", format: "uuid" },
      factor: { type: "number", exclusiveMinimum: 0, maximum: 100 },
      currency: nullable({ type: "string", description: "Null: every currency." }),
      startsAt: { type: "string", format: "date-time" },
      endsAt: { type: "string", format: "date-time" },
      reason: { type: "string" },
    },
  },
  BoostInput: {
    type: "object",
    required: ["factor", "minutes"],
    additionalProperties: false,
    properties: {
      factor: { type: "number", exclusiveMinimum: 0, maximum: 100 },
      minutes: { type: "integer", minimum: 1, maximum: 43200 },
      currency: { type: "string", description: "Omit to boost every currency." },
      reason: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$", default: "boost" },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
  BoostResult: {
    type: "object",
    required: ["userId", "boost", "duplicate", "boosts"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      boost: ref("Boost"),
      duplicate: { type: "boolean" },
      boosts: { type: "array", items: ref("Boost") },
    },
  },
  ItemUseInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      quantity: { type: "integer", minimum: 1, maximum: 1000, default: 1 },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200, description: "Retries with the same key return the first result." },
    },
  },
  ItemUseResult: {
    type: "object",
    required: ["userId", "item", "used", "owned", "duplicate", "effects"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      item: { type: "string" },
      used: { type: "integer", minimum: 1 },
      owned: { type: "integer", minimum: 0, description: "How many are left." },
      duplicate: { type: "boolean" },
      effects: {
        type: "object",
        additionalProperties: false,
        properties: {
          streakFreeze: {
            type: "object",
            required: ["streak", "freezes"],
            additionalProperties: false,
            properties: { streak: { type: "string" }, freezes: { type: "integer", description: "Freezes the streak holds now." } },
          },
          boost: {
            type: "object",
            required: ["factor", "currency", "startsAt", "endsAt"],
            additionalProperties: false,
            description: "The boosts this use queued, from the first one's start to the last one's end.",
            properties: {
              factor: { type: "number" },
              currency: nullable({ type: "string" }),
              startsAt: { type: "string", format: "date-time" },
              endsAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
  },
  PurchaseHistory: {
    type: "object",
    required: ["purchases", "nextCursor"],
    additionalProperties: false,
    properties: {
      purchases: { type: "array", items: ref("Purchase") },
      nextCursor: nullable({ type: "string" }),
    },
  },
  Profile: {
    type: "object",
    required: ["displayName", "avatarUrl", "metadata", "timezone"],
    additionalProperties: false,
    properties: {
      displayName: nullable({ type: "string", maxLength: 80 }),
      avatarUrl: nullable({ type: "string", format: "uri" }),
      metadata: { type: "object" },
      timezone: nullable({ type: "string" }),
    },
  },
  ProfilePatch: {
    type: "object",
    additionalProperties: false,
    description: "Omitted fields stay as they are; null clears a field.",
    properties: {
      displayName: nullable({ type: "string", minLength: 1, maxLength: 80 }),
      avatarUrl: nullable({ type: "string", format: "uri", maxLength: 2048 }),
      metadata: nullable({ type: "object", description: "At most 8 KB of JSON." }),
      timezone: nullable({ type: "string" }),
    },
  },
  UserProfile: {
    type: "object",
    required: ["userId", "profile", "points", "wallet", "inventory", "boosts", "level", "metrics", "streaks", "achievements"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      profile: ref("Profile"),
      points: map({ type: "number", description: "Points earned. Spending does not lower these." }),
      wallet: map({ type: "number", description: "Points left to spend: earned minus spent." }),
      inventory: map({ type: "integer", description: "Items owned, by item id." }),
      boosts: { type: "array", items: ref("Boost"), description: "Personal boosts running now or queued, soonest first." },
      level: nullable({
        type: "object",
        required: ["current", "points", "startsAt", "nextAt", "prestige"],
        additionalProperties: false,
        properties: {
          prestige: { type: "integer", minimum: 0, description: "How many times the user has started levels over." },
          current: { type: "integer" },
          points: { type: "number" },
          startsAt: { type: "number", description: "Points where the current level began (0 at level 1)." },
          nextAt: nullable({ type: "number", description: "Points needed for the next level; null at the top level." }),
        },
      }),
      metrics: map({ type: "number" }),
      streaks: map({
        type: "object",
        required: ["current", "longest", "freezes", "lastPeriod", "status"],
        additionalProperties: false,
        properties: {
          current: { type: "integer" },
          longest: { type: "integer" },
          freezes: { type: "integer" },
          lastPeriod: nullable({ type: "string" }),
          status: { enum: ["none", "done", "pending", "broken"] },
          repairableUntil: { type: "string", format: "date-time", description: "Set while a broken streak can still be repaired." },
          progress: { type: "number", description: "This period's total so far, for streaks with a minimum." },
        },
      }),
      achievements: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "unlockedAt"],
          additionalProperties: false,
          properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, tier: { type: "object", required: ["level", "name"], additionalProperties: false, properties: { level: { type: "integer", minimum: 1 }, name: { type: "string" } } }, unlockedAt: { type: "string", format: "date-time" } },
        },
      },
    },
  },
  RankedUser: {
    type: "object",
    required: ["rank", "userId", "score", "displayName", "avatarUrl"],
    additionalProperties: false,
    properties: {
      rank: { type: "integer", minimum: 1 },
      userId: { type: "string" },
      score: { type: "number" },
      displayName: nullable({ type: "string" }),
      avatarUrl: nullable({ type: "string" }),
    },
  },
  StreaksAtRisk: {
    type: "object",
    required: ["streak", "users", "nextCursor"],
    additionalProperties: false,
    properties: {
      streak: { type: "string" },
      users: {
        type: "array",
        items: {
          type: "object",
          required: ["userId", "displayName", "current", "freezes", "endsAt", "lastChance"],
          additionalProperties: false,
          properties: {
            userId: { type: "string" },
            displayName: nullable({ type: "string" }),
            current: { type: "integer" },
            freezes: { type: "integer" },
            endsAt: { type: "string", format: "date-time", description: "When the period ends in the user's time zone." },
            lastChance: { type: "boolean", description: "Missing this period breaks the streak (no freeze covers it)." },
          },
        },
      },
      nextCursor: nullable({ type: "string" }),
    },
  },
  ReversalResult: {
    type: "object",
    required: ["userId", "eventId", "points", "totals"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      eventId: { type: "string", format: "uuid" },
      points: map({ type: "number", description: "Points taken back." }),
      totals: map({ type: "number" }),
    },
  },
  Revoked: {
    type: "object",
    required: ["userId", "achievementId", "revoked"],
    additionalProperties: false,
    properties: { userId: { type: "string" }, achievementId: { type: "string" }, revoked: { type: "boolean" } },
  },
  WebhookDeliveryList: {
    type: "object",
    required: ["deliveries", "nextCursor"],
    additionalProperties: false,
    properties: {
      deliveries: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "webhookId", "type", "userId", "status", "attempts", "nextAttemptAt", "lastError", "createdAt", "deliveredAt", "payload"],
          additionalProperties: false,
          properties: {
            id: { type: "string", format: "uuid" },
            webhookId: { type: "string" },
            type: { type: "string" },
            userId: { type: "string" },
            status: { enum: ["pending", "delivered", "failed"] },
            attempts: { type: "integer", minimum: 0 },
            nextAttemptAt: nullable({ type: "string", format: "date-time" }),
            lastError: nullable({ type: "string" }),
            createdAt: { type: "string", format: "date-time" },
            deliveredAt: nullable({ type: "string", format: "date-time" }),
            payload: { type: "object" },
          },
        },
      },
      nextCursor: nullable({ type: "string" }),
    },
  },
  UserExport: {
    type: "object",
    required: ["exportedAt", "user", "events", "purchases", "friends", "team", "referrals"],
    additionalProperties: false,
    properties: {
      exportedAt: { type: "string", format: "date-time" },
      user: ref("UserProfile"),
      events: ref("EventHistory/properties/events"),
      purchases: { type: "array", items: ref("Purchase") },
      friends: ref("FriendList/properties/friends"),
      team: nullable({
        type: "object",
        required: ["id", "name", "joinedAt"],
        additionalProperties: false,
        properties: { id: { type: "string" }, name: { type: "string" }, joinedAt: { type: "string", format: "date-time" } },
      }),
      referrals: nullable({
        type: "object",
        required: ["referredBy", "referred"],
        additionalProperties: false,
        properties: { referredBy: nullable({ type: "string" }), referred: { type: "array", items: { type: "string" } } },
      }),
    },
  },
  Deleted: {
    type: "object",
    required: ["userId", "deleted"],
    additionalProperties: false,
    properties: { userId: { type: "string" }, deleted: { type: "boolean", description: "False if the user did not exist." } },
  },
  ConfigPreview: {
    type: "object",
    required: ["users", "truncated", "levels", "achievements"],
    additionalProperties: false,
    properties: {
      users: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" },
      levels: nullable({
        type: "object",
        required: ["up", "down", "same"],
        additionalProperties: false,
        properties: { up: { type: "integer" }, down: { type: "integer" }, same: { type: "integer" } },
      }),
      achievements: map({
        type: "object",
        required: ["wouldUnlock", "noLongerQualify"],
        additionalProperties: false,
        properties: { wouldUnlock: { type: "integer" }, noLongerQualify: { type: "integer" } },
      }),
    },
  },
  PrestigeResult: {
    type: "object",
    required: ["userId", "prestige", "level", "rewards"],
    additionalProperties: false,
    properties: { userId: { type: "string" }, prestige: { type: "integer", minimum: 1 }, level: { type: "integer", minimum: 1 }, rewards: { type: "array", items: ref("QuestReward") } },
  },
  LeaderboardHistory: {
    type: "object",
    required: ["id", "currency", "period", "windows"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      currency: { type: "string" },
      period: { enum: ["daily", "weekly", "monthly"] },
      windows: {
        type: "array",
        items: {
          type: "object",
          required: ["from", "to", "entries"],
          additionalProperties: false,
          properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, entries: { type: "array", items: ref("RankedUser") } },
        },
      },
    },
  },
  LeaderboardResult: {
    type: "object",
    required: ["id", "currency", "period", "scope", "from", "to", "entries", "user"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      currency: { type: "string" },
      period: { enum: ["daily", "weekly", "monthly", "all"] },
      scope: { enum: ["all", "friends"] },
      around: { type: "integer", description: "Set when entries are the places around the user rather than the top." },
      segment: {
        type: "object",
        required: ["key", "value"],
        additionalProperties: false,
        properties: { key: { type: "string" }, value: { type: "string" } },
        description: "Set when only users with this profile metadata were ranked.",
      },
      from: nullable({ type: "string", format: "date-time" }),
      to: nullable({ type: "string", format: "date-time" }),
      entries: { type: "array", items: ref("RankedUser") },
      user: nullable(ref("RankedUser")),
    },
  },
  LeagueEntry: {
    type: "object",
    required: ["rank", "userId", "score", "displayName", "avatarUrl", "zone"],
    additionalProperties: false,
    properties: {
      rank: { type: "integer", minimum: 1 },
      userId: { type: "string" },
      score: { type: "number" },
      displayName: nullable({ type: "string" }),
      avatarUrl: nullable({ type: "string" }),
      zone: { enum: ["promotion", "demotion", "safe"] },
    },
  },
  LeagueStatus: {
    type: "object",
    required: ["id", "tier", "tiers", "round", "group", "you", "previous"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      tier: { type: "string" },
      tiers: { type: "array", items: { type: "string" } },
      round: {
        type: "object",
        required: ["key", "startsAt", "endsAt"],
        additionalProperties: false,
        properties: { key: { type: "string" }, startsAt: { type: "string", format: "date-time" }, endsAt: { type: "string", format: "date-time" } },
      },
      group: nullable({
        type: "object",
        required: ["number", "size", "entries"],
        additionalProperties: false,
        properties: { number: { type: "integer" }, size: { type: "integer" }, entries: { type: "array", items: ref("LeagueEntry") } },
      }),
      you: nullable(ref("LeagueEntry")),
      previous: nullable(ref("LeaguePrevious")),
    },
  },
  EventHistory: {
    type: "object",
    required: ["events", "nextCursor"],
    additionalProperties: false,
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "event", "value", "timestamp", "recordedAt", "properties", "reversedAt", "result"],
          additionalProperties: false,
          properties: {
            id: { type: "string", format: "uuid" },
            event: { type: "string" },
            value: { type: "number" },
            timestamp: { type: "string", format: "date-time" },
            recordedAt: { type: "string", format: "date-time" },
            reversedAt: nullable({ type: "string", format: "date-time" }),
            properties: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } },
            result: nullable(ref("TrackResult")),
          },
        },
      },
      nextCursor: nullable({ type: "string" }),
    },
  },
  BatchRequest: {
    type: "object",
    required: ["events"],
    properties: { events: { type: "array", minItems: 1, maxItems: 100, items: ref("TrackInput") } },
  },
  BatchResponse: {
    type: "object",
    required: ["results"],
    additionalProperties: false,
    properties: {
      results: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              required: ["ok", "result"],
              additionalProperties: false,
              properties: { ok: { const: true }, result: ref("TrackResult") },
            },
            {
              type: "object",
              required: ["ok", "status", "error"],
              additionalProperties: false,
              properties: { ok: { const: false }, status: { type: "integer" }, error: { type: "string" } },
            },
          ],
        },
      },
    },
  },
  FriendList: {
    type: "object",
    required: ["userId", "friends"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      friends: {
        type: "array",
        items: {
          type: "object",
          required: ["userId", "displayName", "avatarUrl", "since"],
          additionalProperties: false,
          properties: {
            userId: { type: "string" },
            displayName: nullable({ type: "string" }),
            avatarUrl: nullable({ type: "string" }),
            since: { type: "string", format: "date-time" },
          },
        },
      },
    },
  },
  FriendChange: {
    type: "object",
    required: ["userId", "friendId"],
    additionalProperties: false,
    properties: {
      userId: { type: "string" },
      friendId: { type: "string" },
      created: { type: "boolean", description: "False if they were already friends." },
      removed: { type: "boolean", description: "False if they were not friends." },
    },
  },
  RivalryStatus: {
    type: "object",
    required: ["rivalryId", "userId", "round", "rivals"],
    additionalProperties: false,
    properties: {
      rivalryId: { type: "string" },
      userId: { type: "string" },
      round: {
        type: "object",
        required: ["key", "startsAt", "endsAt"],
        additionalProperties: false,
        properties: { key: { type: "string" }, startsAt: { type: "string", format: "date-time" }, endsAt: { type: "string", format: "date-time" } },
      },
      rivals: {
        type: "array",
        items: {
          type: "object",
          required: ["rivalId", "displayName", "avatarUrl", "since", "current", "record", "streak", "last"],
          additionalProperties: false,
          properties: {
            rivalId: { type: "string" },
            displayName: nullable({ type: "string" }),
            avatarUrl: nullable({ type: "string" }),
            since: { type: "string", format: "date-time" },
            current: {
              type: "object",
              required: ["you", "them", "leading"],
              additionalProperties: false,
              properties: { you: { type: "number" }, them: { type: "number" }, leading: { enum: ["you", "them", "tied"] } },
            },
            record: {
              type: "object",
              required: ["wins", "losses", "draws"],
              additionalProperties: false,
              description: "Finished rounds where at least one side scored.",
              properties: { wins: { type: "integer" }, losses: { type: "integer" }, draws: { type: "integer" } },
            },
            streak: nullable({
              type: "object",
              required: ["outcome", "length"],
              additionalProperties: false,
              properties: { outcome: { enum: ["won", "lost", "draw"] }, length: { type: "integer", minimum: 1 } },
            }),
            last: nullable({
              type: "object",
              required: ["round", "you", "them", "outcome"],
              additionalProperties: false,
              properties: { round: { type: "string" }, you: { type: "number" }, them: { type: "number" }, outcome: { enum: ["won", "lost", "draw"] } },
            }),
          },
        },
      },
    },
  },
  RivalChange: {
    type: "object",
    required: ["rivalryId", "userId", "rivalId"],
    additionalProperties: false,
    properties: {
      rivalryId: { type: "string" },
      userId: { type: "string" },
      rivalId: { type: "string" },
      created: { type: "boolean", description: "False if they were already rivals." },
      removed: { type: "boolean", description: "False if they were not rivals." },
    },
  },
  Health: {
    type: "object",
    required: ["ok"],
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      database: { enum: ["ok", "unreachable"] },
      status: { enum: ["shutting_down"] },
    },
  },
};

export function openapiSpec(version: string) {
  const authErrors = { "400": errorResponse("Invalid input"), "401": errorResponse("Missing or wrong API key") };
  return {
    openapi: "3.1.0",
    info: {
      title: "onstreak",
      version,
      description: "Open-source gamification engine: points, levels, streaks, achievements, leaderboards and leagues.",
      license: { name: "MIT", identifier: "MIT" },
    },
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "The server's ONSTREAK_API_KEY." } },
      schemas,
    },
    paths: {
      "/v1/events": {
        post: {
          operationId: "track",
          summary: "Track an event",
          requestBody: { required: true, content: json(ref("TrackInput")) },
          responses: { "200": ok("What the event awarded", ref("TrackResult")), ...authErrors },
        },
      },
      "/v1/webhooks/deliveries": {
        get: {
          operationId: "webhookDeliveries",
          summary: "Webhook deliveries, newest first",
          parameters: [
            limitParam(),
            { name: "status", in: "query", schema: { enum: ["pending", "delivered", "failed"] } },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "nextCursor from the previous page." },
          ],
          responses: { "200": ok("A page of deliveries", ref("WebhookDeliveryList")), ...authErrors },
        },
      },
      "/v1/config/preview": {
        post: {
          operationId: "previewConfig",
          summary: "What a new config would change for existing users",
          description: "Changes nothing. Reports level moves and, per achievement (or tier), who would unlock it on their next event or no longer qualify.",
          requestBody: { required: true, content: json({ type: "object", description: "A full onstreak config, as in onstreak.config.json." }) },
          responses: { "200": ok("The preview", ref("ConfigPreview")), ...authErrors },
        },
      },
      "/v1/events/batch": {
        post: {
          operationId: "trackBatch",
          summary: "Track up to 100 events in order",
          description: "Each event is its own transaction. Bad items are reported in place; the rest still count.",
          requestBody: { required: true, content: json(ref("BatchRequest")) },
          responses: { "200": ok("One result per event, in order", ref("BatchResponse")), ...authErrors },
        },
      },
      "/v1/users/{userId}": {
        parameters: [userIdParam],
        get: {
          operationId: "getUser",
          summary: "A user's profile, points, level, streaks and achievements",
          parameters: [localeParam, { name: "timezone", in: "query", schema: { type: "string" }, description: "Override the zone used for streak status." }],
          responses: { "200": ok("The user (all zeros if never seen)", ref("UserProfile")), ...authErrors },
        },
        patch: {
          operationId: "updateUser",
          summary: "Set a user's display name, avatar, metadata or time zone",
          requestBody: { required: true, content: json(ref("ProfilePatch")) },
          responses: { "200": ok("The updated user", ref("UserProfile")), ...authErrors },
        },
        delete: {
          operationId: "deleteUser",
          summary: "Delete a user and everything about them",
          description: "Right to erasure. Their points leave every leaderboard and league; friendships, rivalries and referrals involving them go on both sides. Cannot be undone.",
          responses: { "200": ok("Whether the user existed", ref("Deleted")), ...authErrors },
        },
      },
      "/v1/users/{userId}/events": {
        parameters: [userIdParam],
        get: {
          operationId: "events",
          summary: "A user's events, newest first",
          parameters: [limitParam(), { name: "cursor", in: "query", schema: { type: "string" }, description: "nextCursor from the previous page." }],
          responses: { "200": ok("A page of events", ref("EventHistory")), ...authErrors },
        },
      },
      "/v1/users/{userId}/quests": {
        parameters: [userIdParam],
        get: {
          operationId: "quests",
          summary: "Every quest for the current day or week, with the user's progress",
          parameters: [localeParam, { name: "timezone", in: "query", schema: { type: "string" }, description: "Override the zone that decides when days start." }],
          responses: { "200": ok("The user's quests", ref("QuestList")), ...authErrors },
        },
      },
      "/v1/users/{userId}/store": {
        parameters: [userIdParam],
        get: {
          operationId: "rewardStore",
          summary: "The reward store: spendable balances, and what the user owns and can buy",
          parameters: [localeParam],
          responses: { "200": ok("The store for this user", ref("RewardStore")), ...authErrors },
        },
      },
      "/v1/users/{userId}/purchases": {
        parameters: [userIdParam],
        post: {
          operationId: "purchase",
          summary: "Buy an item with points",
          requestBody: { required: true, content: json(ref("PurchaseInput")) },
          responses: {
            "200": ok("The purchase and the balances after it", ref("PurchaseResult")),
            ...authErrors,
            "404": errorResponse("Unknown item"),
            "409": errorResponse('Not enough points (code "insufficient_funds") or the item limit is reached (code "limit_reached")'),
          },
        },
        get: {
          operationId: "purchases",
          summary: "A user's purchases, newest first",
          parameters: [limitParam(), { name: "cursor", in: "query", schema: { type: "string" }, description: "nextCursor from the previous page." }],
          responses: { "200": ok("A page of purchases", ref("PurchaseHistory")), ...authErrors },
        },
      },
      "/v1/users/{userId}/calendars": {
        parameters: [userIdParam],
        get: {
          operationId: "calendars",
          summary: "Login reward calendars with the user's place in each",
          parameters: [localeParam, { name: "timezone", in: "query", schema: { type: "string" }, description: "Override the zone that decides when days start." }],
          responses: { "200": ok("The user's calendars", ref("CalendarList")), ...authErrors },
        },
      },
      "/v1/users/{userId}/streaks/{streakId}/repair": {
        parameters: [userIdParam, { name: "streakId", in: "path", required: true, schema: { type: "string" } }],
        post: {
          operationId: "repairStreak",
          summary: "Repair a recently broken streak",
          description: "Allowed within the streak's repair.withinHours of breaking, before a new streak starts. The user still needs today's activity.",
          responses: {
            "200": ok("The repaired streak", ref("StreakRepairResult")),
            ...authErrors,
            "404": errorResponse("Unknown streak"),
            "409": errorResponse('Not broken ("not_broken"), too late ("repair_expired") or not enough points ("insufficient_funds")'),
          },
        },
      },
      "/v1/users/{userId}/purchases/{purchaseId}/refund": {
        parameters: [userIdParam, { name: "purchaseId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        post: {
          operationId: "refundPurchase",
          summary: "Refund some or all of a purchase",
          description: "The price goes back to the wallet and the items leave the inventory. Default quantity: everything not refunded yet.",
          requestBody: { content: json({ type: "object", additionalProperties: false, properties: { quantity: { type: "integer", minimum: 1 } } }) },
          responses: {
            "200": ok("The refund and the balances after it", ref("RefundResult")),
            ...authErrors,
            "404": errorResponse("No such purchase for this user"),
            "409": errorResponse('Items already used (code "not_owned") or nothing left to refund ("already_refunded")'),
          },
        },
      },
      "/v1/users/{userId}/referred-by/{referrerId}": {
        parameters: [userIdParam, { name: "referrerId", in: "path", required: true, schema: { type: "string", maxLength: 128 } }],
        put: {
          operationId: "addReferral",
          summary: "Record who referred a user",
          description: "Once per user. Both sides are paid when the new user qualifies (at once without referrals.qualify).",
          responses: {
            "200": ok("The referral", ref("ReferralResult")),
            ...authErrors,
            "404": errorResponse("Referrals are not configured"),
            "409": errorResponse('Already referred by someone else (code "already_referred")'),
          },
        },
      },
      "/v1/users/{userId}/referrals": {
        parameters: [userIdParam],
        get: {
          operationId: "referrals",
          summary: "Who referred a user and whom they referred",
          responses: { "200": ok("The user's referrals", ref("ReferralList")), ...authErrors, "404": errorResponse("Referrals are not configured") },
        },
      },
      "/v1/teams/{teamId}": {
        parameters: [{ name: "teamId", in: "path", required: true, schema: { type: "string", maxLength: 64 } }],
        put: {
          operationId: "saveTeam",
          summary: "Create a team, or rename it",
          requestBody: { required: true, content: json({ type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 80 } } }) },
          responses: { "200": ok("The team", ref("TeamSaved")), ...authErrors },
        },
        get: {
          operationId: "team",
          summary: "A team and its members",
          parameters: [{ name: "leaderboard", in: "query", schema: { type: "string" }, description: "Also show each member's points for the team, and the team's rank, on this leaderboard." }],
          responses: { "200": ok("The team", ref("TeamStatus")), ...authErrors, "404": errorResponse("Unknown team or leaderboard") },
        },
      },
      "/v1/teams/{teamId}/goals": {
        parameters: [{ name: "teamId", in: "path", required: true, schema: { type: "string", maxLength: 64 } }],
        get: {
          operationId: "teamGoals",
          summary: "The team's goals for the current day or week",
          description: "With userId, that member's part; a member who contributed is paid the rewards the first time they look after a goal is reached.",
          parameters: [{ name: "userId", in: "query", schema: { type: "string", maxLength: 128 } }],
          responses: { "200": ok("The team's goals", ref("TeamGoalList")), ...authErrors, "404": errorResponse("Unknown team") },
        },
      },
      "/v1/teams/{teamId}/members/{userId}": {
        parameters: [{ name: "teamId", in: "path", required: true, schema: { type: "string", maxLength: 64 } }, userIdParam],
        put: {
          operationId: "addTeamMember",
          summary: "Put a user in a team",
          description: "A user is in one team at a time. Their points count for the team from now on.",
          responses: {
            "200": ok("The membership", ref("TeamMembership")),
            ...authErrors,
            "404": errorResponse("Unknown team"),
            "409": errorResponse('In another team ("already_in_team") or the team is full ("team_full")'),
          },
        },
        delete: {
          operationId: "removeTeamMember",
          summary: "Take a user out of a team",
          responses: { "200": ok("Whether they were removed", ref("TeamMembership")), ...authErrors, "404": errorResponse("Unknown team") },
        },
      },
      "/v1/users/{userId}/events/{eventId}/reverse": {
        parameters: [userIdParam, { name: "eventId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        post: {
          operationId: "reverseEvent",
          summary: "Take back the points an event awarded",
          description: "Dated at the event's own time, so leaderboard windows and league rounds correct themselves. Streaks, quests and achievements are left as they are.",
          responses: {
            "200": ok("What was taken back", ref("ReversalResult")),
            ...authErrors,
            "404": errorResponse("No such event for this user"),
            "409": errorResponse('Already reversed ("already_reversed")'),
          },
        },
      },
      "/v1/users/{userId}/achievements/{achievementId}": {
        parameters: [userIdParam, { name: "achievementId", in: "path", required: true, schema: { type: "string" }, description: 'An achievement id, or "id#2" for one tier.' }],
        delete: {
          operationId: "revokeAchievement",
          summary: "Take back an achievement or one of its tiers",
          responses: { "200": ok("Whether it was unlocked", ref("Revoked")), ...authErrors, "404": errorResponse("Unknown achievement") },
        },
      },
      "/v1/users/{userId}/prestige": {
        parameters: [userIdParam],
        post: {
          operationId: "prestige",
          summary: "Start levels over with a higher prestige rank",
          description: "Only at the top level. Earned points are kept; levels count from here.",
          responses: {
            "200": ok("The new prestige rank", ref("PrestigeResult")),
            ...authErrors,
            "404": errorResponse("Prestige is not configured"),
            "409": errorResponse('Not at the top level yet ("not_max_level")'),
          },
        },
      },
      "/v1/users/{userId}/achievements": {
        parameters: [userIdParam],
        get: {
          operationId: "achievements",
          summary: "Every achievement with the user's progress",
          description: "Tiered badges list each tier. Hidden achievements have no name, description or progress until unlocked.",
          parameters: [localeParam],
          responses: { "200": ok("The user's achievements", ref("AchievementList")), ...authErrors },
        },
      },
      "/v1/users/{userId}/export": {
        parameters: [userIdParam],
        get: {
          operationId: "exportUser",
          summary: "Everything stored about a user, in one document",
          responses: { "200": ok("The export", ref("UserExport")), ...authErrors },
        },
      },
      "/v1/users/{userId}/team": {
        parameters: [userIdParam],
        get: {
          operationId: "userTeam",
          summary: "The team a user is in",
          responses: { "200": ok("The user's team, or null", ref("UserTeam")), ...authErrors },
        },
      },
      "/v1/streaks/{streakId}/at-risk": {
        parameters: [{ name: "streakId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: "streaksAtRisk",
          summary: "Users whose streak is going but who have not done this period's activity yet",
          description: "For reminders. Each user's time zone decides when their period ends. Pages by user id.",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
            { name: "endingWithinHours", in: "query", schema: { type: "number", exclusiveMinimum: 0, maximum: 744 }, description: "Only users whose period ends within this many hours." },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "nextCursor from the previous page." },
          ],
          responses: { "200": ok("A page of users at risk", ref("StreaksAtRisk")), ...authErrors, "404": errorResponse("Unknown streak") },
        },
      },
      "/v1/leaderboards/{leaderboardId}/history": {
        parameters: [{ name: "leaderboardId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: "leaderboardHistory",
          summary: "Winners of past windows, newest first",
          description: "Each window's top entries as they stood when it closed (late backfilled points do not change them).",
          parameters: [
            { name: "periods", in: "query", schema: { type: "integer", minimum: 1, maximum: 52, default: 5 } },
            { name: "top", in: "query", schema: { type: "integer", minimum: 1, maximum: 10, default: 3 } },
          ],
          responses: { "200": ok("Past winners", ref("LeaderboardHistory")), ...authErrors, "404": errorResponse("Unknown leaderboard") },
        },
      },
      "/v1/leaderboards/{leaderboardId}/teams": {
        parameters: [{ name: "leaderboardId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: "teamLeaderboard",
          summary: "Teams ranked by their members' points in a leaderboard's window",
          parameters: [limitParam(), { name: "teamId", in: "query", schema: { type: "string" } }],
          responses: { "200": ok("The ranking", ref("TeamLeaderboard")), ...authErrors, "404": errorResponse("Unknown leaderboard") },
        },
      },
      "/v1/seasons": {
        get: {
          operationId: "seasons",
          summary: "Every season, with a user's score, rank and award",
          description: "After a season ends, a user's award is paid the first time they look.",
          parameters: [{ name: "userId", in: "query", schema: { type: "string", maxLength: 128 } }],
          responses: { "200": ok("Every season", ref("SeasonList")), ...authErrors },
        },
      },
      "/v1/seasons/{seasonId}/standings": {
        parameters: [{ name: "seasonId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: "seasonStandings",
          summary: "A season's standings: live while it runs, fixed once it ends",
          parameters: [limitParam(), { name: "userId", in: "query", schema: { type: "string", maxLength: 128 } }],
          responses: { "200": ok("The standings", ref("SeasonStandings")), ...authErrors, "404": errorResponse("Unknown season") },
        },
      },
      "/v1/community-goals": {
        get: {
          operationId: "communityGoals",
          summary: "Goals everyone works toward together, with progress",
          description: "With userId, also that user's contribution. An eligible user is paid the rewards the first time they look after the goal is reached.",
          parameters: [{ name: "userId", in: "query", schema: { type: "string", maxLength: 128 } }],
          responses: { "200": ok("Every community goal", ref("CommunityGoalList")), ...authErrors },
        },
      },
      "/v1/users/{userId}/boosts": {
        parameters: [userIdParam],
        post: {
          operationId: "grantBoost",
          summary: "Give a user a personal multiplier for some minutes",
          description: "Applies to points from point rules for events while it runs. The same factor and currency queue back to back.",
          requestBody: { required: true, content: json(ref("BoostInput")) },
          responses: { "200": ok("The new boost and every boost running or queued", ref("BoostResult")), ...authErrors },
        },
      },
      "/v1/users/{userId}/inventory/{itemId}/use": {
        parameters: [userIdParam, { name: "itemId", in: "path", required: true, schema: { type: "string" } }],
        post: {
          operationId: "useItem",
          summary: "Use owned items, applying the item's effect",
          requestBody: { content: json(ref("ItemUseInput")) },
          responses: {
            "200": ok("What was used and what it did", ref("ItemUseResult")),
            ...authErrors,
            "404": errorResponse("Unknown item"),
            "409": errorResponse('Not enough owned (code "not_owned"), freezes at their max ("limit_reached"), or the streak is already broken ("streak_broken")'),
          },
        },
      },
      "/v1/users/{userId}/friends": {
        parameters: [userIdParam],
        get: {
          operationId: "friends",
          summary: "A user's friends, newest first",
          responses: { "200": ok("The user's friends", ref("FriendList")), ...authErrors },
        },
      },
      "/v1/users/{userId}/friends/{friendId}": {
        parameters: [userIdParam, { name: "friendId", in: "path", required: true, schema: { type: "string", maxLength: 128 } }],
        put: {
          operationId: "addFriend",
          summary: "Make two users friends (mutual). Safe to repeat",
          responses: {
            "200": ok("Friends now", ref("FriendChange")),
            ...authErrors,
            "409": errorResponse("One of them already has the maximum number of friends"),
          },
        },
        delete: {
          operationId: "removeFriend",
          summary: "End a friendship, for both users. Safe to repeat",
          responses: { "200": ok("Not friends now", ref("FriendChange")), ...authErrors },
        },
      },
      "/v1/rivalries/{rivalryId}/users/{userId}": {
        parameters: [{ name: "rivalryId", in: "path", required: true, schema: { type: "string" } }, userIdParam],
        get: {
          operationId: "rivals",
          summary: "A user's rivals: this round's live score, record, streak and last result",
          description: "Finished rounds are settled on first look and never change afterwards.",
          responses: { "200": ok("The user's rivals", ref("RivalryStatus")), ...authErrors, "404": errorResponse("No such rivalry") },
        },
      },
      "/v1/rivalries/{rivalryId}/users/{userId}/rivals/{rivalId}": {
        parameters: [
          { name: "rivalryId", in: "path", required: true, schema: { type: "string" } },
          userIdParam,
          { name: "rivalId", in: "path", required: true, schema: { type: "string", maxLength: 128 } },
        ],
        put: {
          operationId: "addRival",
          summary: "Start a rivalry (mutual). Safe to repeat",
          responses: {
            "200": ok("Rivals now", ref("RivalChange")),
            ...authErrors,
            "404": errorResponse("No such rivalry"),
            "409": errorResponse("One of them already has the maximum number of rivals"),
          },
        },
        delete: {
          operationId: "removeRival",
          summary: "End a rivalry and its history. Safe to repeat",
          responses: { "200": ok("Not rivals now", ref("RivalChange")), ...authErrors, "404": errorResponse("No such rivalry") },
        },
      },
      "/v1/leaderboards/{leaderboardId}": {
        parameters: [{ name: "leaderboardId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: "leaderboard",
          summary: "Top entries for the current window",
          parameters: [
            limitParam(),
            { name: "userId", in: "query", schema: { type: "string" }, description: "Also return this user's own rank. Required for scope=friends." },
            {
              name: "scope",
              in: "query",
              schema: { enum: ["all", "friends"], default: "all" },
              description: "friends: rank only the user and their friends, including friends with no points yet.",
            },
            { name: "around", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 }, description: "With userId: the entries within this many places of the user, instead of the top." },
            { name: "segment", in: "query", schema: { type: "string" }, description: 'Rank only users whose profile metadata matches, as "key:value" (e.g. "country:IN").' },
          ],
          responses: { "200": ok("The leaderboard", ref("LeaderboardResult")), ...authErrors, "404": errorResponse("No such leaderboard") },
        },
      },
      "/v1/leagues/{leagueId}/users/{userId}": {
        parameters: [{ name: "leagueId", in: "path", required: true, schema: { type: "string" } }, userIdParam],
        get: {
          operationId: "league",
          summary: "A user's league tier, live group standings and last round's result",
          responses: { "200": ok("The user's league status", ref("LeagueStatus")), ...authErrors, "404": errorResponse("No such league") },
        },
      },
      "/health": {
        get: {
          operationId: "health",
          summary: "Ready: the process and the database are up",
          security: [],
          responses: { "200": ok("Ready", ref("Health")), "503": ok("Not ready", ref("Health")) },
        },
      },
      "/health/live": {
        get: {
          operationId: "live",
          summary: "Alive: the process is up",
          security: [],
          responses: { "200": ok("Alive", ref("Health")) },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "openapi",
          summary: "This document",
          security: [],
          responses: { "200": { description: "OpenAPI 3.1 document", content: json({ type: "object" }) } },
        },
      },
    },
  };
}
