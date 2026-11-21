/** Minimal structured logger: one JSON object per line, or readable text for local use. */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LOG_LEVELS = Object.keys(ORDER) as LogLevel[];

export interface LoggerOptions {
  level?: LogLevel;
  format?: "json" | "pretty";
  /** Where lines go. Default: stdout. */
  write?: (line: string) => void;
  /** Clock, for tests. */
  now?: () => Date;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  const format = options.format ?? "json";
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (ORDER[level] < min) return;
    const clean: LogFields = {};
    for (const [k, v] of Object.entries(fields)) clean[k] = serializeError(v);
    const time = now().toISOString();
    if (format === "json") {
      write(JSON.stringify({ time, level, msg, ...clean }));
    } else {
      const rest = Object.entries(clean)
        .filter(([k]) => k !== "err")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      const err = clean.err as { stack?: string } | undefined;
      write(`${time} ${level.toUpperCase().padEnd(5)} ${msg}${rest ? ` ${rest}` : ""}${err?.stack ? `\n${err.stack}` : ""}`);
    }
  };

  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
  };
}

/** Discards everything. The default for library use, so embedding apps stay quiet. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
