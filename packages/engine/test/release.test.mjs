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

test("release check catches a package depending on an old version of another", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const path = new URL("../../react/package.json", import.meta.url);
  const original = readFileSync(path, "utf8");
  try {
    const pkg = JSON.parse(original);
    pkg.dependencies["@onstreak/sdk"] = "0.0.9";
    writeFileSync(path, JSON.stringify(pkg, null, 2));
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /depends on @onstreak\/sdk@0\.0\.9, but this release is/);
  } finally {
    writeFileSync(path, original);
  }
});
