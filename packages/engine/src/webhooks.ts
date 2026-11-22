import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The value of the `onstreak-signature` header: `t=<unix seconds>,v1=<hex>`,
 * where v1 is HMAC-SHA256 of `${t}.${body}` with the webhook's secret.
 */
export function signWebhook(secret: string, body: string, timestampSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${v1}`;
}

/**
 * Check a delivery on the receiving side. Use the raw request body exactly
 * as received. Rejects signatures older (or newer) than `toleranceSeconds`
 * to stop replays.
 */
export function verifyWebhookSignature(secret: string, body: string, header: string | null | undefined, options: { toleranceSeconds?: number; now?: number } = {}): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || !/^[0-9a-f]{64}$/.test(parts.v1)) return false;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (options.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signWebhook(secret, body, t).split("v1=")[1]!, "hex");
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Wait before the next attempt: 30 s, 1 min, 2 min, ... capped at 6 hours. */
export function webhookBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);
}

/** Attempts before a delivery is marked failed. */
export const MAX_WEBHOOK_ATTEMPTS = 8;
