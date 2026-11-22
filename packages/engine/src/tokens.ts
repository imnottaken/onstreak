import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "ust_";

/** A user token: lets a browser or app read one user's own data until it expires. */
export function signUserToken(secret: string, userId: string, expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, exp: Math.floor(expiresAtMs / 1000) })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${PREFIX}${payload}.${sig}`;
}

/** The user id a token is for, or null if it is malformed, forged or expired. */
export function verifyUserToken(secret: string, token: string, nowMs = Date.now()): string | null {
  if (!token.startsWith(PREFIX)) return null;
  const [payload, sig] = token.slice(PREFIX.length).split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; exp?: unknown };
    if (typeof u !== "string" || typeof exp !== "number" || exp * 1000 <= nowMs) return null;
    return u;
  } catch {
    return null;
  }
}

export function isUserToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

/** The signing secret when none is set: derived from a key, so it changes if that key is rotated. */
export function deriveTokenSecret(key: string): string {
  return createHash("sha256").update(`onstreak-user-tokens:${key}`).digest("hex");
}
