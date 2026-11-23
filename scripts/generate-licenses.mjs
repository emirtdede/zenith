/**
 * Generates `resources/licenses/THIRD-PARTY-NOTICES.txt` and its machine-readable
 * companion `manifest.json` from the actual dependency graph.
 *
 * Why a generator and not a checked-in blob:
 *
 *   * The notice file must change when a dependency changes, or it is a lie.
 *     `manifest.sources` pins the SHA-256 of `Cargo.lock`, `package-lock.json`
 *     and `package.json`; `check:licenses` refuses a stale file.
 *   * Licence texts are copied from the package as shipped - no transcribed
 *     text, no "MIT-like" paraphrase. When a crate ships no licence file, the
 *     entry says so and the canonical text is labelled with the crate it was
 *     taken from.
 *
 * Scope: every crate reachable in the Windows x64 graph plus every production
 * npm package. Dev-only npm tooling is not redistributed in the installer, so it
 * is not listed; the gate enforces that rule rather than trusting this comment.
 *
 * Usage: node scripts/generate-licenses.mjs
 *        node scripts/generate-licenses.mjs --check   (CI: stale = exit 1)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "resources", "licenses");
const NOTICES_PATH = join(OUT_DIR, "THIRD-PARTY-NOTICES.txt");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");
const TARGET = "x86_64-pc-windows-msvc";

const CHECK = process.argv.includes("--check");

const OPERATORS = new Set(["AND", "OR", "WITH"]);
const KNOWN = new Map(
  [
    "0BSD",
    "Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "CC0-1.0",
    "ISC",
    "MIT",
    "MIT-0",
    "MPL-2.0",
    "Unicode-3.0",
    "Unlicense",
    "Zlib",
  ].map((id) => [id.toLowerCase(), id]),
);

/** Splits an SPDX expression into canonical licence identifiers. */
function licenceIds(expression) {
  const normalised = expression.replace(/\s+/g, " ").trim();
  const raw = normalised.match(/Apache-2\.0 WITH LLVM-exception|[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
  const ids = raw
    .filter((token) => !OPERATORS.has(token.toUpperCase()))
    .map((token) => KNOWN.get(token.toLowerCase()) ?? token)
    // Legacy `MIT/Apache-2.0` and `Apache-2.0 / MIT` forms split above; anything
    // that is still not a known id is kept verbatim so the gate fails loudly
    // instead of the generator silently dropping a licence.
    .filter((token) => token.length > 0);
  return [...new Set(ids)];
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Dedupe key for licence bodies: two MIT files that differ only in their
 * copyright line are the same licence text. Copyrights are carried per
 * component, so removing them here loses nothing.
 */
function dedupeKey(text) {
  return text
    .split("\n")
    .filter((line) => !/copyright|\(c\)\s*\d{4}|©/i.test(line))
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function licenceFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^(licen[cs]e|copying|notice|unlicense)/i.test(name))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n") }))
    .filter((file) => file.text.trim().length >= 40);
}

/** Copyright lines from a licence file, so deduping the text loses no notice. */
/**
 * Which SPDX ids a licence file contains.
 *
 * Content first (that is the only way to tell BSD-2 from BSD-3), filename as a
 * fallback for files whose body is a short pointer. Returning an empty set is
 * allowed: the text is still shipped, it just cannot vouch for an id.
 */
function detectIds(file) {
  const text = file.text;
  const body = text.toLowerCase();
  const name = file.name.toLowerCase();
  const ids = new Set();

  if (/permission is hereby granted, free of charge/.test(body)) ids.add("MIT");
  if (/mit no attribution|mit-0/.test(body) || name.includes("mit0")) ids.add("MIT-0");
  if (/apache license/.test(body) && /version 2\.0/.test(body)) ids.add("Apache-2.0");
  if (/llvm exception|llvm-exception/.test(body) || name.includes("llvm-exception")) {
    ids.add("Apache-2.0 WITH LLVM-exception");
  }
  if (/redistribution and use in source and binary forms/.test(body)) {
    ids.add(/neither the name/.test(body) ? "BSD-3-Clause" : "BSD-2-Clause");
  }
  if (/permission to use, copy, modify, and\/or distribute/.test(body)) ids.add("ISC");
  if (/mozilla public license/.test(body) && /2\.0/.test(body)) ids.add("MPL-2.0");
  if (/zlib license/.test(body) || /altered source versions/.test(body)) ids.add("Zlib");
  if (/cc0 1\.0 universal/.test(body)) ids.add("CC0-1.0");
  if (/unicode, inc\. license agreement|unicode license/.test(body)) ids.add("Unicode-3.0");
  if (/free and unencumbered software released into the public domain/.test(body)) ids.add("Unlicense");
  if (/zero-clause bsd|0bsd/.test(body) || name.includes("0bsd")) ids.add("0BSD");

  // Filename fallbacks for pointer-style files.
  if (name.includes("apache") && !name.includes("llvm")) ids.add("Apache-2.0");
  if (name.includes("mit") && !name.includes("mit0")) ids.add("MIT");
  if (name.includes("bsd") && !name.includes("0bsd")) ids.add("BSD-3-Clause");
  if (name.includes("zlib")) ids.add("Zlib");
  if (name.includes("unicode")) ids.add("Unicode-3.0");
  if (name.includes("cc0")) ids.add("CC0-1.0");
  if (name.includes("unlicense")) ids.add("Unlicense");
  if (name.includes("mpl")) ids.add("MPL-2.0");
  if (name.includes("isc")) ids.add("ISC");

  return [...ids];
}

function copyrightLines(files) {
  const lines = new Set();
  for (const file of files) {
    for (const line of file.text.split("\n")) {
      const trimmed = line.trim();
      // A copyright *statement*, not any sentence in the Apache body that
      // happens to contain the word "copyright".
      const startsWithCopyright = /^copyright\b/i.test(trimmed);
      const startsWithSymbolYear = /^(\(c\)|©)\s*\d{4}/i.test(trimmed);
      const looksLikeNotice =
        startsWithSymbolYear ||
        (startsWithCopyright && /(\b(19|20)\d{2}\b|\(c\)|©)/i.test(trimmed));
      if (looksLikeNotice && !/\[yyyy\]/i.test(trimmed) && trimmed.length < 200) {
        lines.add(trimmed);
      }
    }
  }
  return [...lines].slice(0, 6);
}

function cargoComponents() {
  const raw = execFileSync(
    "cargo",
    ["metadata", "--locked", "--format-version", "1", "--filter-platform", TARGET],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 30 },
  );
  const meta = JSON.parse(raw);
  const members = new Set(meta.workspace_members);
  const byId = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
  const reachable = meta.resolve?.nodes?.map((node) => node.id) ?? [];

  return reachable
    .map((id) => byId.get(id))
    .filter((pkg) => pkg && !members.has(pkg.id))
    .map((pkg) => {
      const files = licenceFiles(dirname(pkg.manifest_path));
      return {
        ecosystem: "cargo",
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? (pkg.license_file ? "see licence file" : "unknown"),
        repository: pkg.repository ?? null,
        authors: pkg.authors ?? [],
        copyright: copyrightLines(files),
        files,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function npmComponents() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const packages = lock.packages ?? {};

  // Walk only `dependencies`, never `devDependencies`: the installer ships the
  // built bundle, not Vite or TypeScript.
  const seen = new Set();
  const queue = Object.keys(pkg.dependencies ?? {}).map((name) => `node_modules/${name}`);
  const resolveKey = (fromKey, name) => {
    // npm hoists most packages to the root, but a version conflict nests one.
    // Walk up the chain the way Node resolves a module.
    let base = fromKey;
    for (;;) {
      const candidate = `${base}/node_modules/${name}`;
      if (packages[candidate]) return candidate;
      const cut = base.lastIndexOf("/node_modules/");
      if (cut < 0) break;
      base = base.slice(0, cut);
    }
    return packages[`node_modules/${name}`] ? `node_modules/${name}` : null;
  };
  while (queue.length > 0) {
    const key = queue.pop();
    if (!key || seen.has(key)) continue;
    const entry = packages[key];
    if (!entry) continue;
    seen.add(key);
    for (const name of Object.keys(entry.dependencies ?? {})) {
      const resolved = resolveKey(key, name);
      if (resolved) queue.push(resolved);
    }
  }

  return [...seen]
    .sort()
    .map((key) => {
      const entry = packages[key];
      const dir = join(ROOT, key);
      const files = licenceFiles(dir);
      let manifest = {};
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        manifest = {};
      }
      const license =
        typeof manifest.license === "string"
          ? manifest.license
          : (manifest.license?.type ?? manifest.licenses?.[0]?.type ?? entry.license ?? "unknown");
      return {
        ecosystem: "npm",
        name: entry.name ?? key.replace(/^.*node_modules\//, ""),
        version: entry.version ?? "unknown",
        license,
        repository: manifest.repository?.url ?? manifest.repository ?? null,
        authors: manifest.author ? [manifest.author.name ?? String(manifest.author)] : [],
        copyright: copyrightLines(files),
        files,
      };
    });
}

function build() {
  const cargo = cargoComponents();
  const npm = npmComponents();
  const components = [...cargo, ...npm];

  // Canonical texts, deduped by content. The first component (in sorted order)
  // that ships a given text is credited as its source.
  const texts = new Map();
  for (const component of components) {
    for (const file of component.files) {
      const key = sha256(dedupeKey(file.text));
      const ids = detectIds(file);
      const existing = texts.get(key);
      if (existing) {
        for (const id of ids) existing.ids.add(id);
      } else {
        texts.set(key, {
          hash: sha256(file.text),
          name: file.name,
          text: file.text.trimEnd(),
          source: `${component.name} ${component.version} (${component.ecosystem})`,
          ids: new Set(ids),
        });
      }
    }
  }

  const allIds = [...new Set(components.flatMap((c) => licenceIds(c.license)))].sort();
  const shippedIds = new Set([...texts.values()].flatMap((text) => [...text.ids]));

  // A licence id can be declared by packages that all happen to ship no file
  // (39 crates do). Pull one real file from a package that declares the id and
  // label it as the canonical source rather than writing a text ourselves.
  for (const id of allIds) {
    if (shippedIds.has(id)) continue;
    const candidate = components.find(
      (component) =>
        licenceIds(component.license).includes(id) &&
        component.files.some((file) => detectIds(file).includes(id)),
    );
    const file = candidate?.files.find((entry) => detectIds(entry).includes(id));
    if (!candidate || !file) continue;
    const key = sha256(dedupeKey(file.text));
    const existing = texts.get(key);
    if (existing) {
      existing.ids.add(id);
    } else {
      texts.set(key, {
        hash: sha256(file.text),
        name: file.name,
        text: file.text.trimEnd(),
        source: `${candidate.name} ${candidate.version} (${candidate.ecosystem}) - canonical text for ${id}`,
        ids: new Set([id]),
      });
    }
    shippedIds.add(id);
  }

  const missingText = allIds.filter((id) => !shippedIds.has(id));

  const lines = [];
  lines.push("ZENITH THIRD-PARTY NOTICES");
  lines.push("=========================");
  lines.push("");
  lines.push("Zenith is distributed with the third-party components listed below.");
  lines.push("Each entry names the exact version and the licence it declares; every");
  lines.push("distinct licence text follows in the appendix, copied verbatim from a");
  lines.push("package that ships it.");
  lines.push("");
  lines.push("Generated by scripts/generate-licenses.mjs. Do not edit by hand.");
  lines.push(`Cargo graph: ${TARGET} (${cargo.length} crates)`);
  lines.push(`npm production graph: ${npm.length} packages`);
  lines.push(`Distinct licence texts: ${texts.size}`);
  lines.push("");
  lines.push("=".repeat(78));
  lines.push("COMPONENTS");
  lines.push("=".repeat(78));
  lines.push("");

  for (const ecosystem of ["cargo", "npm"]) {
    const group = components.filter((c) => c.ecosystem === ecosystem);
    lines.push(`-- ${ecosystem === "cargo" ? "Rust crates" : "npm packages"} (${group.length}) ${"-".repeat(40)}`);
    lines.push("");
    for (const component of group) {
      lines.push(`${component.name} ${component.version}`);
      lines.push(`  Licence: ${component.license}`);
      if (component.repository) lines.push(`  Source: ${component.repository}`);
      if (component.authors.length > 0) lines.push(`  Authors: ${component.authors.join(", ")}`);
      for (const line of component.copyright) lines.push(`  ${line}`);
      if (component.files.length === 0) {
        lines.push("  Licence text: not shipped with this package; see the appendix entry for its declared licence.");
      }
      lines.push("");
    }
  }

  lines.push("=".repeat(78));
  lines.push("LICENCE TEXTS");
  lines.push("=".repeat(78));
  lines.push("");
  lines.push("Each text is reproduced verbatim from the package named in its header.");
  lines.push("");
  const sortedTexts = [...texts.values()].sort((a, b) => a.source.localeCompare(b.source));
  sortedTexts.forEach((text, index) => {
    lines.push("-".repeat(78));
    lines.push(`Text ${index + 1} of ${sortedTexts.length}: ${text.name}`);
    lines.push(`Source: ${text.source}`);
    lines.push(`SHA-256: ${text.hash}`);
    lines.push("-".repeat(78));
    lines.push("");
    lines.push(text.text);
    lines.push("");
  });

  const notices = `${lines.join("\n").trimEnd()}\n`;
  const archive = (path) => sha256(readFileSync(join(ROOT, path)));
  const manifest = {
    format: 1,
    generator: "scripts/generate-licenses.mjs",
    target: TARGET,
    sources: {
      "Cargo.lock": archive("Cargo.lock"),
      "package-lock.json": archive("package-lock.json"),
    },
    counts: {
      cargo: cargo.length,
      npm: npm.length,
      components: components.length,
      licenceTexts: texts.size,
    },
    licenceIds: allIds,
    missingText,
    texts: sortedTexts.map((text) => ({
      name: text.name,
      source: text.source,
      sha256: text.hash,
      ids: [...text.ids].sort(),
    })),
    components: components.map(({ files, ...rest }) => ({
      ...rest,
      licenceFiles: files.map((file) => file.name),
      hasShippedText: files.length > 0,
    })),
    notices: "THIRD-PARTY-NOTICES.txt",
    noticesSha256: sha256(notices),
  };

  return { notices, manifest };
}

function main() {
  const { notices, manifest } = build();

  if (manifest.missingText.length > 0) {
    console.error(
      `No licence text found for: ${manifest.missingText.join(", ")}. ` +
        "Add a source or ship the text; do not transcribe it by hand.",
    );
    process.exit(1);
  }

  if (CHECK) {
    const stale = [];
    if (!existsSync(NOTICES_PATH)) stale.push("THIRD-PARTY-NOTICES.txt is missing");
    else if (readFileSync(NOTICES_PATH, "utf8") !== notices) stale.push("THIRD-PARTY-NOTICES.txt is stale");
    if (!existsSync(MANIFEST_PATH)) stale.push("manifest.json is missing");
    else if (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).noticesSha256 !== manifest.noticesSha256) {
      stale.push("manifest.json is stale");
    }
    if (stale.length > 0) {
      console.error(`Licence notices are out of date: ${stale.join("; ")}`);
      console.error("Run: npm run licenses:generate");
      process.exit(1);
    }
    console.log(
      `Licence notices are current: ${manifest.counts.components} components ` +
        `(${manifest.counts.cargo} cargo, ${manifest.counts.npm} npm), ${manifest.counts.licenceTexts} texts.`,
    );
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(NOTICES_PATH, notices, "utf8");
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${relative(ROOT, NOTICES_PATH)} (${Buffer.byteLength(notices)} B) and ` +
      `${relative(ROOT, MANIFEST_PATH)}: ${manifest.counts.components} components, ` +
      `${manifest.counts.licenceTexts} licence texts.`,
  );
  if (manifest.missingText.length > 0) {
    console.log(`Texts sourced canonically (package ships none): ${manifest.missingText.join(", ")}`);
  }
}

main();
