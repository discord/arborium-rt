# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`arborium-rt` packages [arborium](https://github.com/bearcove/arborium)'s
plugin runtime as a single emscripten `SIDE_MODULE=2` wasm that loads into
web-tree-sitter's `MAIN_MODULE=2`. One shared runtime instance serves many
per-grammar `SIDE_MODULE` parser wasms dynamically, so the tree-sitter C
runtime and arborium's query runner live once in the browser instead of being
baked into every grammar bundle.

The repo produces three deliverables:

1. `arborium_emscripten_runtime.wasm` — the Rust SIDE_MODULE (this crate's
   `cdylib`). Built for `wasm32-unknown-emscripten` via `cargo build --release`.
2. `web-tree-sitter.{wasm,mjs}` — a custom MAIN_MODULE host built from the
   submodule's `arborium-tree-sitter/binding_web` with an expanded export
   list. Built by `./scripts/arborium-rt build-host`.
3. Per-grammar `tree-sitter-<lang>.wasm` + flattened `.scm` query files,
   wrapped as publishable `@appellation/arborium-rt-<lang>` npm packages.
   Built by `./scripts/arborium-rt build <group> <lang>`.

## Core commands

All repo tooling funnels through one CLI wrapper: `./scripts/arborium-rt
<subcommand>`. The wrapper auto-builds the TS CLI (`pnpm install && tsc`) on
first run, then forwards. Run `./scripts/arborium-rt --help` for the full list.

```sh
# First-time setup (populates submodule crates' Cargo.toml, applies patches).
# Re-run any time you bump the submodule or pull new patches.
./scripts/arborium-rt bootstrap

# Build the Rust SIDE_MODULE runtime. Target is pinned via .cargo/config.toml;
# plain `cargo build --release` does the right thing.
cargo build --release

# Build the MAIN_MODULE host wasm (needs emcc on PATH).
./scripts/arborium-rt build-host

# Build one grammar end-to-end (wasm + flattened queries + npm package).
./scripts/arborium-rt build group-acorn json

# Build every grammar in the submodule corpus.
./scripts/arborium-rt build-all [--only json,css]

# Build + test the TypeScript packages. The arborium-rt `pretest` hook
# runs `stage-dist`, which copies the built host + runtime wasms into
# packages/arborium-rt/dist/ so the Vitest suite can actually load them.
pnpm install
pnpm -r build
pnpm -r test

# Run one Vitest file while iterating on the TS wrapper.
pnpm --filter @appellation/arborium-rt test -- arborium.test.mts

# Publish all packages (runtime + CLI + every built grammar).
./scripts/arborium-rt publish [--dry-run] [--only a,b,c] [--tag next]
```

### Prereqs the tooling expects on PATH

- **emsdk 4.0.15** (`emcc`, `em++`, `llvm-objdump`). Source `emsdk_env.sh`.
- **Nightly Rust** with `rust-src` (for `-Zbuild-std`). A system/nix nightly
  works — rustup isn't required.
- **tree-sitter CLI** (`cargo install tree-sitter-cli`), used by
  `build-grammar` to generate `parser.c` from `grammar.js`.
- **Node ≥20, pnpm ≥9**.

## High-level architecture

### Runtime crate (`src/`)

The Rust SIDE_MODULE has three modules, each with a single job:

- **`abi.rs`** — the `#[unsafe(no_mangle)] extern "C"` surface. Every
  `arborium_rt_*` function here must also appear in the `EXPORTED_FUNCTIONS`
  list in `.cargo/config.toml`, or the linker will strip it. Pointer rules:
  input buffers are borrowed; output buffers are allocated in shared linear
  memory and transferred to the caller, who frees them via
  `arborium_rt_free(ptr, len)`. JSON is the wire format across this boundary.
