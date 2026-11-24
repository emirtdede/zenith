#!/usr/bin/env node
/**
 * `msix:package` - produce the Microsoft Store package from the release binary.
 *
 * Tauri 2 has no MSIX target, so the Store package is assembled here instead of
 * being described in a document and left unbuilt. That distinction matters: a
 * checklist row that says "add the MSIX target" can stay FAIL forever without
 * anyone noticing, while a script that either writes a package or exits non-zero
 * cannot.
 *
 * Two identities, deliberately separate:
 *
 *   * `test` (the default) uses `Vellium.Zenith.LocalTest` and writes
 *     `..._test.msix`. It proves the layout, the manifest, and the SDK's
 *     validation without pretending to be a Store submission.
 *   * `partner-center` reads the reserved identity from
 *     `src-tauri/msix/identity.json` and refuses to run while any of the three
 *     fields is null. A guessed identity is rejected by ingestion, so producing
 *     one is worse than producing nothing.
 *
 * The manifest is validated by `makeappx pack` itself against the Windows
 * schema. There is no home-grown XML check to drift from it.
 *
 * Usage:
 *   node scripts/pack-msix.mjs                       # local test package
 *   node scripts/pack-msix.mjs --identity partner-center
 *   node scripts/pack-msix.mjs --out <path> --no-pack
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE = join(ROOT, "src-tauri", "msix", "AppxManifest.template.xml");
export const IDENTITY = join(ROOT, "src-tauri", "msix", "identity.json");
export const ICONS = join(ROOT, "src-tauri", "icons");
export const BINARY = join(ROOT, "target", "release", "zenith.exe");

/** The tile assets the manifest names, and the size Windows requires for each. */
export const REQUIRED_ASSETS = [
  { file: "StoreLogo.png", width: 50, height: 50 },
  { file: "Square44x44Logo.png", width: 44, height: 44 },
  { file: "Square150x150Logo.png", width: 150, height: 150 },
  { file: "Square310x310Logo.png", width: 310, height: 310 },
  { file: "Square71x71Logo.png", width: 71, height: 71 },
  { file: "Wide310x150Logo.png", width: 310, height: 150 },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Locate makeappx: env override, then PATH, then the newest installed SDK. */
export function makeappx() {
  const override = process.env.MAKEAPPX;
  if (override && existsSync(override)) return override;

  const onPath = spawnSync("makeappx.exe", ["/?"], { encoding: "utf8" });
  if (!onPath.error && onPath.status !== null) return "makeappx.exe";

  const kit = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (existsSync(kit)) {
    const versions = readdirSync(kit)
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const left = a.split(".").map(Number);
        const right = b.split(".").map(Number);
        for (let i = 0; i < 4; i += 1) if (left[i] !== right[i]) return right[i] - left[i];
        return 0;
      });
    for (const version of versions) {
      const candidate = join(kit, version, "x64", "makeappx.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** `1.0.0` is a product version; an MSIX identity needs four parts. */
export function fourPartVersion(version) {
  const parts = String(version).trim().split(".");
  if (parts.length > 4) throw new Error(`version "${version}" has more than four parts`);
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`version "${version}" is not numeric`);
    return Number(part);
  });
  while (numbers.length < 4) numbers.push(0);
  return numbers.join(".");
}

export function productVersion() {
  const config = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  return config.version;
}

export function readIdentity(kind) {
  const file = JSON.parse(readFileSync(IDENTITY, "utf8"));
  if (kind === "test") {
    const test = file.testIdentity ?? {};
    for (const key of ["name", "publisher", "publisherDisplayName"]) {
      if (typeof test[key] !== "string" || test[key].trim() === "") {
        throw new Error(`identity.json testIdentity.${key} must be a non-empty string`);
      }
    }
    return { ...test, kind: "test" };
  }
  if (kind === "partner-center") {
    const partner = file.partnerCenter ?? {};
    const missing = ["name", "publisher", "publisherDisplayName"].filter(
      (key) => typeof partner[key] !== "string" || partner[key].trim() === "",
    );
    if (missing.length > 0) {
      throw new Error(
        `identity.json partnerCenter is incomplete (${missing.join(", ")}): reserve the name in Partner Center and paste the identity. ` +
          "A package built from a guessed identity is rejected at ingestion, so this script builds nothing instead.",
      );
    }
    return { ...partner, kind: "partner-center" };
  }
  throw new Error(`unknown identity "${kind}" (expected test or partner-center)`);
}

