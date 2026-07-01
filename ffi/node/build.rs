//! The grammar static-linking now lives in the shared `arborium-rt-native`
//! crate (its `build.rs` compiles every grammar and its
//! `cargo:rustc-link-lib=static=…` directives propagate into this cdylib).
//! All this build script does is wire up napi's linker setup.
fn main() {
    napi_build::setup();
}
