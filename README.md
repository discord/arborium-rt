# arborium-rt

A [tree-sitter](https://tree-sitter.github.io/) + [arborium](https://github.com/bearcove/arborium)
highlight runtime, packaged for two hosts:

- **`@discord/arborium-rt-wasm`** (browser) — an Emscripten
  `SIDE_MODULE=2` runtime that loads once into web-tree-sitter's
  `MAIN_MODULE=2` wasm and runs `arborium-plugin-runtime`'s session /
  highlight / injection logic across many grammars loaded **dynamically**
  at runtime, so the tree-sitter C runtime and arborium's query runner
  live once in the browser instead of being baked into every grammar
  bundle.
- **`@discord/arborium-rt-node`** (Node.js) — a **statically-linked**
  native addon (napi-rs) that compiles every grammar's parser/scanner and
  bakes every flattened query directly into one `.node` binary. No wasm,
  no host module, no dynamic loading — just call
  `highlightToSpans(language, text)`. Prebuilt binaries ship for darwin
  (x64, arm64), linux gnu (x64, arm64), and win32 x64 (msvc).

Both packages expose the same highlight pipeline over the same
target-agnostic `arborium-rt` Rust core and return structurally identical
result types, so they're interchangeable for highlighting.

> **Distribution.** Each release attaches the browser tarball and the
> per-platform Node `.node` binaries to a **GitHub Release** — install
> from there.

The sections below cover the browser package; see [Node.js](#nodejs) for
the native addon and
[`packages/arborium-rt-wasm/README.md`](./packages/arborium-rt-wasm/README.md)
for the full browser consumer API.

## Architecture (browser)

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
`tree_sitter_<lang>()` export), a language name (used to resolve
`@injection.language` captures against other registered grammars),
plus the three query strings (`highlights.scm`, `injections.scm`,
`locals.scm`).

The primary output is a full highlight pipeline
(`arborium_rt_highlight_to_html` / `arborium_rt_highlight_to_spans_utf16`)
that handles recursive injection resolution, dedup, theming, and
optional HTML rendering end-to-end in WASM. A lower-level escape hatch
(`arborium_rt_parse_utf16`) returns raw spans + injection points for
consumers that want to render on their own. Both deliver their payloads
through shared linear memory.

## Quick start

Browser consumers should use the typed TypeScript wrapper. Grab the
`discord-arborium-rt-wasm-<version>.tgz` tarball from the latest GitHub
Release and install it:

```sh
npm install ./discord-arborium-rt-wasm-<version>.tgz
```

```ts
import { loadArboriumRuntime, GRAMMARS } from "@discord/arborium-rt-wasm";

const runtime = await loadArboriumRuntime();
const grammar = await runtime.loadGrammar(GRAMMARS.json);
const session = grammar.createSession();
try {
  session.setText("[1, 2, 3]");

  // Render straight to HTML — parse + inject + theme, one call.
  const html = session.highlightToHtml();
  // e.g.: '[<a-n>1</a-n>, <a-n>2</a-n>, <a-n>3</a-n>]'

  // Or get themed spans if you want to render yourself (offsets are UTF-16):
  const spans = session.highlightToSpans();
  // [{ start: 1, end: 2, tag: 'n' }, { start: 4, end: 5, tag: 'n' }, ...]
} finally {
  session.free();
  grammar.unregister();
}
```

`highlightToHtml` accepts a `format` option — `custom-elements` (default,
compact `<a-k>…</a-k>`), `class-names` (`<span class="keyword">…</span>`
for CSS that expects long class names), or either with a prefix to avoid
collisions. Both highlight entry points accept `maxInjectionDepth` (defaults
to 3; the runtime caps it at 32) to control how deep language injections
(e.g. JS-in-HTML-in-Markdown) recurse.

If you need the underlying parse — capture names, injection points, no
theming — `session.parse()` returns a `Utf16ParseResult` with
`{ spans, injections }`.

`loadArboriumRuntime()` takes no arguments — the host wasm and the runtime
SIDE_MODULE ship inside the package and resolve relative to their own
module URL. Bundlers (Vite, webpack, esbuild) trace the specifiers and
copy the wasm assets into your build automatically.

See [`packages/arborium-rt-wasm/README.md`](./packages/arborium-rt-wasm/README.md)
for the full consumer API (`Runtime`, `Grammar`, `Session`,
`highlightToSpans`, `highlightToHtml`, error shapes).

## Grammars

Every supported grammar is bundled into the `@discord/arborium-rt-wasm`
tarball and exposed as a single eager map — `GRAMMARS` — keyed by language
id (its `BundledGrammarId` union). Each entry carries lightweight metadata
(`languageId`, `languageExport`) plus URL references to the per-grammar
`.wasm` and `.scm` assets; the bytes are only fetched when `loadGrammar`
runs.

```ts
import { GRAMMARS, loadArboriumRuntime } from "@discord/arborium-rt-wasm";

const runtime = await loadArboriumRuntime();
const grammar = await runtime.loadGrammar(GRAMMARS.typescript);
```

Layout inside the package:

```
@discord/arborium-rt-wasm/
├── dist/
│   ├── host/web-tree-sitter.{wasm,mjs}
│   ├── runtime/arborium_emscripten_runtime.wasm
│   ├── grammars.js           # exports GRAMMARS — URLs point at the sibling subdirs
│   └── grammars/
│       ├── json/
│       │   ├── tree-sitter-json.wasm
│       │   └── highlights.scm       # flattened — prepend chain + own
│       └── …one per grammar
└── package.json
```

`runtime.loadGrammar` accepts `wasm` as a `URL`, `ArrayBuffer`, or
`Uint8Array`, and accepts the query fields (`highlights`, `injections`,
`locals`) as either a raw string or a `URL` — URLs are fetched under
browsers and read from disk under Node.

### Bundle size

Because `GRAMMARS` references every language's assets statically, a
naive bundler trace will emit ~160 MB of `.wasm` + `.scm` even if the
consumer only uses a handful. If your bundler can tree-shake based on
which entries you actually reference, you'll only pay for the grammars
you load. Otherwise, expect the full asset set.

## Node.js

For server-side use, `@discord/arborium-rt-node` is a native addon with
**every** grammar statically linked in — no wasm host, no dynamic loading,
no assets to trace. It exposes the same highlight pipeline
(`highlightToSpans` / `highlightToHtml` / `Session`) and result shapes as
the browser package; you just name the language by id instead of loading a
grammar. Prebuilt binaries ship for darwin (x64, arm64), linux gnu (x64,
arm64), and win32 x64 (msvc).

See [`packages/arborium-rt-node/README.md`](./packages/arborium-rt-node/README.md)
for the full consumer API.

## Raw ABI

If you need to skip the TS wrapper — e.g. to embed the runtime in a
non-JS host, or to experiment against `lib/wasm/src/lib.rs` directly — the
surface is a set of `arborium_rt_*` `extern "C"` functions exchanging
bytes through shared linear memory. A minimal JS driver:

```js
import MainModuleFactory from "./web-tree-sitter.mjs";
const Module = await MainModuleFactory();

const runtime = await Module.loadWebAssemblyModule(
  await fetch("arborium_emscripten_runtime.wasm").then((r) => r.arrayBuffer()),
  { loadAsync: true },
);

const json = await Module.loadWebAssemblyModule(
  await fetch("tree-sitter-json.wasm").then((r) => r.arrayBuffer()),
  { loadAsync: true },
);
const langPtr = json.tree_sitter_json();

function putStr(s) {
  const bytes = new TextEncoder().encode(s);
  const p = Module._malloc(bytes.length);
  Module.HEAPU8.set(bytes, p);
  return [p, bytes.length];
}
const [nPtr, nLen] = putStr("json"); // language name, used for injection lookups
const [hPtr, hLen] = putStr(HIGHLIGHTS_SCM);
const [iPtr, iLen] = putStr("");
const [lPtr, lLen] = putStr("");
const grammarId = runtime.arborium_rt_register_grammar(
  langPtr,
  nPtr,
  nLen,
  hPtr,
  hLen,
  iPtr,
  iLen,
  lPtr,
  lLen,
);

const sessionId = runtime.arborium_rt_create_session(grammarId);
const [tPtr, tLen] = putStr("[1, 2, 3]");
runtime.arborium_rt_set_text(sessionId, tPtr, tLen);
Module._free(tPtr);

// Render to HTML via the full highlight pipeline. `format=0` = CustomElements
// (`<a-k>…</a-k>`), `maxDepth=3` matches the TS wrapper's default.
const outPtr = Module._malloc(4);
const outLen = Module._malloc(4);
if (
  runtime.arborium_rt_highlight_to_html(
    sessionId,
    /* maxDepth */ 3,
    /* format */ 0,
    /* prefixPtr */ 0,
    /* prefixLen */ 0,
    outPtr,
    outLen,
  ) !== 0
)
  throw new Error("highlight failed");
const html = Module.UTF8ToString(
  Module.getValue(outPtr, "i32"),
  Module.getValue(outLen, "i32"),
);
runtime.arborium_rt_free(
  Module.getValue(outPtr, "i32"),
  Module.getValue(outLen, "i32"),
);
Module._free(outPtr);
Module._free(outLen);
```

For themed spans instead of HTML, swap `arborium_rt_highlight_to_html`
for `arborium_rt_highlight_to_spans_utf16` (same output-buffer protocol,
minus the format + prefix args) and `JSON.parse` the payload into
`{ spans: [{ start, end, tag }, ...] }`. For raw captures + injection
points with no theming, use `arborium_rt_parse_utf16`.

The full C ABI is documented inline in
[`lib/wasm/src/lib.rs`](./lib/wasm/src/lib.rs) — pointer ownership rules,
return codes, and per-function contracts.

## Building from source

Build instructions, prereqs (emsdk, nightly Rust, tree-sitter CLI), the
`./scripts/arborium-rt` CLI reference, submodule + patch layout, and
grammar-build gotchas live in [`CLAUDE.md`](./CLAUDE.md).

TL;DR:

```sh
git clone --recurse-submodules <this-repo>
cd arborium-rt
./scripts/arborium-rt bootstrap     # apply patches + render Cargo manifests
./scripts/arborium-rt build wasm runtime   # arborium_rt_wasm.wasm (SIDE_MODULE)
./scripts/arborium-rt build wasm host      # web-tree-sitter.{wasm,mjs}
./scripts/arborium-rt build wasm grammars  # build all grammars (browser)
./scripts/arborium-rt build native grammars # stage grammar sources (shared by node + android)
./scripts/arborium-rt build node           # link the statically-linked Node addon
./scripts/arborium-rt build android        # cross-compile the Android .so per ABI + AAR (needs NDK)
pnpm install && pnpm -r build && pnpm -r test
```

Each deployable target is built explicitly — a bare `cargo build` only
builds the target-agnostic core `arborium-rt` rlib natively.

## License

MIT
