#!/usr/bin/env node
/**
 * Self-contained-bundle gate (DEF-155).
 *
 * The defect this exists to catch: `src-tauri/Cargo.toml` had no
 * `custom-protocol` feature. Tauri builds two shapes from one crate - one that
 * loads `devUrl` from a running Vite server, and one that serves the embedded
 * `frontendDist` through the `tauri://` protocol - and the choice is a cargo
 * feature. Without it, `cargo build --release` compiled cleanly, linked a
 * release binary, and that binary opened a window pointed at
 * `http://localhost:1420`. Shipped as-is it shows the browser's "connection
 * refused" page.
 *
 * Three gates were green while this was true, because none of them ran the
 * binary and looked at what it rendered:
 *   * `npm run build` (tsc + vite) produced `dist/` correctly;
 *   * `cargo test --workspace` passed, since the feature does not affect logic;
 *   * the screenshot sweep reported screens, because it was run against a stale
 *     binary that predated the regression.
 *
 * So this gate measures the feature resolution rather than trusting the
 * manifest: `cargo tree` is asked which `tauri` features are enabled for the
 * release package. A declaration that is present but not wired into `default`
 * fails here, which is the half-fix that would otherwise look correct.
 *
 * Exit codes: 0 pass, 1 fail.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

// ---------------------------------------------------------------- manifest ---
const manifestPath = join(ROOT, "src-tauri", "Cargo.toml");
let manifest = "";
try {
  manifest = readFileSync(manifestPath, "utf8");
} catch (error) {
  console.error(`FAIL cannot read src-tauri/Cargo.toml: ${error.message}`);
  process.exit(1);
}

// The feature must exist and must forward to tauri's, or the name is decorative.
if (!/^custom-protocol\s*=\s*\[\s*"tauri\/custom-protocol"\s*\]/m.test(manifest)) {
  problems.push(
    'src-tauri/Cargo.toml does not define `custom-protocol = ["tauri/custom-protocol"]`',
  );
}

// ...and it must be on by default, or a plain `cargo build --release` - the
// command the release checklist and the screenshot sweep both run - produces
// the dev-server shape again.
const defaultLine = /^default\s*=\s*\[([^\]]*)\]/m.exec(manifest);
if (!defaultLine) {
  problems.push("src-tauri/Cargo.toml has no `default = [..]` feature list");
} else if (!/"custom-protocol"/.test(defaultLine[1])) {
  problems.push(
    `src-tauri/Cargo.toml \`default\` does not include "custom-protocol": ${defaultLine[0]}`,
  );
}

// ---------------------------------------------------------------- resolution -
// The manifest can name the feature and cargo can still not enable it (a typo in
// the forwarding array, a platform-specific override). Ask cargo which features
// `tauri` actually has for this package.
let tree = "";
try {
  tree = execFileSync("cargo", ["tree", "-p", "zenith", "-e", "features", "-i", "tauri", "--depth", "1"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
} catch (error) {
  // A missing toolchain is not a licence to skip: the release checklist runs on
  // a machine with cargo, so failing loudly is correct here.
  console.error(`FAIL \`cargo tree -p zenith -e features -i tauri\` failed: ${error.message}`);
  process.exit(1);
}

if (!/tauri feature "custom-protocol"/.test(tree)) {
  problems.push(
    "cargo does not report `tauri feature \"custom-protocol\"` for the zenith package, " +
      "so the built binary would load devUrl instead of the embedded assets",
  );
}

// ---------------------------------------------------------------- assets -----
// The feature is only useful if there is something to embed. `frontendDist` is
// read from the Tauri config so the two cannot disagree.
const confPath = join(ROOT, "src-tauri", "tauri.conf.json");
let conf = null;
try {
  conf = JSON.parse(readFileSync(confPath, "utf8"));
} catch (error) {
  problems.push(`cannot parse src-tauri/tauri.conf.json: ${error.message}`);
}

const distRel = conf?.build?.frontendDist;
if (!distRel) {
  problems.push("tauri.conf.json has no build.frontendDist");
} else {
  const distDir = join(ROOT, "src-tauri", distRel);
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) {
    problems.push(`${distRel}/index.html is missing: run \`npm run build\` before packaging`);
  } else {
    const html = readFileSync(indexPath, "utf8");
    // A build whose <script> is still `/src/main.tsx` is the Vite dev page, not
    // a production bundle.
    if (/src="\/src\//.test(html)) {
      problems.push(`${distRel}/index.html still references /src/: dist holds a dev build`);
    }
    const referenced = [...html.matchAll(/(?:src|href)="\.?\/?([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    if (referenced.length === 0) {
      problems.push(`${distRel}/index.html references no built asset`);
    }
    for (const asset of referenced) {
      if (!existsSync(join(distDir, asset))) {
        problems.push(`${distRel}/index.html references ${asset}, which does not exist`);
      }
    }
    // Hashed names are how Vite reports a *production* build; an unhashed
    // `main.js` is either a dev build or a hand-edited dist.
    const hashed = referenced.filter((name) => /-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(name));
    if (referenced.length > 0 && hashed.length === 0) {
      problems.push(`${distRel} assets are not content-hashed; this is not a production build`);
    }
  }

  // A stale dist is the other half: the bundle embeds whatever was there when
  // the build ran, so a dist older than the renderer sources ships old code.
  if (existsSync(indexPath)) {
    const distTime = statSync(indexPath).mtimeMs;
    const walk = (dir, out = []) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
      }
      return out;
    };
    const newer = walk(join(ROOT, "src")).filter(
      (file) =>
        /\.(ts|tsx|css)$/.test(file) &&
        !/\.test\.(ts|tsx)$/.test(file) &&
        statSync(file).mtimeMs > distTime,
    );
    if (newer.length > 0) {
      problems.push(
        `${distRel} is older than ${newer.length} renderer source file(s), e.g. ` +
          newer[0].slice(ROOT.length + 1) +
          ": rebuild before packaging",
      );
    }
  }
}

// ---------------------------------------------------------------- report -----
console.log(`manifest: custom-protocol ${/"custom-protocol"/.test(manifest) ? "declared" : "MISSING"}`);
console.log(`resolution: ${/tauri feature "custom-protocol"/.test(tree) ? "enabled" : "NOT ENABLED"}`);
console.log(`frontendDist: ${distRel ?? "MISSING"}`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nBundle is self-contained: the release shape embeds the built renderer.");
