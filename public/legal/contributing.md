# Contributing to Zenith

Version 1.0.0, effective 23 November 2026.

## 1. Before you start

- Read `docs/03-architecture/03-01-sad.md` and the IPC contract. The core owns
  every measurement and mutation; a pull request that performs a filesystem or
  service operation in the renderer is refused.
- Read `docs/05-design/05-01-design-system.md`. Colours, spacing, and motion come
  from tokens, not from local values.
- Read `CODE_OF_CONDUCT.md`.

## 2. Development setup

```powershell
git clone https://github.com/emirtdede/zenith.git
cd zenith
npm install
npm run tauri dev
```

Requirements are pinned in `docs/08-delivery/08-01-build-prerequisites.md`:
Node 24, Rust 1.90 with the MSVC target, the Windows SDK, and WebView2.

## 3. The gates you must pass

```powershell
npx tsc --noEmit
npm test
cargo test --workspace
npm run verify
```

`npm run verify` runs the full release chain, including contrast, locale parity,
unused keys, the IPC contract, SBOM, licences, stubs, the Rust lint, and the
bundle shape. A change that only passes the unit tests is not ready.

## 4. Rules for user-facing text

- English and Turkish catalogues must stay at key parity.
- Do not add a typographic dash. The em dash and en dash are banned; use the
  ASCII hyphen. `npm run check:dashes` enforces it.
- Do not add an emoji to UI text, notifications, documentation, or tests.
- A translated string is not "done" because it is non-empty. Read it in context.
- A badge that names a protocol or product carries `lang="en"`.

## 5. Rules for code

- No new IPC command without a document change, a Rust registry entry, a native
  bridge call, and a test. The contract gate counts all four.
- No `unwrap()` on a path that a user can influence. Return the typed error.
- No silent fallback for a measurement. `null` means not measured and the UI
  says so.
- A new action needs a manifest entry, an execution path, a reversibility tier,
  a scope, and a test that the path exists.
- Rust formatting and clippy are part of the gate. Do not reformat unrelated
  code in a functional pull request.

## 6. Commit and pull request

- One concern per pull request.
- Describe the defect or requirement, the change, and the evidence.
- Include the command output for the gates you ran.
- Sign off that you have the right to contribute the code under the MIT licence.

## 7. Review

A maintainer reviews within five business days. A refusal states the rule that
was broken. Security reports do not go through the public pull request flow.
