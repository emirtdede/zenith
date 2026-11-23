//! Emits `src/catalog.generated.ts` from the canonical manifest.
//!
//! The conversion lives in [`zenith_core::catalog_ts`], so the `catalog_in_sync`
//! integration test can call the same function and compare it with the committed
//! file. A generator that only exists inside an example cannot be tested.
//!
//! Run with:
//!
//! ```text
//! cargo run -p zenith-core --example dump_manifest > src/catalog.generated.ts
//! ```

fn main() {
    print!("{}", zenith_core::catalog_ts::render());
}
