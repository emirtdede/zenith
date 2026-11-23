# Third-Party Licences

Version 1.0.0, effective 23 November 2026.

Zenith itself is MIT licensed. It includes third-party Rust crates, npm packages,
and fonts. Their licences are compatible with the MIT distribution; no copyleft
component is linked into the application in a way that would relicense Zenith.

## 1. Generated inventory

The authoritative inventory is generated from the real dependency graph, not
maintained by hand:

- `resources/sbom/zenith-1.0.0.cdx.json` is a CycloneDX software bill of
  materials produced by `npm run sbom:generate`.
- `resources/licenses/` contains the collected licence texts produced by
  `npm run licenses:generate`.
- `resources/licenses/report.json` is the machine-readable summary used by
  `npm run check:licenses`.

Run `npm run check:sbom` and `npm run check:licenses` to verify that the files
in the tree still match the dependency graph.

## 2. Licence families present

| Family | Examples | Obligation |
| :--- | :--- | :--- |
| MIT | `serde`, `anyhow`, `chrono`, `react` | Include the copyright and permission notice |
| Apache-2.0 | `tauri`, `windows` crate | Include the licence and the NOTICE file where present |
| BSD-3-Clause | `brotli`, `alloc-no-stdlib` | Include the copyright notice and disclaimer |
| MPL-2.0 | `cssparser` | Include the licence text; modifications to MPL files stay MPL |
| Unlicense or MIT | `aho-corasick`, `byteorder` | Include the notice chosen by the crate |
| CC0-1.0 or MIT-0 | `constant_time_eq` | No attribution required; notice included anyway |
| SIL Open Font License 1.1 | DM Sans, Plus Jakarta Sans, JetBrains Mono | Include the licence; do not sell the fonts on their own |

## 3. Fonts

The interface bundles DM Sans, Plus Jakarta Sans, and JetBrains Mono as WOFF2
files in `public/fonts`. They are served from the application package, not from a
content delivery network, so no request leaves the computer for a font. The SIL
OFL permits bundling and requires the licence text to travel with the fonts.

## 4. Source of truth

If this summary and a generated artifact disagree, the generated artifact wins
and this document is corrected. A hand-written licence list that drifts from the
SBOM is worse than no list, because it tells a reviewer that a check was done
when it was not.

## 5. Reporting a licence problem

Write to legal@vellium.dev with the component name and the version from the SBOM.
We remove or replace an incompatible component before the next release.
