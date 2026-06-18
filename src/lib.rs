//! arborium-rt
//!
//! Target-agnostic core of the arborium plugin runtime. Wraps
//! [`arborium_plugin_runtime::PluginRuntime`] with a grammar/session
//! [`registry`] and a full [`highlight`] pipeline, exposing them as plain
//! Rust so any host can drive them. One [`registry::Registry`] serves many
//! grammars concurrently: each grammar is registered with its language
//! pointer + queries, sessions are created per grammar, and parse/highlight
//! results come back as serializable data structures.
//!
//! This crate carries **no** C ABI and no `cdylib` linkage — it builds for
//! any target. The emscripten `SIDE_MODULE=2` wrapper that exposes these
//! modules over an `extern "C"` surface (for loading into web-tree-sitter's
//! `MAIN_MODULE=2` runtime) lives in the sibling `arborium-rt-wasm` crate
//! under `lib/wasm/`. Future non-wasm hosts add their own thin shim crate
//! against this same core.
//!
//! The pipeline produces two tiers of output:
//!
//! 1. **Raw parse** ([`registry::Registry::with_session`] +
//!    `PluginRuntime::parse_utf16`) — the primary grammar's captures +
//!    injection points, for callers that render/theme on their own.
//! 2. **Full highlight** ([`highlight::highlight_to_themed_utf16`] /
//!    [`highlight::highlight_to_html`]) — parse → recursive injection
//!    resolution → dedup/coalesce → theming, returning themed spans with
//!    UTF-16 offsets or a rendered HTML string. Injections are looked up by
//!    language name against the registry, so every grammar registered for a
//!    language that appears in an injection query needs to carry its
//!    language name.
//!
//! See `README.md` for build and integration instructions.

pub mod highlight;
pub mod registry;
