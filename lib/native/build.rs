//! Statically link every staged grammar into this crate (and, transitively,
//! into whichever cdylib depends on it — `ffi/node`, `ffi/android`, …).
//!
//! Reads the manifest written by `arborium-rt build native grammars` (path via
//! `ARBORIUM_RT_GRAMMARS`, falling back to the legacy `ARBORIUM_RT_NODE_GRAMMARS`,
//! then to `<repo>/target/native-grammars/manifest.json`), `cc`-compiles each
//! grammar's `parser.c` (+ optional scanner), and generates
//! `$OUT_DIR/grammar_table.rs` — an `extern "C"` block declaring every
//! `tree_sitter_<cSymbol>()` plus a `GRAMMARS` table whose flattened `.scm`
//! contents are `include_str!`'d (baked into the binary, no runtime fs reads).
//!
//! The `cargo:rustc-link-lib=static=…` directives `cc` emits here propagate to
//! any cdylib that depends on this rlib, so the FFI shims don't run their own
//! grammar build — they just call [`arborium_rt_native::register_all`].

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
struct Manifest {
    grammars: Vec<Grammar>,
}

#[derive(Deserialize)]
struct Grammar {
    id: String,
    #[serde(rename = "cSymbol")]
    c_symbol: String,
    #[serde(rename = "scannerKind")]
    #[allow(dead_code)]
    scanner_kind: String,
    sources: Vec<String>,
    highlights: Option<String>,
    injections: Option<String>,
    locals: Option<String>,
}

fn main() {
    let manifest_path = manifest_path();
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!("cargo:rerun-if-env-changed=ARBORIUM_RT_GRAMMARS");
    println!("cargo:rerun-if-env-changed=ARBORIUM_RT_NODE_GRAMMARS");

    let raw = fs::read_to_string(&manifest_path).unwrap_or_else(|e| {
        panic!(
            "failed to read grammar manifest {}: {e}\n\
             run `./scripts/arborium-rt build native grammars` first",
            manifest_path.display()
        )
    });
    let manifest: Manifest = serde_json::from_str(&raw).expect("invalid grammar manifest json");
    // The native-grammars root: source/query paths in the manifest are relative
    // to the directory holding manifest.json.
    let root = manifest_path.parent().expect("manifest has a parent").to_path_buf();

    let mut externs = String::new();
    let mut table = String::from("static GRAMMARS: &[GrammarDef] = &[\n");

    for g in &manifest.grammars {
        compile_grammar(&root, g);

        externs.push_str(&format!(
            "    fn tree_sitter_{}() -> *const ::core::ffi::c_void;\n",
            g.c_symbol
        ));
        table.push_str(&format!(
            "    GrammarDef {{ id: {:?}, lang_fn: tree_sitter_{}, highlights: {}, injections: {}, locals: {} }},\n",
            g.id,
            g.c_symbol,
            include_or_empty(&root, &g.highlights),
            include_or_empty(&root, &g.injections),
            include_or_empty(&root, &g.locals),
        ));
    }
    table.push_str("];\n");

    let generated = format!("unsafe extern \"C\" {{\n{externs}}}\n\n{table}");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("grammar_table.rs");
    fs::write(&out, generated).expect("write grammar_table.rs");
}

/// Compile one grammar's C (parser.c + C scanner) and, separately, any C++
/// scanner. Each grammar gets its own `cc::Build` so its `src/` is the only
/// include dir on the command line — grammars all ship an identical
/// `tree_sitter/parser.h`, and per-grammar scoping keeps that unambiguous.
fn compile_grammar(root: &Path, g: &Grammar) {
    let src_dir = root.join(&g.id).join("src");
    let arch = sanitize(&g.id);

    let c_files: Vec<PathBuf> = g
        .sources
        .iter()
        .filter(|s| s.ends_with(".c"))
        .map(|s| root.join(s))
        .collect();
    if !c_files.is_empty() {
        let mut build = cc::Build::new();
        build.include(&src_dir).warnings(false);
        build.flag_if_supported("-std=c11");
        for f in &c_files {
            println!("cargo:rerun-if-changed={}", f.display());
            build.file(f);
        }
        build.compile(&format!("arborium_ts_{arch}"));
    }

    let cxx_files: Vec<PathBuf> = g
        .sources
        .iter()
        .filter(|s| s.ends_with(".cc") || s.ends_with(".cpp"))
        .map(|s| root.join(s))
        .collect();
    if !cxx_files.is_empty() {
        let mut build = cc::Build::new();
        build.cpp(true).include(&src_dir).warnings(false);
        build.flag_if_supported("-std=c++17");
        build.flag_if_supported("-fno-exceptions");
        build.flag_if_supported("-fno-rtti");
        for f in &cxx_files {
            println!("cargo:rerun-if-changed={}", f.display());
            build.file(f);
        }
        build.compile(&format!("arborium_ts_{arch}_scanner"));
    }
}

/// Render a Rust expression for a query slot: `include_str!("<abs>")` when the
/// query exists, `""` otherwise (matches the wasm shim's empty-query convention).
fn include_or_empty(root: &Path, rel: &Option<String>) -> String {
    match rel {
        Some(r) => {
            let abs = root.join(r);
            println!("cargo:rerun-if-changed={}", abs.display());
            format!("include_str!({:?})", abs.display().to_string())
        }
        None => "\"\"".to_string(),
    }
}

fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn manifest_path() -> PathBuf {
    if let Ok(p) = env::var("ARBORIUM_RT_GRAMMARS") {
        return PathBuf::from(p);
    }
    if let Ok(p) = env::var("ARBORIUM_RT_NODE_GRAMMARS") {
        return PathBuf::from(p);
    }
    // lib/native -> repo root is two levels up.
    PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../target/native-grammars/manifest.json")
}
