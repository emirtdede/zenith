#!/usr/bin/env node
/**
 * `check:resources` - the pinned-asset manifest must stay a real contract.
 *
 * ## What this gate exists to stop
 *
 * `resources/` is the air-gap promise of `08-01` section 2, and the binaries are
 * deliberately **not** committed: the WebView2 offline installer alone is 215 MB,
 * past GitHub's per-file limit, and the set is 307 MB that no line of code reads.
 * What is committed is `manifest.json`, which pins every asset by SHA-256.
 *
 * That split has one failure mode that matters: the manifest quietly stops
 * describing what a build needs. Four ways it happens, each seen in real repos:
 *
 *   1. an asset is added to the tree and never pinned, so its bytes are trusted
 *      by nobody and a rebuild on another machine fetches something else;
 *   2. a pin is edited to match a corrupted local file - the hash becomes a
 *      description of the damage rather than a defence against it;
 *   3. a field is dropped, so `fetch.mjs` cannot verify (no `sha256`), cannot
 *      even report the size (`bytes`), or cannot fetch (`source`);
 *   4. two assets share an id or a path, so `--only <id>` fetches one and a
 *      reader believes both.
 *
 * A file that is *absent* is not a failure here: this gate runs in CI, where
 * nothing has been fetched yet, and on a developer machine before
 * `node resources/fetch.mjs` has run. A file that is *present* must match its
 * pin, which is the check that catches case 2.
 *
 * ## Usage
 *
 *   node scripts/check-resources.mjs
 *
 * Exit 0 when the manifest is complete, self-consistent and every present file
 * matches. Exit 1 otherwise, naming each problem.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = join(ROOT, "resources");
const MANIFEST_PATH = join(RESOURCES, "manifest.json");

const problems = [];
const notes = [];

if (!existsSync(MANIFEST_PATH)) {
  console.error("resources/manifest.json is missing; nothing pins the vendored assets (08-01 section 2).");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (error) {
  console.error(`resources/manifest.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

/** Every asset must be verifiable; these are the fields `fetch.mjs` depends on. */
const REQUIRED = ["id", "path", "bytes", "sha256", "source", "licence"];
const SHA256 = /^[0-9A-Fa-f]{64}$/;

const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
if (assets.length === 0) {
  problems.push("manifest asserts no assets; an empty manifest is not a pin");
}

const ids = new Set();
const paths = new Set();
let present = 0;
let verified = 0;

for (const [index, asset] of assets.entries()) {
  const label = asset?.id ?? `assets[${index}]`;

  if (!asset || typeof asset !== "object") {
    problems.push(`${label}: entry is not an object`);
    continue;
  }

  for (const field of REQUIRED) {
    if (asset[field] === undefined || asset[field] === null || asset[field] === "") {
      problems.push(`${label}: missing "${field}"`);
    }
  }

  if (typeof asset.id === "string") {
    if (ids.has(asset.id)) problems.push(`${label}: duplicate id "${asset.id}"`);
    ids.add(asset.id);
  }

  if (typeof asset.path === "string") {
    if (paths.has(asset.path)) problems.push(`${label}: duplicate path "${asset.path}"`);
    paths.add(asset.path);
    // A path that escapes resources/ would make `fetch.mjs` write outside the
    // directory it owns, and the manifest is the only thing that names it.
    if (asset.path.includes("..") || /^[\\/]/.test(asset.path) || /^[A-Za-z]:/.test(asset.path)) {
      problems.push(`${label}: path "${asset.path}" is not relative to resources/`);
    }
  }

  if (asset.sha256 !== undefined && !SHA256.test(String(asset.sha256))) {
    problems.push(`${label}: sha256 is not 64 hex characters`);
  }

  if (asset.bytes !== undefined && (!Number.isInteger(asset.bytes) || asset.bytes <= 0)) {
    problems.push(`${label}: bytes must be a positive integer`);
  }

  const onDisk = typeof asset.path === "string" ? join(RESOURCES, asset.path) : null;
  if (!onDisk || !existsSync(onDisk)) {
    notes.push(`${asset.path ?? label}: not fetched (run \`node resources/fetch.mjs\`)`);
    continue;
  }

  present += 1;
  const size = statSync(onDisk).size;
  if (Number.isInteger(asset.bytes) && size !== asset.bytes) {
    problems.push(`${asset.path}: ${size} bytes on disk, manifest pins ${asset.bytes}`);
  }

  const digest = createHash("sha256").update(readFileSync(onDisk)).digest("hex").toUpperCase();
  if (String(asset.sha256).toUpperCase() !== digest) {
    problems.push(
      `${asset.path}: sha256 on disk is ${digest.slice(0, 16)}..., manifest pins ` +
        `${String(asset.sha256).slice(0, 16)}...`,
    );
  } else {
    verified += 1;
  }
}

console.log(
  `resources: ${assets.length} pinned asset(s), ${present} present on this machine, ` +
    `${verified} hash-verified`,
);

if (notes.length > 0) {
  console.log("");
  for (const note of notes) console.log(`  absent   ${note}`);
}

if (problems.length > 0) {
  console.error("");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nresources/manifest.json is the pin for the vendored assets. Fix the manifest, or " +
      "re-fetch the file with `node resources/fetch.mjs`. Editing a pin to match a file on " +
      "disk turns the hash into a description of the damage instead of a defence against it.",
  );
  process.exit(1);
}

console.log("");
console.log(
  present === assets.length
    ? "every pinned asset is present and every hash matches."
    : "the manifest is complete and every present asset matches it; absent assets are fetched, not committed.",
);
