import { readFileSync } from "node:fs";

/** The @onstreak/engine package version. */
export function packageVersion(): string {
  const url = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}