- **`registry.rs`** — single global `Mutex<Registry>` holding every registered
  grammar's `PluginRuntime`. Session IDs are globally unique and routed back
  to the owning grammar. Maintains a `name → grammar_id` map used by the
  highlight pipeline's injection resolution. A thread-local `PENDING_LANG`
  cell bridges the `*const TSLanguage` from JS into arborium's `LanguageFn`
  signature (called exactly once during registration, inside the registry's
  mutex — no races).
- **`highlight.rs`** — the full parse → recursive injection → dedup →
  coalesce → theme pipeline. Mirrors `arborium_highlight::HighlighterCore`
  upstream but drops the async `GrammarProvider` because registry lookups
  are just `HashMap` hits. `MAX_INJECTION_DEPTH = 32` is a hard cap against
  pathological grammars. Delegates HTML rendering to
  `arborium_highlight::spans_to_html` so output stays lock-step with the
  native Rust highlighter.

### ABI stability

`ABI_VERSION` (in `src/lib.rs`, returned by `arborium_rt_abi_version()`) is
the single integer consumers check on load. **Bump it on any breaking change**
to a function signature, semantics, or the JSON payload shape. Also update
the version-history block in `src/lib.rs` and the README.

### TypeScript consumer package (`packages/arborium-rt/`)

Typed `Runtime` / `Grammar` / `Session` API over the ABI, published as
`@appellation/arborium-rt`. `loadArboriumRuntime()` takes no args — the host
`.mjs`/wasm and the runtime wasm are staged into `packages/arborium-rt/dist/`
(under `host/` and `runtime/`) by `arborium-rt stage-dist`, and the TS
resolver uses `new URL('./host/…', import.meta.url)` so bundlers trace the
specifiers. `stage-dist` is the `pretest` for this package — tests won't
work without it. The raw ABI shape lives in `src/abi.ts`; the user-facing
wrappers in `src/runtime.ts`.

### Dev CLI (`packages/arborium-rt-cli/`)

TS program published as `@appellation/arborium-rt-cli`, entry point
`src/main.ts`. Each subcommand is its own `src/<name>.ts` module. Shared
helpers in `src/util.ts` (repo-root discovery via walking up for a
`Cargo.toml` containing `arborium-emscripten-runtime`; overridable via
`ARBORIUM_RT_ROOT`). The `build-host` module owns the two "extras" arrays
(`EXTRA_TS_EXPORTS`, `EXTRA_LIBC_EXPORTS`) that expand upstream's export
lists with plain `ts_*` symbols and libc/pthread calls Rust's `std` pulls in
— these are the source of truth until upstream takes them.

### The arborium submodule + patches

