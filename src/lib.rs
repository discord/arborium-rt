//! arborium-emscripten-runtime
//!
//! Packages [`arborium_plugin_runtime::PluginRuntime`] as an emscripten
//! `SIDE_MODULE=2` wasm suitable for loading into web-tree-sitter's
//! `MAIN_MODULE=2` runtime via `Module.loadWebAssemblyModule`. One instance
//! of this module serves many grammars concurrently: each grammar is
//! registered with its language pointer + queries, sessions are created per
//! grammar, and parse/highlight results are returned as JSON or rendered
//! HTML in shared WASM linear memory.
//!
//! The module exposes two tiers of output:
//!
//! 1. **Raw parse** (`arborium_rt_parse_utf16`) — returns the primary
//!    grammar's captures + injection points as JSON. Useful if the caller
//!    wants to render/theme on its own.
//! 2. **Full highlight pipeline** (`arborium_rt_highlight_*`) — runs parse
//!    → recursive injection resolution → dedup/coalesce → theming, and
//!    either returns themed spans with UTF-16 offsets or emits a fully
//!    rendered HTML string. Injections are looked up by language name
//!    against the registry, so every grammar registered for a language
//!    that appears in an injection query needs to carry its language name.
//!
//! See `README.md` for build and integration instructions.
//!
//! # ABI stability
//!
//! The C function surface defined in `abi.rs` is versioned by
//! [`ABI_VERSION`], returned by `arborium_rt_abi_version()`. Consumers
//! should call it immediately after loading the side module and refuse to
//! proceed on mismatch. Increment [`ABI_VERSION`] whenever the signature,
//! semantics, or JSON payload shape of any `arborium_rt_*` function
//! changes in a breaking way.

mod abi;
mod highlight;
mod registry;

/// ABI version exposed via `arborium_rt_abi_version()`. Bump on breakage.
///
/// * v1 — initial surface: register/unregister grammar, sessions, parse.
/// * v2 — `arborium_rt_register_grammar` now takes a language name; added
///         `arborium_rt_highlight_to_spans_utf16` and
///         `arborium_rt_highlight_to_html`.
pub const ABI_VERSION: u32 = 2;
