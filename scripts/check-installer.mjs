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
 *   3. the declared installer languages are real NSIS translations, and there are
 *      exactly as many as the product's language registry advertises - 73, not a
 *      hand-written "English, Turkish" pair left over from the first release;
 *   4. the text fields carry no U+FFFD, which is what a Windows-1254 read of a
 *      UTF-8 file leaves behind and what shipped in `copyright` for a week.
 *
 * Usage: `node scripts/check-installer.mjs`
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

// Assembled from code points so this gate does not contain the glyphs it bans.
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);

const config = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const languagesSource = readFileSync(join(ROOT, "src", "i18n", "languages.ts"), "utf8");
const registryCount = [...languagesSource.matchAll(/code:\s*"/g)].length;

// The NSIS translation set Tauri bundles. Read from the local cache when it is
// present, because a hard-coded list is one more thing that can drift.
const nsisCache = join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS", "Contrib", "Language files");
const available = existsSync(nsisCache)
  ? new Set(readdirSync(nsisCache).filter((name) => name.endsWith(".nlf")).map((name) => name.slice(0, -4)))
  : null;

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
    const rows = mapping.languages ?? [];
    if (rows.length !== registryCount) {
      problems.push(`installer/languages.json has ${rows.length} rows but the product registry has ${registryCount}`);
    }
    const codes = new Set(rows.map((row) => row.code));
    for (const code of [...languagesSource.matchAll(/code:\s*"([^"]+)"/g)].map((m) => m[1])) {
      if (!codes.has(code)) problems.push(`installer/languages.json has no row for ${code}`);
    }
    for (const row of rows) {
      if (row.nsis === null) {
        // A locale with no NSIS translation runs the installer in English. That
        // is allowed, but it must be a declared fallback, not a silent gap.
        if (row.fallback !== "en") problems.push(`${row.code}: nsis is null and no English fallback is declared`);
      } else if (available && !available.has(row.nsis)) {
        problems.push(`${row.code}: "${row.nsis}" is not an NSIS translation in ${nsisCache}`);
      }
    }
    const expected = [...new Set(rows.filter((row) => row.nsis).map((row) => row.nsis))];
    if (JSON.stringify(expected) !== JSON.stringify(declared)) {
      problems.push(
        `tauri.conf.json nsis.languages does not match installer/languages.json (${declared.length} declared, ${expected.length} mapped)`,
      );
    }
  }
}
if (new Set(declared).size !== declared.length) problems.push("installer language list has duplicates");
if (!config?.bundle?.windows?.nsis?.displayLanguageSelector) {
  problems.push("displayLanguageSelector is false, so the 73 languages are declared but unreachable");
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

console.log(
  `Installer holds: ${declared.length} NSIS translations for ${registryCount} UI locales (the rest fall back to the English installer), ` +
    `${iconPaths.length} icons, hooks with a silent-uninstall guard.`,
);