`third_party/arborium` is pinned to a specific commit (commit, not tag —
`arborium-plugin-runtime` doesn't exist on any released tag yet). The
root `Cargo.toml` path-deps four crates out of it:

- `arborium-plugin-runtime` — unpatched; unpublished upstream.
- `arborium-tree-sitter` — **patched** to skip static tree-sitter C
  linking on emscripten (the MAIN_MODULE resolves those symbols).
- `arborium-wire` — unpatched; unpublished upstream.
- `arborium-highlight`, `arborium-theme` — consumed with
  `default-features = false`; theme's builtin-generated module is
  **patched-stubbed** for emscripten.

Patches live as mbox files in `patches/` (`git am` format). They're all
trivial target guards — no logic changes on any existing target.

`./scripts/arborium-rt bootstrap` is **idempotent**: it resets the
submodule to the pinned SHA, skips patches whose `Subject:` already
appears in submodule history, and renders every `Cargo.stpl.toml` →
`Cargo.toml` (the submodule checks in templates only — `xtask gen` on
arborium's side generates them normally). Re-run after bumping the
submodule or tweaking a patch.

### Target layout

- `target/wasm32-unknown-emscripten/release/arborium_emscripten_runtime.wasm`
  — Rust SIDE_MODULE output (~1.1 MB uncompressed).
- `target/host-wasm/web-tree-sitter.{wasm,mjs}` — MAIN_MODULE host.
- `target/grammars/<lang>/` — `tree-sitter-<lang>.wasm` +
  flattened `.scm` query files (written by `build-grammar`).
- `target/packages/<lang>/` — publishable `@appellation/arborium-rt-<lang>`
  laid out with `package.json`, `index.js`, `index.d.ts`, the wasm, the
  `.scm` files, and a README (written by `package`).

### Verifying a runtime build

```sh
/path/to/emsdk/upstream/bin/llvm-objdump --syms \
  target/wasm32-unknown-emscripten/release/arborium_emscripten_runtime.wasm \
  | grep arborium_rt_
```

Expects all eleven entry points: `arborium_rt_abi_version`,
`arborium_rt_register_grammar`, `arborium_rt_unregister_grammar`,
`arborium_rt_create_session`, `arborium_rt_free_session`,
`arborium_rt_set_text`, `arborium_rt_cancel`, `arborium_rt_parse_utf16`,
`arborium_rt_highlight_to_spans_utf16`, `arborium_rt_highlight_to_html`,
`arborium_rt_free`. Anything missing means the
`.cargo/config.toml` `EXPORTED_FUNCTIONS` list is out of sync.

### Grammar build gotchas

- **Query inheritance** (e.g. HLSL → C++ → C) is resolved transitively by
  reading each grammar's `arborium.yaml` `queries.highlights.prepend`
  list and concatenating; matches arborium's own Rust-plugin template.
  The flattener is in `packages/arborium-rt-cli/src/flatten.ts`.
- **C++ external scanners** (`scanner.cc` / `scanner.cpp`) are compiled
  with `em++ -std=c++17 -fno-exceptions -fno-rtti` and linked alongside
  `parser.c`. No arborium grammar uses this today, but the path is
  scaffolded.
- **`grammar.js` that `require()`s other grammars** (TSX pulls in
  `tree-sitter-javascript`, SCSS pulls in `tree-sitter-css`, etc.)
  needs those npm packages staged into `node_modules/` before
  `tree-sitter generate` runs. `build-grammar` does this by symlinking
  vendored dep grammars' `def/grammar/` dirs into the build dir and
  exposing `NODE_PATH` — but only for grammars already in the
  arborium corpus. Third-party upstream deps are not yet wired up.

## Conventions worth knowing

- **`cargo build` defaults to `wasm32-unknown-emscripten`** via
  `.cargo/config.toml`. Building for any other target is undefined — the
  crate exists only to be loaded into an emscripten host.
- **Never edit `third_party/arborium/crates/*/Cargo.toml`** — they're
  generated from `.stpl.toml` templates by bootstrap. Edit the template or
  patch the template-rendering step in `bootstrap.ts` instead.
- **Adding a new `arborium_rt_*` export requires three coordinated edits**:
  the function in `src/abi.rs`, its name in `.cargo/config.toml`'s
  `EXPORTED_FUNCTIONS` list, and the TS binding in
  `packages/arborium-rt/src/abi.ts` (plus a method on the wrapper class if
  user-facing). Forgetting any of these produces confusing runtime errors,
  not compile errors.
- **Adding a wasm `extern`** (e.g., pulling in a new libc or tree-sitter
  symbol) requires adding it to `EXTRA_TS_EXPORTS` or `EXTRA_LIBC_EXPORTS`
  in `packages/arborium-rt-cli/src/build-host.ts` and rebuilding the host.
  Discover missing imports with `wasm-dis arborium_emscripten_runtime.wasm
  | grep '(import "env"'`.
- **Bumping the submodule**: checkout new SHA in `third_party/arborium`,
  re-run `./scripts/arborium-rt bootstrap`. If patches no longer apply,
  `git am` leaves partial state; inspect with `git -C third_party/arborium
  am --show-current-patch=diff`, fix the patch, re-run. Then
  `cargo build --release` and commit both the submodule bump and any
  patch updates together.
