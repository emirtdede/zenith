//! Drift gate for the generated frontend catalogue (ADR-011).
//!
//! `src/catalog.generated.ts` is compiled into the UI. If it disagrees with
//! `manifest.rs`, the UI will offer an action, tier or scope the core does not
//! enforce - the exact failure mode the single-source rule exists to prevent.
//! This test renders the catalogue from the manifest and compares bytes.

use std::path::PathBuf;

#[test]
fn generated_catalog_matches_the_manifest() {
    let expected = zenith_core::catalog_ts::render();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src")
        .join("catalog.generated.ts");
    let actual = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("cannot read {}: {error}", path.display());
    });

    assert_eq!(
        actual, expected,
        "src/catalog.generated.ts is stale; run \
         `cargo run -p zenith-core --example dump_manifest > src/catalog.generated.ts`"
    );
}

#[test]
fn generated_catalog_parses_as_a_typescript_type_alias() {
    // A trailing `|` before `;` generated invalid TypeScript once. This keeps
    // the shape honest without needing a TypeScript compiler in the Rust gate.
    let rendered = zenith_core::catalog_ts::render();
    let Some(type_block) = rendered.split("export type ActionId =").nth(1) else {
        panic!("rendered catalogue has no `ActionId` alias");
    };
    let Some(type_block) = type_block.split(';').next() else {
        panic!("`ActionId` alias has no terminator");
    };
    assert!(
        !type_block.trim_end().ends_with('|'),
        "ActionId alias must not end with a union separator"
    );
    assert!(
        type_block.matches("'").count() == 44,
        "expected 22 quoted ids, found {} quote characters",
        type_block.matches("'").count()
    );
}
