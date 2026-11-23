/**
 * Generates a CycloneDX 1.5 SBOM for the shipped Windows x64 graph (DEF-051).
 *
 * Why generated and not checked in by hand:
 *
 *   * `04-01` §9 promises a CycloneDX SBOM per release. A hand-written one is
 *     a screenshot of a dependency tree, not a claim about *this* build.
 *   * Every hash below comes from a lockfile - `Cargo.lock` `checksum` for
 *     crates, `package-lock.json` `integrity` for npm. Nothing is invented:
 *     when a source carries no hash, the component is emitted without a hash
 *     entry rather than with a placeholder.
 *   * Output is byte-stable (no timestamp, deterministic serial number) so
 *     `check:sbom` can diff it the way `check:licenses` diffs the notices.
 *
 * The component set is deliberately identical to the licence notice set:
 * Windows x64 reachable crates + the production npm graph. Dev tooling ships
 * nowhere, so it is not in the SBOM either.
 *
 * Usage: node scripts/generate-sbom.mjs
 *        node scripts/generate-sbom.mjs --check   (stale = exit 1)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "resources", "sbom");
const OUT_PATH = join(OUT_DIR, "zenith-1.0.0.cdx.json");
const TARGET = "x86_64-pc-windows-msvc";
const BOM_FORMAT = "CycloneDX";
const SPEC_VERSION = "1.5";

const CHECK = process.argv.includes("--check");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Parses `Cargo.lock` into name@version -> { checksum, source }. */
function readCargoLock() {
  const text = readFileSync(join(ROOT, "Cargo.lock"), "utf8");
  const entries = new Map();
  for (const block of text.split("[[package]]").slice(1)) {
    const field = (name) => block.match(new RegExp(`^${name} = "([^"]*)"`, "m"))?.[1] ?? null;
    const name = field("name");
    const version = field("version");
    if (!name || !version) continue;
    entries.set(`${name}@${version}`, { checksum: field("checksum"), source: field("source") });
  }
  return entries;
}

/** Windows x64 reachable crates, joined to their lockfile checksum. */
function cargoComponents() {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1", "--filter-platform", TARGET],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 30 },
    ),
  );
  const lock = readCargoLock();
  const members = new Set(meta.workspace_members);
  const byId = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
  const reachable = meta.resolve?.nodes?.map((node) => node.id) ?? [];

  return reachable
    .map((id) => byId.get(id))
    .filter((pkg) => pkg && !members.has(pkg.id))
    .map((pkg) => {
      const entry = lock.get(`${pkg.name}@${pkg.version}`);
      return {
        ecosystem: "cargo",
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? null,
        description: pkg.description ?? null,
        repository: pkg.repository ?? null,
        hashes: entry?.checksum ? [{ alg: "SHA-256", content: entry.checksum }] : [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Production npm packages, with the lockfile's SRI integrity as a hash. */
function npmComponents() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const packages = lock.packages ?? {};

  const resolveKey = (fromKey, name) => {
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

  // Walk `dependencies` only: devDependencies never reach the installer.
  const seen = new Set();
  const queue = Object.keys(pkg.dependencies ?? {}).map((name) => `node_modules/${name}`);
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
      const name = entry.name ?? key.replace(/^.*node_modules\//, "");
      const integrity = entry.integrity ?? "";
      // SRI is `<alg>-<base64>`. CycloneDX wants hex; convert rather than store
      // a base64 string under a hex field.
      const match = integrity.match(/^(sha256|sha384|sha512)-(.+)$/);
      let hashes = [];
      if (match) {
        const alg = match[1].toUpperCase().replace("SHA", "SHA-");
        hashes = [{ alg, content: Buffer.from(match[2], "base64").toString("hex") }];
      }
      return {
        ecosystem: "npm",
        name,
        version: entry.version ?? "unknown",
        license: entry.license ?? null,
        description: null,
        repository: null,
        hashes,
      };
    });
}

/** Deterministic UUID from the component list: same graph, same serial. */
function serialNumber(seed) {
  const hex = sha256(seed);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

function purl(component) {
  if (component.ecosystem === "cargo") {
    return `pkg:cargo/${component.name}@${component.version}`;
  }
  // Scoped npm names must percent-encode the `@` and `/` inside the name.
  const encoded = component.name.replace(/^@/, "%40").replace("/", "%2F");
  return `pkg:npm/${encoded}@${component.version}`;
}

function build() {
  const components = [...cargoComponents(), ...npmComponents()];
  const app = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  const bomComponents = components.map((component) => {
    const entry = {
      type: "library",
      "bom-ref": purl(component),
      name: component.name,
      version: component.version,
      purl: purl(component),
    };
    if (component.description) entry.description = component.description;
    if (component.license) entry.licenses = [{ license: { id: component.license } }];
    if (component.hashes.length > 0) entry.hashes = component.hashes;
    if (component.repository) {
      entry.externalReferences = [{ type: "vcs", url: component.repository }];
    }
    return entry;
  });

  const withoutHash = components.filter((c) => c.hashes.length === 0).length;

  const bom = {
    bomFormat: BOM_FORMAT,
    specVersion: SPEC_VERSION,
    serialNumber: serialNumber(
      components.map((c) => `${c.ecosystem}:${c.name}@${c.version}:${c.hashes[0]?.content ?? ""}`).join("\n"),
    ),
    version: 1,
    metadata: {
      // No `timestamp`: a clock reading would make every regeneration a diff
      // and turn a reproducibility gate into a formality (see header).
      tools: [{ vendor: "Vellium", name: "scripts/generate-sbom.mjs", version: "1" }],
      component: {
        type: "application",
        "bom-ref": `pkg:cargo/zenith@${app.version}`,
        name: "zenith",
        version: app.version,
        purl: `pkg:cargo/zenith@${app.version}`,
        licenses: [{ license: { id: "MIT" } }],
      },
    },
    components: bomComponents,
    dependencies: [
      {
        ref: `pkg:cargo/zenith@${app.version}`,
        dependsOn: bomComponents.map((component) => component["bom-ref"]),
      },
    ],
  };

  return { bom, components, withoutHash };
}

function main() {
  const { bom, components, withoutHash } = build();
  const text = `${JSON.stringify(bom, null, 2)}\n`;
  const summary =
    `${components.length} components ` +
    `(${components.filter((c) => c.ecosystem === "cargo").length} cargo, ` +
    `${components.filter((c) => c.ecosystem === "npm").length} npm), ` +
    `${components.length - withoutHash} with a lockfile hash`;

  if (CHECK) {
    if (!existsSync(OUT_PATH)) {
      console.error("SBOM is missing: resources/sbom/zenith-1.0.0.cdx.json");
      console.error("Run: npm run sbom:generate");
      process.exit(1);
    }
    if (readFileSync(OUT_PATH, "utf8") !== text) {
      console.error("SBOM is stale; the lockfiles or the graph moved.");
      console.error("Run: npm run sbom:generate");
      process.exit(1);
    }
    console.log(`SBOM is current: ${summary}.`);
    return;
  }

  // A component with no hash is not a failure - some sources carry none - but
  // it must never be silently indistinguishable from a verified one.
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, text, "utf8");
  console.log(`Wrote ${relative(ROOT, OUT_PATH)} (${Buffer.byteLength(text)} B): ${summary}.`);
  if (withoutHash > 0) {
    console.log(`Components without a lockfile hash: ${withoutHash} (emitted with no hash, not a fake one).`);
  }
}

main();
