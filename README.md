# arborium-rt

Emscripten `SIDE_MODULE=2` runtime for [arborium](https://github.com/bearcove/arborium) grammar plugins.

Loads once into web-tree-sitter's `MAIN_MODULE=2` wasm and runs
`arborium-plugin-runtime`'s session / highlight / injection logic across
many grammars loaded dynamically at runtime, so the tree-sitter C
runtime and arborium's query runner live once in the browser instead
of being baked into every grammar bundle.

## Architecture

```
┌─────────────────────────────────┐
│ web-tree-sitter.wasm            │   MAIN_MODULE=2, upstream tree-sitter.
│                                 │   Ships the C runtime once (~200 KB).
└──────────────▲──────────────────┘
               │ loadWebAssemblyModule
       ┌───────┴────────┐
       │                │
┌──────┴──────────┐  ┌──┴──────────────────────────────┐
│ tree-sitter-    │  │ arborium_emscripten_runtime.wasm │
│ <grammar>.wasm  │  │  (this crate)                    │
│ one per grammar │  │  one shared copy                 │
└─────────────────┘  └──────────────────────────────────┘
   parser tables       session + query execution in Rust
```

One running instance of the runtime serves many grammars via a
registry keyed by grammar ID. Each grammar is registered by handing
over its `*const TSLanguage` (from its side module's
`tree_sitter_<lang>()` export) plus the three query strings
(`highlights.scm`, `injections.scm`, `locals.scm`). Parse results are
JSON-encoded `arborium_wire::Utf16ParseResult` delivered through
shared linear memory.

See `src/abi.rs` for the full C ABI. Minimal JavaScript integration:

```js
import MainModuleFactory from './web-tree-sitter.mjs';
const Module = await MainModuleFactory();

const runtime = await Module.loadWebAssemblyModule(
    await fetch('arborium_emscripten_runtime.wasm').then(r => r.arrayBuffer()),
    { loadAsync: true });
if (runtime.arborium_rt_abi_version() !== 1)
    throw new Error('arborium_rt ABI mismatch');

const json = await Module.loadWebAssemblyModule(
    await fetch('tree-sitter-json.wasm').then(r => r.arrayBuffer()),
    { loadAsync: true });
const langPtr = json.tree_sitter_json();

function putStr(s) {
    const bytes = new TextEncoder().encode(s);
    const p = Module._malloc(bytes.length);
    Module.HEAPU8.set(bytes, p);
    return [p, bytes.length];
}
const [hPtr, hLen] = putStr(HIGHLIGHTS_SCM);
const [iPtr, iLen] = putStr('');
const [lPtr, lLen] = putStr('');
const grammarId = runtime.arborium_rt_register_grammar(
    langPtr, hPtr, hLen, iPtr, iLen, lPtr, lLen);

const sessionId = runtime.arborium_rt_create_session(grammarId);
const [tPtr, tLen] = putStr('[1, 2, 3]');
runtime.arborium_rt_set_text(sessionId, tPtr, tLen);
Module._free(tPtr);

const outPtr = Module._malloc(4);
const outLen = Module._malloc(4);
if (runtime.arborium_rt_parse_utf16(sessionId, outPtr, outLen) !== 0)
    throw new Error('parse failed');
const payload = JSON.parse(Module.UTF8ToString(
    Module.getValue(outPtr, 'i32'),
    Module.getValue(outLen, 'i32')));
runtime.arborium_rt_free(
    Module.getValue(outPtr, 'i32'),
    Module.getValue(outLen, 'i32'));
Module._free(outPtr);
Module._free(outLen);
```

## Dependency on arborium

This crate depends on four arborium crates by path into the
`third_party/arborium/` git submodule:

- `arborium-plugin-runtime` (unpatched; unpublished upstream)
- `arborium-tree-sitter` (patched — see `patches/`)
- `arborium-sysroot` (patched — see `patches/`)
- `arborium-wire` (unpatched; unpublished upstream)

The submodule points at a specific commit of
`github.com/bearcove/arborium`, currently `b7a8eb8`. It's pinned to a
commit rather than a tag because no upstream release tag contains
`arborium-plugin-runtime` yet — it was added on `main` after v2.16.0.

Two small patches (`patches/0001-*.patch`) apply on top of the pinned
submodule to enable `wasm32-unknown-emscripten` builds:

1. `arborium-tree-sitter/binding_rust/build.rs`: target-gated
   early-return that skips the `cc::Build` step so the tree-sitter C
   runtime isn't statically linked into the side module — the
   MAIN_MODULE resolves those symbols at load time.
2. `arborium-sysroot/{build.rs, src/lib.rs}`: narrow the wasm
   allocator's `cfg`/target gates to exclude emscripten, so emcc's
   libc isn't duplicated.

The patches are trivial target guards; they don't touch logic on any
existing target. They're the minimum surface needed for the emscripten
build to link.

`arborium-rt` also has to run a second bootstrap step because
arborium's `crates/*/Cargo.toml` files are not checked in — they're
generated from `Cargo.stpl.toml` templates by `xtask gen` on arborium's
side. `./scripts/arborium-rt bootstrap` takes care of this: it resets
the submodule, applies patches (idempotently), and renders the
manifests. Re-run after updating the submodule.

## Build

Prereqs:

- [emsdk](https://github.com/emscripten-core/emsdk) 4.0.15 on `PATH`.
- Nightly Rust with the `rust-src` component (for `-Zbuild-std`). No
  rustup needed; a system/nix install is fine.
- Node ≥20, `tree-sitter` CLI on `PATH` (`cargo install tree-sitter-cli`).

All repo tooling lives behind one CLI:
`./scripts/arborium-rt <subcommand>`. The wrapper auto-builds the CLI
(`npm install && tsc`) on first run, then forwards everything.
`./scripts/arborium-rt --help` lists subcommands.

```sh
git clone --recurse-submodules <this-repo>
cd arborium-rt
./scripts/arborium-rt bootstrap     # apply patches + render Cargo manifests
cargo build --release
```

Output: `target/wasm32-unknown-emscripten/release/arborium_emscripten_runtime.wasm` (~1.1 MB uncompressed).

Verify exports:

```sh
/path/to/emsdk/upstream/bin/llvm-objdump --syms \
  target/wasm32-unknown-emscripten/release/arborium_emscripten_runtime.wasm \
  | grep arborium_rt_
```

Expects: `arborium_rt_abi_version`, `arborium_rt_register_grammar`,
`arborium_rt_unregister_grammar`, `arborium_rt_create_session`,
`arborium_rt_free_session`, `arborium_rt_set_text`, `arborium_rt_cancel`,
`arborium_rt_parse_utf16`, `arborium_rt_free`.

## Reproducing end-to-end

The runtime alone isn't enough to run — it needs a host wasm
(`web-tree-sitter.wasm` built with the extra `ts_*` exports it imports)
and a grammar wasm (a per-grammar SIDE_MODULE exporting
`tree_sitter_<lang>()`). The CLI builds both, plus the publishable
`@appellation/arborium-rt-<lang>` npm package:

```sh
./scripts/arborium-rt bootstrap                      # patches + Cargo manifests
cargo build --release                                # arborium_emscripten_runtime.wasm
./scripts/arborium-rt build-host                     # target/host-wasm/web-tree-sitter.{wasm,mjs}
./scripts/arborium-rt build group-acorn json         # build-grammar + package, in one
pnpm --filter @appellation/arborium-rt test          # end-to-end parse test
```

`build-grammar` writes the flattened `.scm` query files alongside the
wasm in `target/grammars/<lang>/`. Query inheritance (e.g., HLSL → C++ →
C) is resolved transitively by reading each grammar's `arborium.yaml`
`queries.highlights.prepend` list — matches arborium's own Rust-plugin
template. C++ external scanners (`scanner.cc`/`.cpp`) are compiled with
`em++ -std=c++17 -fno-exceptions -fno-rtti` and linked alongside
`parser.c`; no arborium grammar needs this today, but the path exists
so future ones won't be stuck.

Grammars whose `grammar.js` `require()`s upstream node_modules (TSX
pulls in `tree-sitter-javascript`, SCSS pulls in `tree-sitter-css`) need
those packages installed in the CWD before `tree-sitter generate` runs
— an npm-bootstrapping step is not yet wired into the CLI.

### Packaging a grammar for npm

`./scripts/arborium-rt package <group> <lang>` (or the `build`
shorthand above, which does `build-grammar` + `package`) turns
`target/grammars/<lang>/` into a publishable `target/packages/<lang>/`
laid out as `@appellation/arborium-rt-<lang>`:

```
target/packages/json/
├── package.json                # name: "@appellation/arborium-rt-json", version, exports
├── index.js                    # ESM default export: { languageId, languageExport, wasm: URL, highlights, ... }
├── index.d.ts                  # types compatible with ArboriumGrammarPackage
├── tree-sitter-json.wasm
├── highlights.scm              # raw .scm files also shipped as siblings
└── README.md
```

The default export is structurally assignable to
`ArboriumGrammarPackage` / `LoadGrammarOptions`, so consumers do:

```ts
import jsonGrammar from '@appellation/arborium-rt-json';
const grammar = await runtime.loadGrammar(jsonGrammar);
```

`runtime.loadGrammar` resolves the package's `wasm: URL` internally
(`fetch` for `http(s):`, `fs.readFile` for `file:` under Node).

## JS consumer package

A TypeScript wrapper over this ABI ships in
[`packages/arborium-rt/`](./packages/arborium-rt) and publishes as
`@appellation/arborium-rt`. It handles the three-module load dance, the
shared-heap memory plumbing, and exposes a typed `Runtime` / `Grammar` /
`Session` API. The `arborium-rt` dev CLI used throughout this README
lives in [`packages/arborium-rt-cli/`](./packages/arborium-rt-cli) and
publishes as `@appellation/arborium-rt-cli`. See
[packages/arborium-rt/README.md](./packages/arborium-rt/README.md) for
consumer docs; run `pnpm install && pnpm -r build && pnpm -r test` at the
repo root to build and verify locally.

## Bumping the arborium submodule

1. `cd third_party/arborium && git fetch origin && git checkout <new-commit>`
2. `cd ../..`
3. `./scripts/arborium-rt bootstrap` — if the patches no longer apply
   cleanly, `git am` will leave the submodule in a partial state;
   investigate with `git -C third_party/arborium am --show-current-patch=diff`,
   fix the patch in `patches/`, then re-run. The bootstrap subcommand
   is idempotent — it skips patches whose subject already appears in the
   submodule's history.
4. `cargo build --release` to verify.
5. `git add third_party/arborium patches/ && git commit`.

## Host-side requirement

The runtime imports two classes of symbols a stock `web-tree-sitter.wasm`
doesn't keep alive through `-sEXPORTED_FUNCTIONS`:

1. Plain-named tree-sitter C symbols (`ts_parser_new`, `ts_query_cursor_exec`,
   ...) — upstream's `binding_web/lib/exports.txt` only lists the `*_wasm`
   JS-bridge variants.
2. libc / pthread surface pulled in by Rust's `std` (`pthread_mutex_*`,
   `writev`, `getenv`, `posix_memalign`, ...) — upstream's
   `stdlib-symbols.txt` covers only `malloc`/`memcpy`/etc.

`./scripts/arborium-rt build-host` produces a compatible host by
concatenating the upstream lists with the extra names arborium-rt needs.
Both extras arrays are enumerated inline in
[`packages/arborium-rt-cli/src/build-host.ts`](./packages/arborium-rt-cli/src/build-host.ts) and commented
with how they were discovered (`wasm-dis` on the runtime wasm). Until
the deltas are upstreamed, that module is the source of truth.

## Stability

The C ABI is versioned by `ABI_VERSION` (currently `1`) exposed via
`arborium_rt_abi_version()`. Consumers should call it right after
`loadWebAssemblyModule` and refuse to proceed on mismatch. Increment
on any breaking change.

## License

MIT, matching arborium.