/** A PNG's real size, read from the IHDR chunk rather than trusted from the name. */
export function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${file} is not a PNG`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Stage the package layout and render the manifest.
 * Exported so `check:msix` measures exactly what `msix:package` ships.
 */
export function stage(identity, options = {}) {
  const version = productVersion();
  const layout = options.layout ?? join(ROOT, "target", "release", "bundle", "msix", "layout");
  rmSync(layout, { recursive: true, force: true });
  mkdirSync(join(layout, "Assets"), { recursive: true });

  if (!existsSync(BINARY)) {
    throw new Error(`${BINARY} does not exist: run "npm run tauri build" first`);
  }
  cpSync(BINARY, join(layout, "Zenith.exe"));

  const assets = [];
  for (const asset of REQUIRED_ASSETS) {
    const source = join(ICONS, asset.file);
    if (!existsSync(source)) throw new Error(`missing tile asset ${source}`);
    const size = pngSize(source);
    if (size.width !== asset.width || size.height !== asset.height) {
      throw new Error(
        `${asset.file} is ${size.width}x${size.height}; the manifest and the Store require ${asset.width}x${asset.height}`,
      );
    }
    cpSync(source, join(layout, "Assets", asset.file));
    assets.push({ ...asset, bytes: statSync(source).size });
  }

  const replacements = {
    IDENTITY_NAME: identity.name,
    PUBLISHER: identity.publisher,
    PUBLISHER_DISPLAY_NAME: identity.publisherDisplayName,
    VERSION_4_PART: fourPartVersion(version),
  };
  let manifest = readFileSync(TEMPLATE, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    manifest = manifest.split(`{{${key}}}`).join(value);
  }
  const leftover = manifest.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (leftover) throw new Error(`unreplaced manifest placeholders: ${leftover.join(", ")}`);
  writeFileSync(join(layout, "AppxManifest.xml"), manifest);

  return { layout, manifest, assets, version, identity };
}

function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
  };
  const kind = value("identity", "test");
  let identity;
  try {
    identity = readIdentity(kind);
  } catch (error) {
    fail(error.message);
  }
  const suffix = identity.kind === "test" ? "_test" : "";
  const out = resolve(
    value("out", join(ROOT, "target", "release", "bundle", "msix", `Zenith_${productVersion()}_x64${suffix}.msix`)),
  );

  let staged;
  try {
    staged = stage(identity);
  } catch (error) {
    fail(error.message);
  }
  mkdirSync(dirname(out), { recursive: true });

  console.log(`identity:   ${identity.name}`);
  console.log(`publisher:  ${identity.publisher}`);
  console.log(`version:    ${staged.version} -> ${fourPartVersion(staged.version)}`);
  console.log(`binary:     ${statSync(join(staged.layout, "Zenith.exe")).size} bytes`);
  for (const asset of staged.assets) {
    console.log(`asset:      Assets/${asset.file}  ${asset.width}x${asset.height}  ${asset.bytes} bytes`);
  }

  if (args.includes("--no-pack")) {
    console.log(`staged:     ${staged.layout}`);
    return;
  }

  const tool = makeappx();
  if (!tool) {
    fail(
      "makeappx.exe was not found. Install the Windows SDK (App packaging tools), or set MAKEAPPX to its full path.",
    );
  }
  const pack = spawnSync(tool, ["pack", "/d", staged.layout, "/p", out, "/o"], { encoding: "utf8" });
  const output = `${pack.stdout ?? ""}${pack.stderr ?? ""}`.trim();
  if (output) console.log(output);
  if (pack.status !== 0) fail(`makeappx pack failed with exit ${pack.status}`);

  const bytes = statSync(out).size;
  console.log(`package:    ${out}  ${bytes} bytes`);
  console.log(
    identity.kind === "test"
      ? "This is a LOCAL TEST package. It is not submittable: the Store identity is not reserved (docs/11-release/11-03-store-checklist.md M-02)."
      : "Package built with the reserved Partner Center identity.",
  );
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === resolve(fileURLToPath(import.meta.url))) {
  main();
}
