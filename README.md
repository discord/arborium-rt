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

Most consumers should use the typed TypeScript wrapper:

```sh
npm install @appellation/arborium-rt @appellation/arborium-rt-json
```

```ts
import { loadArboriumRuntime } from '@appellation/arborium-rt';
import jsonGrammar from '@appellation/arborium-rt-json';

const runtime = await loadArboriumRuntime();
const grammar = await runtime.loadGrammar(jsonGrammar);
const session = grammar.createSession();
try {
    session.setText('[1, 2, 3]');

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
SIDE_MODULE ship inside the npm package and resolve relative to their own
module URL. Bundlers (Vite, webpack, esbuild) trace the specifiers and
copy the wasm assets into your build automatically.

See [`packages/arborium-rt/README.md`](./packages/arborium-rt/README.md)
for the full consumer API (`Runtime`, `Grammar`, `Session`,
`highlightToSpans`, `highlightToHtml`, error shapes).

## Grammar packages

Grammars ship as separate packages named `@appellation/arborium-rt-<lang>`
whose default export is structurally assignable to
`runtime.loadGrammar`'s argument, so no glue code is needed. Each
package ships:

```
@appellation/arborium-rt-json/
├── package.json
├── index.js         # ESM default: { languageId, languageExport, wasm: URL, highlights, ... }
├── index.d.ts
├── tree-sitter-json.wasm
├── highlights.scm   # flattened — prepend chain + own, also shipped alongside as raw file
└── README.md
```

`runtime.loadGrammar` accepts `wasm` as a `URL`, `ArrayBuffer`,
`Uint8Array`, `Response`, or a `Promise` of any of those — it uses
`fetch` for `http(s):` URLs and `fs.readFile` for `file:` URLs under
Node.

## Raw ABI

If you need to skip the TS wrapper — e.g. to embed the runtime in a
non-JS host, or to experiment against `src/abi.rs` directly — the
surface is a set of `arborium_rt_*` `extern "C"` functions exchanging
bytes through shared linear memory. A minimal JS driver:

```js
import MainModuleFactory from './web-tree-sitter.mjs';
const Module = await MainModuleFactory();

const runtime = await Module.loadWebAssemblyModule(
    await fetch('arborium_emscripten_runtime.wasm').then(r => r.arrayBuffer()),
    { loadAsync: true });
if (runtime.arborium_rt_abi_version() !== 2)
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
const [nPtr, nLen] = putStr('json');  // language name, used for injection lookups
const [hPtr, hLen] = putStr(HIGHLIGHTS_SCM);
const [iPtr, iLen] = putStr('');
const [lPtr, lLen] = putStr('');
const grammarId = runtime.arborium_rt_register_grammar(
    langPtr, nPtr, nLen, hPtr, hLen, iPtr, iLen, lPtr, lLen);

const sessionId = runtime.arborium_rt_create_session(grammarId);
const [tPtr, tLen] = putStr('[1, 2, 3]');
runtime.arborium_rt_set_text(sessionId, tPtr, tLen);
Module._free(tPtr);

// Render to HTML via the full highlight pipeline. `format=0` = CustomElements
// (`<a-k>…</a-k>`), `maxDepth=3` matches the TS wrapper's default.
const outPtr = Module._malloc(4);
const outLen = Module._malloc(4);
if (runtime.arborium_rt_highlight_to_html(
        sessionId, /* maxDepth */ 3, /* format */ 0,
        /* prefixPtr */ 0, /* prefixLen */ 0,
        outPtr, outLen) !== 0)
    throw new Error('highlight failed');
const html = Module.UTF8ToString(
    Module.getValue(outPtr, 'i32'),
    Module.getValue(outLen, 'i32'));
runtime.arborium_rt_free(
    Module.getValue(outPtr, 'i32'),
    Module.getValue(outLen, 'i32'));
Module._free(outPtr);
Module._free(outLen);
```

For themed spans instead of HTML, swap `arborium_rt_highlight_to_html`
for `arborium_rt_highlight_to_spans_utf16` (same output-buffer protocol,
minus the format + prefix args) and `JSON.parse` the payload into
`{ spans: [{ start, end, tag }, ...] }`. For raw captures + injection
points with no theming, use `arborium_rt_parse_utf16`.

The full C ABI is documented inline in
[`src/abi.rs`](./src/abi.rs) — pointer ownership rules, return codes,
and per-function contracts.

## ABI stability

The C ABI is versioned by `ABI_VERSION` (currently `2`) exposed via
`arborium_rt_abi_version()`. Consumers should call it right after
`loadWebAssemblyModule` and refuse to proceed on mismatch. The typed
wrapper does this for you.

Version history:

- **v1** — initial surface: register/unregister grammar, sessions, raw parse.
- **v2** — `arborium_rt_register_grammar` gained a language-name parameter
  (used for injection lookups); added `arborium_rt_highlight_to_spans_utf16`
  and `arborium_rt_highlight_to_html` for full parse+highlight+render in
  one call.

## Building from source

Build instructions, prereqs (emsdk, nightly Rust, tree-sitter CLI), the
`./scripts/arborium-rt` CLI reference, submodule + patch layout, and
grammar-build gotchas live in [`CLAUDE.md`](./CLAUDE.md).

TL;DR:

```sh
git clone --recurse-submodules <this-repo>
cd arborium-rt
./scripts/arborium-rt bootstrap     # apply patches + render Cargo manifests
cargo build --release               # arborium_emscripten_runtime.wasm
./scripts/arborium-rt build-host    # web-tree-sitter.{wasm,mjs}
./scripts/arborium-rt build group-acorn json
pnpm install && pnpm -r build && pnpm -r test
```

## License

MIT, matching arborium.
