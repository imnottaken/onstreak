import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const script = new URL("../../../scripts/release-check.mjs", import.meta.url).pathname;
const run = (env = {}) => {
  const { GITHUB_REF, ...rest } = process.env; // do not inherit a CI tag ref
  return spawnSync(process.execPath, [script], { env: { ...rest, ...env }, encoding: "utf8" });
};

test("release check passes for the built packages", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /@onstreak\/engine@\d+\.\d+\.\d+: \d+ files/);
  assert.match(r.stdout, /release check passed/);
});

test("release check refuses a tag that does not match the version", () => {
  const r = run({ RELEASE_TAG: "v9.9.9" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tag v9\.9\.9 does not match package version/);
  assert.match(r.stderr, /CHANGELOG\.md has no section/);
});
