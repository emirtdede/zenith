#!/usr/bin/env node
/**
 * `check:msix` - the Store package must contain what the manifest promises.
 *
 * The packaging script can succeed while producing something Windows will not
 * install: a stale binary, a tile asset at the wrong pixel size, a manifest whose
 * version drifted from `tauri.conf.json`, or a layout that references an asset it
 * never copied. `makeappx pack` validates the manifest schema but not any of
 * those, so this gate re-opens the package it just built and checks the contents.
 *
 * It unpacks with `makeappx unpack`, which is the SDK's own reader: an archive
 * this project could open but Windows could not is not evidence.
 *
 * Usage: node scripts/check-msix.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BINARY,
  ICONS,
  REQUIRED_ASSETS,
  fourPartVersion,
  makeappx,
  pngSize,
  productVersion,
  readIdentity,
  ROOT,
} from "./pack-msix.mjs";

const problems = [];
const checks = [];

function check(label, condition, detail = "") {
  checks.push({ label, ok: Boolean(condition), detail });
  if (!condition) problems.push(`${label}${detail ? ` - ${detail}` : ""}`);
}

// 1. Identity file: both blocks exist, and the partner block is either complete
//    or explicitly empty. A half-filled identity is the state that ships a
//    package Microsoft rejects at ingestion.
const identityFile = JSON.parse(readFileSync(join(ROOT, "src-tauri", "msix", "identity.json"), "utf8"));
check("identity.json has a test identity", Boolean(identityFile.testIdentity));
check("identity.json has a partnerCenter block", Boolean(identityFile.partnerCenter));
const partnerFields = ["name", "publisher", "publisherDisplayName"];
const partnerFilled = partnerFields.filter((key) => typeof identityFile.partnerCenter?.[key] === "string");
check(
  "partnerCenter block is either complete or empty",
  partnerFilled.length === 0 || partnerFilled.length === partnerFields.length,
  `filled: ${partnerFilled.join(", ") || "none"}`,
);
let testIdentity = null;
try {
  testIdentity = readIdentity("test");
  check("the test identity resolves", true, testIdentity.name);
} catch (error) {
  check("the test identity resolves", false, error.message);
}

// 2. Version agreement, in the four-part form MSIX requires.
const version = productVersion();
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const cargo = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
const cargoVersion = (cargo.match(/^version\s*=\s*"([^"]+)"/m) ?? [])[1];
check("tauri.conf.json and package.json agree on the version", version === packageJson.version, `${version} vs ${packageJson.version}`);
check("tauri.conf.json and Cargo.toml agree on the version", version === cargoVersion, `${version} vs ${cargoVersion}`);
let manifestVersion = null;
try {
  manifestVersion = fourPartVersion(version);
  check("the version converts to four parts", true, manifestVersion);
} catch (error) {
  check("the version converts to four parts", false, error.message);
}

// 3. Tile assets, measured from the pixels rather than from the file name.
for (const asset of REQUIRED_ASSETS) {
  const file = join(ICONS, asset.file);
  if (!existsSync(file)) {
    check(`tile ${asset.file} exists`, false);
    continue;
  }
  const size = pngSize(file);
  check(
    `tile ${asset.file} is ${asset.width}x${asset.height}`,
    size.width === asset.width && size.height === asset.height,
    `measured ${size.width}x${size.height}`,
  );
}

// 4. The binary the package would carry.
check("the release binary exists", existsSync(BINARY), BINARY);
if (existsSync(BINARY)) {
  check("the release binary is not a debug build path", BINARY.endsWith("release\\zenith.exe"), BINARY);
  check("the release binary is larger than 1 MiB", statSync(BINARY).size > 1_048_576, `${statSync(BINARY).size} bytes`);
}

// 5. Build the package and open it again with the SDK reader.
let packed = null;
if (problems.length === 0) {
  const tool = makeappx();
  check("makeappx is available", Boolean(tool), tool ?? "not found on PATH or in the Windows SDK");
  if (tool) {
    const work = mkdtempSync(join(tmpdir(), "zenith-msix-"));
    const out = join(work, `Zenith_${version}_x64_check.msix`);
    const pack = spawnSync(process.execPath, [join(ROOT, "scripts", "pack-msix.mjs"), "--out", out], {
      encoding: "utf8",
    });
    check("pack-msix.mjs exits 0", pack.status === 0, `${pack.status}`);
    if (pack.status === 0 && existsSync(out)) {
      packed = { out, bytes: statSync(out).size };
      check("the package is larger than 1 MiB", packed.bytes > 1_048_576, `${packed.bytes} bytes`);

      const unpacked = join(work, "unpacked");
      const unpack = spawnSync(tool, ["unpack", "/p", out, "/d", unpacked, "/o"], { encoding: "utf8" });
      check("makeappx unpacks the package", unpack.status === 0, `${unpack.status}`);
      if (unpack.status === 0) {
        const expected = [
          "AppxManifest.xml",
          "Zenith.exe",
          ...REQUIRED_ASSETS.map((asset) => join("Assets", asset.file)),
        ];
        for (const path of expected) {
          check(`package contains ${path.replace(/\\/g, "/")}`, existsSync(join(unpacked, path)));
        }
        const entries = readdirSync(unpacked, { withFileTypes: true });
        check(
          "the package root holds only the manifest, block map, binary, and Assets",
          entries.every((entry) =>
            ["AppxManifest.xml", "AppxBlockMap.xml", "Zenith.exe", "Assets"].includes(entry.name),
          ),
          entries.map((entry) => entry.name).join(", "),
        );
        // makeappx writes this itself; a package without it cannot be ingested.
        check("makeappx wrote the block map", existsSync(join(unpacked, "AppxBlockMap.xml")));

        const manifest = readFileSync(join(unpacked, "AppxManifest.xml"), "utf8");
        check("the manifest declares runFullTrust", manifest.includes('Name="runFullTrust"'));
        check("the application is a full-trust desktop entry point", manifest.includes("Windows.FullTrustApplication"));
        check("the manifest carries the four-part version", manifest.includes(`Version="${manifestVersion}"`), manifestVersion);
        check("the manifest carries the packaged identity", testIdentity ? manifest.includes(`Name="${testIdentity.name}"`) : false);
        check("the manifest targets Windows.Desktop", manifest.includes('Name="Windows.Desktop"'));
        check("the manifest requires Windows 10 1809 or newer", manifest.includes('MinVersion="10.0.17763.0"'));
        check("the manifest declares no capability beyond runFullTrust", (manifest.match(/<rescap:Capability /g) ?? []).length === 1);
        check("no manifest placeholder survived", !/\{\{[A-Z0-9_]+\}\}/.test(manifest));
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

for (const entry of checks) {
  console.log(`${entry.ok ? "ok  " : "FAIL"}  ${entry.label}${entry.detail ? `  (${entry.detail})` : ""}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s): the Store package does not match its manifest.`);
  process.exit(1);
}
console.log(
  `\nMSIX package holds: ${checks.length} checks, ${REQUIRED_ASSETS.length} tiles, version ${manifestVersion}, identity ${testIdentity?.name}.`,
);
if (packed) console.log(`Built and unpacked a ${packed.bytes}-byte local test package.`);
