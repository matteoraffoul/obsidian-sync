#!/usr/bin/env node
// Sets the version of plugin and server in one go.
//
//   npm run bump -- patch|minor|major|<x.y.z> [--min-app <obsidian version>]
//
// Updates manifest.json, versions.json and every package.json, then prints the git
// commands that publish the release (the tag triggers .github/workflows/release.yml).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES = ["package.json", "shared/package.json", "server/package.json", "plugin/package.json"];

const readJson = (file) => JSON.parse(readFileSync(root + file, "utf8"));
const writeJson = (file, data) => writeFileSync(root + file, `${JSON.stringify(data, null, 2)}\n`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--min-app");
const minAppIndex = args.indexOf("--min-app");
const minApp = minAppIndex >= 0 ? args[minAppIndex + 1] : undefined;
if (!target) fail("Usage: npm run bump -- patch|minor|major|<x.y.z> [--min-app <obsidian version>]");

const manifest = readJson("manifest.json");
const current = manifest.version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!match) fail(`manifest.json has an unexpected version: ${current}`);
let [major, minor, patch] = match.slice(1).map(Number);

let next;
if (target === "patch") next = `${major}.${minor}.${patch + 1}`;
else if (target === "minor") next = `${major}.${minor + 1}.0`;
else if (target === "major") next = `${major + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(target)) next = target;
else fail(`Not a version or bump type: ${target}`);

const versions = readJson("versions.json");
if (versions[next]) fail(`Version ${next} already exists in versions.json`);
if (minApp && !/^\d+\.\d+\.\d+$/.test(minApp)) fail(`Not an Obsidian version: ${minApp}`);

manifest.version = next;
if (minApp) manifest.minAppVersion = minApp;
writeJson("manifest.json", manifest);

// versions.json maps each plugin version to the oldest Obsidian it runs on (used by Obsidian and BRAT).
versions[next] = manifest.minAppVersion;
writeJson("versions.json", versions);

for (const file of PACKAGES) {
  const pkg = readJson(file);
  pkg.version = next;
  writeJson(file, pkg);
}

console.log(`${current} -> ${next} (Obsidian >= ${manifest.minAppVersion})

Next steps:
  npm install                     # refreshes package-lock.json
  git commit -am "Release ${next}"
  git tag ${next}
  git push && git push origin ${next}
`);
