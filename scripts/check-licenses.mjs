/**
 * Gate for DEF-056: the shipped third-party notices exist, are current, and
 * cover every redistributed component.
 *
 * This does not regenerate anything. It compares the committed artefacts with
 * the lockfiles and with their own manifest, so a dependency bump that forgot
 * `npm run licenses:generate` fails here instead of shipping a stale notice.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "resources", "licenses");
const NOTICES = join(DIR, "THIRD-PARTY-NOTICES.txt");
const MANIFEST = join(DIR, "manifest.json");

const problems = [];

function sha256(path) {
  return createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
}

if (!existsSync(NOTICES)) problems.push("THIRD-PARTY-NOTICES.txt is missing");
if (!existsSync(MANIFEST)) problems.push("manifest.json is missing");

let manifest = null;
let notices = "";
if (problems.length === 0) {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  notices = readFileSync(NOTICES, "utf8");
}

if (manifest) {
  if (Buffer.byteLength(notices) < 50_000) {
    problems.push(`notices are suspiciously small (${Buffer.byteLength(notices)} B)`);
  }
  if (sha256("resources/licenses/" + manifest.notices) !== manifest.noticesSha256) {
    problems.push("manifest.noticesSha256 does not match the file on disk");
  }

  for (const [path, expected] of Object.entries(manifest.sources ?? {})) {
    if (!existsSync(join(ROOT, path))) {
      problems.push(`source ${path} is missing`);
    } else if (sha256(path) !== expected) {
      problems.push(`${path} changed since the notices were generated - run npm run licenses:generate`);
    }
  }

  const components = manifest.components ?? [];
  if (components.length !== manifest.counts?.components) {
    problems.push("counts.components disagrees with the component list");
  }
  const ecosystems = new Set(components.map((component) => component.ecosystem));
  if (!ecosystems.has("cargo")) problems.push("no Rust crates listed");
  if (!ecosystems.has("npm")) problems.push("no npm packages listed");

  const listedIds = new Set(manifest.licenceIds ?? []);
  const textIds = new Set((manifest.texts ?? []).flatMap((text) => text.ids ?? []));
  for (const id of listedIds) {
    if (!textIds.has(id)) problems.push(`no licence text covers ${id}`);
  }
  if ((manifest.missingText ?? []).length > 0) {
    problems.push(`uncovered licence ids: ${manifest.missingText.join(", ")}`);
  }

  for (const component of components) {
    const label = `${component.name} ${component.version}`;
    if (!component.name || !component.version) problems.push("a component has no name or version");
    if (!component.license || component.license === "unknown") {
      problems.push(`${label} has no declared licence`);
    }
    if (!notices.includes(label)) problems.push(`${label} is missing from the notice file`);
    for (const id of splitIds(component.license)) {
      if (!listedIds.has(id)) problems.push(`${label} declares ${id}, which is not in licenceIds`);
    }
  }
}

/** Same SPDX split as the generator, kept small and independent of it. */
function splitIds(expression) {
  const raw = expression.match(/Apache-2\.0 WITH LLVM-exception|[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
  return [
    ...new Set(raw.filter((token) => !["AND", "OR", "WITH"].includes(token.toUpperCase()))),
  ];
}

if (problems.length > 0) {
  console.error("Third-party notices gate failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Third-party notices hold: ${manifest.counts.components} components ` +
    `(${manifest.counts.cargo} cargo, ${manifest.counts.npm} npm), ` +
    `${manifest.counts.licenceTexts} licence texts, ` +
    `${manifest.licenceIds.length} SPDX ids, ${manifest.noticesSha256.slice(0, 12)}…`,
);
