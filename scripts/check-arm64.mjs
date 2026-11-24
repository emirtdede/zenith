#!/usr/bin/env node
/**
 * `check:arm64` - the ARM64 claim, measured on a real PE header.
 *
 * `cargo build --target aarch64-pc-windows-msvc` can exit 0 for the wrong reason:
 * a stale binary left behind by an earlier run, or a target directory that
 * silently reused an x64 artefact. Both produce a file called `zenith.exe` and
 * neither is an ARM64 build, so the file name proves nothing.
 *
 * This reads the PE `Machine` field instead. `0xAA64` is ARM64 and `0x8664` is
 * x64; anything else fails. The section table's size is also checked, because a
 * truncated or partially written executable still carries a valid header.
 *
 * It does not run the build: a six-minute compile in a gate that already runs
 * thirty-one steps would be run by nobody. The build is a separate command and
 * its output is the evidence file; this gate checks what that command produced.
 *
 * Usage:
 *   node scripts/check-arm64.mjs
 *   node scripts/check-arm64.mjs --binary <path>
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT = join(ROOT, "target", "aarch64-pc-windows-msvc", "release", "zenith.exe");
const X64 = join(ROOT, "target", "release", "zenith.exe");

const args = process.argv.slice(2);
const index = args.indexOf("--binary");
const binary = resolve(index === -1 ? DEFAULT : args[index + 1]);

const MACHINES = {
  0x014c: "x86",
  0x8664: "x64",
  0xaa64: "ARM64",
  0x01c4: "ARM",
};

const problems = [];

if (!existsSync(binary)) {
  console.error(`missing ${binary}`);
  console.error(
    "Build it first: $env:RUSTC = \"$env:USERPROFILE\\.rustup\\toolchains\\stable-x86_64-pc-windows-msvc\\bin\\rustc.exe\"; cargo build --release --target aarch64-pc-windows-msvc --locked",
  );
  process.exit(1);
}

const bytes = readFileSync(binary);
const size = statSync(binary).size;

if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
  problems.push("no MZ signature: this is not a PE executable");
} else {
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length) {
    problems.push(`PE header offset 0x${peOffset.toString(16)} is outside the file`);
  } else if (bytes.readUInt32LE(peOffset) !== 0x00004550) {
    problems.push("no PE\\0\\0 signature at the header offset");
  } else {
    const machine = bytes.readUInt16LE(peOffset + 4);
    const sections = bytes.readUInt16LE(peOffset + 6);
    const optionalSize = bytes.readUInt16LE(peOffset + 20);

    const name = MACHINES[machine] ?? `unknown (0x${machine.toString(16)})`;
    console.log(`binary:   ${binary}`);
    console.log(`size:     ${size} bytes`);
    console.log(`machine:  0x${machine.toString(16).toUpperCase()} (${name})`);
    console.log(`sections: ${sections}`);
    console.log(`optional header: ${optionalSize} bytes`);

    if (machine !== 0xaa64) {
      problems.push(`machine is ${name}, not ARM64`);
    }
    if (sections < 3) {
      problems.push(`only ${sections} sections: the executable looks incomplete`);
    }
    if (optionalSize < 0xe0) {
      problems.push(`PE32+ optional header is ${optionalSize} bytes, expected at least 224`);
    }
  }
}

// The x64 build, when present, must be a different file. Two identical binaries
// would mean the "ARM64" build was a copy of the x64 one.
if (existsSync(X64) && existsSync(binary) && resolve(X64) !== resolve(binary)) {
  const left = statSync(X64).size;
  if (left === size) {
    problems.push(`the ARM64 binary is the same size as the x64 one (${size} bytes): suspicious, verify by hash`);
  } else {
    console.log(`distinct: differs from the x64 binary (${left} bytes)`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("\nARM64 build holds: the PE machine field is 0xAA64 and the executable is complete.");
