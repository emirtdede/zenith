#!/usr/bin/env node
/**
 * Fetch the vendored build assets named in `manifest.json`.
 *
 * ## Why the binaries are not in the repository
 *
 * `resources/` is the air-gap promise: a clean Windows machine can rebuild
 * Zenith without reaching the internet (`08-01` section 2). The set is 307 MB,
 * and one member of it, the WebView2 evergreen offline installer, is 215 MB -
 * larger than GitHub's 100 MB per-file limit, so it cannot be committed at all.
 * Committing the other five and excluding that one would make the repository
 * look complete while the one asset that matters most on a locked-down image
 * was missing.
 *
 * So the *pins* are committed and the *bytes* are fetched:
 *
 *   * `manifest.json` carries the SHA-256, byte count and source URL of every
 *     asset, so the repository states exactly what a build needs;
 *   * this script is the only thing that writes into `resources/`, and it
 *     refuses any file whose SHA-256 or byte count differs from the manifest.
 *
 * A hash that is checked after a download is the whole point. A download that
 * is merely "the URL the documentation mentions" is a supply-chain gamble, and
 * the manifest exists so that gamble is never taken here.
 *
 * ## Usage
 *
 *   node resources/fetch.mjs            # fetch whatever is missing or wrong
 *   node resources/fetch.mjs --verify   # check what is on disk, fetch nothing
 *   node resources/fetch.mjs --only nsis-3.11
 *
 * Exit codes: 0 all present and correct; 1 something is missing or corrupt
 * (with `--verify`) or a download failed; 2 the manifest itself is unusable.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");

const args = process.argv.slice(2);
const VERIFY_ONLY = args.includes("--verify");
const onlyAt = args.indexOf("--only");
const ONLY = onlyAt === -1 ? null : args[onlyAt + 1];

if (onlyAt !== -1 && !ONLY) {
  console.error("--only needs an asset id, for example: --only nsis-3.11");
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (error) {
  console.error(`cannot read ${MANIFEST_PATH}: ${error.message}`);
  process.exit(2);
}

const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
if (assets.length === 0) {
  console.error("manifest.json lists no assets; it is not a usable manifest.");
  process.exit(2);
}

/** SHA-256 of a file, uppercase hex, which is how the manifest stores it. */
function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

/** One asset's state on disk: absent, wrong size, wrong hash, or good. */
function inspect(asset) {
  const path = join(HERE, asset.path);
  if (!existsSync(path)) return { state: "missing", path };
  const size = statSync(path).size;
  if (typeof asset.bytes === "number" && size !== asset.bytes) {
    return { state: "bad-size", path, detail: `${size} bytes, manifest says ${asset.bytes}` };
  }
  const hash = hashFile(path);
  if (hash !== asset.sha256.toUpperCase()) {
    return { state: "bad-hash", path, detail: `${hash.slice(0, 16)}..., manifest says ${asset.sha256.slice(0, 16)}...` };
  }
  return { state: "ok", path };
}

/** Download to `path.part`, verify, then rename. A partial file never lands. */
async function fetchAsset(asset) {
  const target = join(HERE, asset.path);
  const part = `${target}.part`;
  mkdirSync(dirname(target), { recursive: true });

  console.log(`  fetching ${asset.path}`);
  console.log(`    from ${asset.source}`);

  const response = await fetch(asset.source, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error("response has no body");

  const out = createWriteStream(part);
  const hash = createHash("sha256");
  let bytes = 0;

  for await (const chunk of response.body) {
    bytes += chunk.length;
    hash.update(chunk);
    if (!out.write(chunk)) {
      await new Promise((resolve) => out.once("drain", resolve));
    }
  }
  await new Promise((resolve, reject) => {
    out.end((error) => (error ? reject(error) : resolve()));
  });

  // Verify before the rename. A `.part` file that fails is deleted, so the next
  // run starts clean instead of trusting a truncated download.
  const digest = hash.digest("hex").toUpperCase();
  if (typeof asset.bytes === "number" && bytes !== asset.bytes) {
    throw new Error(`size mismatch: got ${bytes} bytes, manifest says ${asset.bytes}`);
  }
  if (digest !== asset.sha256.toUpperCase()) {
    throw new Error(`hash mismatch: got ${digest}, manifest says ${asset.sha256}`);
  }

  renameSync(part, target);
  console.log(`    ok ${bytes} bytes, sha256 ${digest.slice(0, 16)}...`);
}

// ---------------------------------------------------------------- main

const selected = ONLY ? assets.filter((asset) => asset.id === ONLY) : assets;
if (ONLY && selected.length === 0) {
  console.error(`no asset with id "${ONLY}". Known ids: ${assets.map((a) => a.id).join(", ")}`);
  process.exit(2);
}

console.log(`resources manifest: ${assets.length} assets, generated ${manifest.generatedAtUtc ?? "unknown"}`);
console.log(VERIFY_ONLY ? "mode: verify only" : "mode: fetch what is missing or wrong");
console.log("");

const problems = [];

for (const asset of selected) {
  const before = inspect(asset);

  if (before.state === "ok") {
    console.log(`ok       ${asset.path}`);
    continue;
  }

  if (VERIFY_ONLY) {
    const detail = before.detail ? ` (${before.detail})` : "";
    console.log(`MISSING  ${asset.path}${detail}`);
    problems.push(`${asset.path}: ${before.state}${detail}`);
    continue;
  }

  if (before.state !== "missing") {
    console.log(`re-fetch ${asset.path}: ${before.detail}`);
  }

  try {
    await fetchAsset(asset);
    const after = inspect(asset);
    if (after.state !== "ok") throw new Error(`still ${after.state} after download`);
  } catch (error) {
    console.log(`FAILED   ${asset.path}: ${error.message}`);
    problems.push(`${asset.path}: ${error.message}`);
  }
}

console.log("");

if (problems.length > 0) {
  console.error(`${problems.length} asset(s) missing or corrupt:`);
  for (const problem of problems) console.error(`  ${problem}`);
  if (VERIFY_ONLY) {
    console.error("\nRe-run without --verify to fetch the missing files.");
  } else {
    console.error("\nA pinned asset could not be obtained. Do not build against it: " +
      "08-01 section 2 explains what each one is for, and manifest.json carries the hash " +
      "the file must have.");
  }
  process.exit(1);
}

console.log(VERIFY_ONLY
  ? "every pinned asset is present and matches its manifest hash."
  : "every pinned asset is present and matches its manifest hash.");
