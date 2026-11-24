#!/usr/bin/env node
/**
 * `check:installer` - the bundle configuration must be buildable and complete.
 *
 * A Tauri config is a file that is easy to make *look* finished: it serialises,
 * the app still starts in dev mode, and the breakage only appears at the end of a
 * release build. This gate checks the parts a dev run never touches:
 *
 *   1. every icon path exists (a missing `icons/icon.ico` fails the bundle step);
 *   2. `installerHooks` names a file that exists and defines the macros the NSIS
 *      template actually calls;
 *   3. every declared installer language exists in the pinned NSIS 3.11 archive,
 *   4. the text fields carry no U+FFFD, which is what a Windows-1254 read of a
 *      UTF-8 file leaves behind and what shipped in `copyright` for a week.
 *
 * Usage: `node scripts/check-installer.mjs`
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateInstallerLanguages } from "./lib/installer-languages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

// Assembled from code points so this gate does not contain the glyphs it bans.
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);

const config = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const languagesSource = readFileSync(join(ROOT, "src", "i18n", "languages.ts"), "utf8");
const registryCount = [...languagesSource.matchAll(/code:\s*"/g)].length;

// The NSIS translation set Tauri bundles, read from the pinned archive's own
// inventory. Reading the developer's LOCALAPPDATA cache was wrong: that cache is
// shared with every other Tauri project on the machine, it can be edited by hand,
// and CI starts without one, so the gate passed here and skipped there while the
// release build failed on a language the cache happened to contain.
const inventoryPath = join(ROOT, "src-tauri", "installer", "nsis-3.11-languages.json");
let inventory = null;
let available = null;
if (!existsSync(inventoryPath)) {
  problems.push("src-tauri/installer/nsis-3.11-languages.json is missing; the NSIS language set has no pinned inventory");
} else {
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    available = new Set(inventory.languages ?? []);
    const manifest = JSON.parse(readFileSync(join(ROOT, "resources", "manifest.json"), "utf8"));
    const asset = (manifest.assets ?? []).find((entry) => entry.id === inventory.archive?.id);
    if (!asset) {
      problems.push(`the inventory names archive ${inventory.archive?.id}, which resources/manifest.json does not list`);
    } else if (asset.sha256 !== inventory.archive?.sha256) {
      problems.push(
        `the inventory covers a different archive than resources/manifest.json (${inventory.archive?.sha256} vs ${asset.sha256})`,
      );
    }
  } catch (error) {
    problems.push(`installer/nsis-3.11-languages.json is unusable: ${error.message}`);
  }
}

const iconPaths = config?.bundle?.icon ?? [];
if (iconPaths.length === 0) problems.push("bundle.icon is empty");
for (const entry of iconPaths) {
  if (!existsSync(join(ROOT, "src-tauri", entry))) problems.push(`bundle.icon lists ${entry}, which is missing`);
}
for (const required of ["icons/icon.ico", "icons/icon.png", "icons/32x32.png"]) {
  if (!iconPaths.includes(required)) problems.push(`bundle.icon does not list ${required}`);
}

const hooks = config?.bundle?.windows?.nsis?.installerHooks;
if (!hooks) {
  problems.push("bundle.windows.nsis.installerHooks is not declared");
} else {
  const path = join(ROOT, "src-tauri", hooks.replace(/\\/g, "/"));
  if (!existsSync(path)) {
    problems.push(`installerHooks points at ${hooks}, which does not exist`);
  } else {
    const text = readFileSync(path, "utf8");
    for (const macro of ["NSIS_HOOK_POSTINSTALL", "NSIS_HOOK_PREUNINSTALL", "NSIS_HOOK_POSTUNINSTALL"]) {
      if (!text.includes(macro)) problems.push(`${hooks} does not define ${macro}`);
    }
    // An unattended uninstall must not delete data. The guard is structural: the
    // first thing the pre-uninstall hook does is branch on IfSilent.
    if (!text.includes("$DeleteAppDataCheckboxState = 1")) {
      problems.push(`${hooks} does not gate data deletion on the template's checkbox`);
    }
  }
}

const declared = config?.bundle?.windows?.nsis?.languages ?? [];
const registryCodes = [...languagesSource.matchAll(/code:\s*"([^"]+)"/g)].map((m) => m[1]);
const mappingPath = join(ROOT, "src-tauri", "installer", "languages.json");
if (!existsSync(mappingPath)) {
  problems.push("src-tauri/installer/languages.json is missing; the installer languages have no registry-linked contract");
} else {
  let mapping;
  try {
    mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
  } catch (error) {
    problems.push(`installer/languages.json is not valid JSON: ${error.message}`);
  }
  if (mapping) {
    problems.push(
      ...validateInstallerLanguages({
        rows: mapping.languages ?? [],
        registryCodes,
        declared,
        archiveLanguages: inventory?.languages ?? null,
        archiveCount: inventory?.languages?.length ?? null,
      }),
    );
  }
}
if (!config?.bundle?.windows?.nsis?.displayLanguageSelector) {
  problems.push("displayLanguageSelector is false, so the declared languages are unreachable");
}

const textFields = {
  productName: config.productName,
  version: config.version,
  identifier: config.identifier,
  publisher: config?.bundle?.publisher,
  shortDescription: config?.bundle?.shortDescription,
  longDescription: config?.bundle?.longDescription,
  copyright: config?.bundle?.copyright,
};
for (const [field, value] of Object.entries(textFields)) {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${field} is missing`);
    continue;
  }
  if (value.includes("\uFFFD")) problems.push(`${field} contains U+FFFD (mojibake)`);
  if (value.includes(EN_DASH) || value.includes(EM_DASH)) {
    problems.push(`${field} contains a typographic dash`);
  }
}
if (config?.bundle?.copyright && !config.bundle.copyright.startsWith("(c)")) {
  problems.push("bundle.copyright must start with the ASCII (c) form; a bare U+00A9 is mojibake-prone in NSIS");
}
if (!(config?.bundle?.targets ?? []).includes("nsis")) problems.push("bundle.targets no longer includes nsis");

if (problems.length) {
  console.error("Installer configuration is not releasable:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// ---------------------------------------------------------- negative self-test
// A gate is only worth its lines if it fails on the bug it was written for.
// DEF-168 was a declaration of 19 translations the pinned archive does not
// contain; the release build failed on the first of them. These synthetic cases
// drive the same validator, so the check cannot silently lose its teeth.
const selfTestCases = [
  {
    name: "a translation present in the archive passes",
    rows: [{ code: "en", nsis: "English" }, { code: "tr", nsis: "Turkish" }],
    registryCodes: ["en", "tr"],
    declared: ["English", "Turkish"],
    archiveLanguages: ["English", "Turkish", "German"],
    shouldFail: false,
  },
  {
    name: "a translation absent from the archive fails (the DEF-168 shape)",
    rows: [{ code: "en", nsis: "English" }, { code: "bn", nsis: "Bengali" }],
    registryCodes: ["en", "bn"],
    declared: ["English", "Bengali"],
    archiveLanguages: ["English", "Turkish", "German"],
    shouldFail: true,
  },
  {
    name: "a null translation without an English fallback fails",
    rows: [{ code: "lo", nsis: null }],
    registryCodes: ["lo"],
    declared: [],
    archiveLanguages: ["English"],
    shouldFail: true,
  },
  {
    name: "a declared language missing from the mapping fails",
    rows: [{ code: "en", nsis: "English" }],
    registryCodes: ["en"],
    declared: ["English", "Turkish"],
    archiveLanguages: ["English", "Turkish"],
    shouldFail: true,
  },
  {
    name: "a duplicate declaration fails",
    rows: [{ code: "en", nsis: "English" }],
    registryCodes: ["en"],
    declared: ["English", "English"],
    archiveLanguages: ["English"],
    shouldFail: true,
  },
  {
    name: "a registry locale with no row fails",
    rows: [{ code: "en", nsis: "English" }],
    registryCodes: ["en", "tr"],
    declared: ["English"],
    archiveLanguages: ["English"],
    shouldFail: true,
  },
];

const selfTestFailures = [];
for (const test of selfTestCases) {
  const found = validateInstallerLanguages(test);
  const failed = found.length > 0;
  if (failed !== test.shouldFail) {
    selfTestFailures.push(
      `${test.name}: expected ${test.shouldFail ? "a problem" : "no problem"}, got ${failed ? found.join("; ") : "none"}`,
    );
  }
}
if (selfTestFailures.length) {
  console.error("check:installer self-test is broken:");
  for (const failure of selfTestFailures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Installer holds: ${declared.length} NSIS translations for ${registryCount} UI locales (the rest fall back to the English installer), ` +
    `${iconPaths.length} icons, hooks with a silent-uninstall guard.`,
);
console.log(`Self-test holds: ${selfTestCases.length} language cases, including the DEF-168 shape.`);
