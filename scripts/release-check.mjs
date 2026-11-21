#!/usr/bin/env node
// Checks the packages are ready to publish, without publishing anything.
// Runs in CI on every push, and in the release workflow before publishing.
//
//   npm run build && npm run release:check
//   RELEASE_TAG=v0.2.0 npm run release:check   # also checks the tag and changelog
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const errors = [];

const packages = [
  { dir: "packages/engine", required: ["dist/index.js", "dist/index.d.ts", "dist/main.js", "dist/cli.js"] },
  { dir: "packages/sdk", required: ["dist/index.js", "dist/index.d.ts"] },
  { dir: "packages/react", required: ["dist/index.js", "dist/index.d.ts", "styles.css"] },
].map((p) => ({ ...p, json: JSON.parse(read(`${p.dir}/package.json`)) }));

// 1. One version for every package, and they depend on each other at that version.
const versions = new Set(packages.map((p) => p.json.version));
if (versions.size !== 1) errors.push(`packages must share one version, found: ${[...versions].join(", ")}`);
const version = packages[0].json.version;
for (const { dir, json } of packages) {
  for (const [name, range] of Object.entries({ ...json.dependencies, ...json.peerDependencies })) {
    if (name.startsWith("@onstreak/") && range !== version) {
      errors.push(`${dir}/package.json: depends on ${name}@${range}, but this release is ${version}`);
    }
  }
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) errors.push(`version "${version}" is not semver`);

// 2. Tag and changelog agree when releasing.
const changelog = read("CHANGELOG.md");
if (!changelog.includes("## [Unreleased]")) errors.push("CHANGELOG.md needs an [Unreleased] section");
const ref = process.env.GITHUB_REF ?? "";
const tag = process.env.RELEASE_TAG || (ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "");
if (tag) {
  if (tag !== `v${version}`) errors.push(`tag ${tag} does not match package version v${version}`);
  if (!changelog.includes(`## [${version}]`)) errors.push(`CHANGELOG.md has no section for ${version}`);
}

// 3. Metadata npm and provenance need.
for (const { dir, json } of packages) {
  const where = `${dir}/package.json`;
  if (json.license !== "MIT") errors.push(`${where}: license must be MIT`);
  if (!json.repository?.url?.includes("github.com/imnottaken/onstreak")) errors.push(`${where}: repository.url must point at the GitHub repo (provenance needs it)`);
  if (json.publishConfig?.access !== "public") errors.push(`${where}: publishConfig.access must be public`);
  if (json.publishConfig?.provenance !== true) errors.push(`${where}: publishConfig.provenance must be true`);
  if (!json.exports?.["."]?.types) errors.push(`${where}: exports must declare types`);
}

// 4. What will actually be in each tarball.
for (const { dir, json, required } of packages) {
  let files;
  try {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--workspace", json.name], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    files = JSON.parse(out)[0].files.map((f) => f.path);
  } catch (err) {
    errors.push(`${json.name}: npm pack failed: ${err.message}`);
    continue;
  }
  for (const path of [...required, "package.json", "README.md", "LICENSE"]) {
    if (!files.includes(path)) errors.push(`${json.name}: tarball is missing ${path} (did you run npm run build?)`);
  }
  for (const path of files) {
    if (/(^|\/)test\//.test(path) || path.endsWith(".tsbuildinfo") || path.startsWith("src/") || path.endsWith(".mjs")) {
      errors.push(`${json.name}: tarball should not contain ${path}`);
    }
  }
  console.log(`${json.name}@${json.version}: ${files.length} files`);
}

if (errors.length > 0) {
  console.error(`\nrelease check failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
console.log(`release check passed for v${version}${tag ? ` (tag ${tag})` : ""}`);
