#!/usr/bin/env node
import { CliError, loadConfig, openStore, runCommand } from "./cli.js";
import { Engine } from "./engine.js";
import { createLogger, LOG_LEVELS, type LogLevel } from "./logger.js";
import { createOnstreakServer } from "./server.js";

const io = { out: (l: string) => process.stdout.write(`${l}\n`), err: (l: string) => process.stderr.write(`${l}\n`) };

async function serve(env: NodeJS.ProcessEnv): Promise<void> {
  const level = (env.ONSTREAK_LOG_LEVEL ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(level)) throw new CliError(`ONSTREAK_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  const logger = createLogger({ level, format: env.ONSTREAK_LOG_FORMAT === "pretty" ? "pretty" : "json" });

  const apiKey = env.ONSTREAK_API_KEY;
  if (!apiKey || apiKey.length < 16) throw new CliError("Set ONSTREAK_API_KEY (at least 16 characters) before starting onstreak.");
  const { config } = loadConfig(env);

  const opened = openStore(env);
  if (opened.kind === "memory") logger.warn("DATABASE_URL is not set: using the in-memory store. Data is lost when the server stops.");

  if (env.ONSTREAK_AUTO_MIGRATE === "false") {
    const status = opened.postgres ? await opened.postgres.migrationStatus() : null;
    if (status && status.pending.length > 0) {
      await opened.store.close();
      throw new CliError(`${status.pending.length} migration(s) pending and ONSTREAK_AUTO_MIGRATE=false: run "onstreak migrate" first`);
    }
  } else {
    await opened.ensureSchema();
    const report = await opened.store.migrate();
    for (const m of report.applied) logger.info("migration applied", { version: m.version, name: m.name });
  }

  const engine = new Engine(config, opened.store);
  const port = Number(env.PORT ?? 8787);
  const perMinute = env.ONSTREAK_RATE_LIMIT_PER_MINUTE ? Number(env.ONSTREAK_RATE_LIMIT_PER_MINUTE) : null;
  if (perMinute !== null && !(Number.isFinite(perMinute) && perMinute > 0)) throw new CliError("ONSTREAK_RATE_LIMIT_PER_MINUTE must be a positive number");
  const corsOrigins = (env.ONSTREAK_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const server = createOnstreakServer(engine, {
    apiKey,
    logger,
    ...(perMinute !== null ? { rateLimit: { perMinute, trustProxy: env.ONSTREAK_TRUST_PROXY === "true" } } : {}),
    ...(corsOrigins.length ? { corsOrigins } : {}),
  });
  server.listen(port, () => {
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    logger.info(`onstreak listening on http://localhost:${actual}`, { port: actual });
  });

  // Deliver webhooks in the background. Several servers can share a database: claims never overlap.
  let webhookTimer: NodeJS.Timeout | null = null;
  if (engine.config.webhooks.length > 0) {
    const every = Number(env.ONSTREAK_WEBHOOK_INTERVAL_MS ?? 2000);
    let busy = false;
    webhookTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      engine
        .deliverWebhooks()
        .then((r) => {
          if (r.attempted > 0) logger.info("webhooks", r);
        })
        .catch((err) => logger.error("webhook delivery failed", { err }))
        .finally(() => {
          busy = false;
        });
    }, every);
    logger.info("webhook delivery on", { webhooks: engine.config.webhooks.length, everyMs: every });
  }

  // Scheduled jobs (streak reminders, season ends) only matter when webhooks carry them.
  let jobsTimer: NodeJS.Timeout | null = null;
  if (engine.config.webhooks.length > 0) {
    const every = Number(env.ONSTREAK_SCHEDULER_INTERVAL_MS ?? 60_000);
    let busy = false;
    const run = () => {
      if (busy) return;
      busy = true;
      engine
        .runScheduledJobs()
        .then((r) => {
          if (r.reminders > 0 || r.seasonsEnded > 0) logger.info("scheduled jobs", r);
        })
        .catch((err) => logger.error("scheduled jobs failed", { err }))
        .finally(() => {
          busy = false;
        });
    };
    jobsTimer = setInterval(run, every);
    run();
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) {
      logger.warn("second signal, exiting now", { signal });
      process.exit(1);
    }
    stopping = true;
    const timeoutMs = Number(env.ONSTREAK_SHUTDOWN_TIMEOUT_MS ?? 10_000);
    logger.info("shutting down", { signal, timeoutMs });
    if (webhookTimer) clearInterval(webhookTimer);
    if (jobsTimer) clearInterval(jobsTimer);
    const { forced } = await server.shutdown({ timeoutMs });
    logger.info("stopped", { forced });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

async function main(): Promise<void> {
  const result = await runCommand(process.argv.slice(2), process.env, io);
  if (result === "serve") return serve(process.env);
  process.exitCode = result;
}

main().catch((err) => {
  io.err(err instanceof CliError ? err.message : err instanceof Error ? err.message : String(err));
  process.exit(1);
});
