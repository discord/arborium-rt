# @discord/arborium-rt-wasm

TypeScript package that dynamically links tree-sitter, arborium, and per-grammar
parser tables in the browser so each pays for itself exactly once.

See the repo root for the project overview; this README covers consumer
usage and the [architecture](#architecture) behind it.

## Install

Grab the `discord-arborium-rt-wasm-<version>.tgz` tarball from the latest
GitHub Release and install it:

```sh
npm install ./discord-arborium-rt-wasm-<version>.tgz
```

The package ships three asset kinds alongside its compiled JS:
`dist/host/web-tree-sitter.{wasm,mjs}` (the MAIN_MODULE tree-sitter C runtime
rebuilt with the plain `ts_*` exports + libc/pthread surface arborium-rt's
SIDE_MODULEs import), `dist/runtime/arborium_emscripten_runtime.wasm` (the
arborium-rt SIDE_MODULE), and `dist/grammars/<lang>/{tree-sitter-<lang>.wasm, *.scm}`
(one subdir per bundled language).

## Usage

```ts
import { GRAMMARS, loadArboriumRuntime } from '@discord/arborium-rt-wasm';

const runtime = await loadArboriumRuntime();
const grammar = await runtime.loadGrammar(GRAMMARS.rust);

const session = grammar.createSession();
session.setText('fn main() { println!("hi") }');
const { spans, injections } = session.parse();
// spans: [{ start, end, capture, pattern_index }, ...]

session.free();
grammar.unregister();
```

`loadArboriumRuntime()` takes no arguments — the MAIN_MODULE host and the
arborium-rt SIDE_MODULE ship inside the package (`dist/host/` and
`dist/runtime/`) and are loaded relative to the module's own URL. Bundlers
(Vite, webpack/rspack, esbuild) trace those specifiers so the wasm assets
are copied automatically into the consumer's build.

`runtime.loadGrammar` accepts:

- `wasm`: a `URL`, `ArrayBuffer`, or `Uint8Array`.
- `highlights` / `injections` / `locals`: either a raw string or a `URL` —
  the runtime reads `file:` URLs off disk under Node and `fetch`es
  everything else.

The bundled `GRAMMARS` entries use URLs for all of those fields, so listing
every grammar costs only a few bytes of eager metadata; the bytes don't
load until you call `loadGrammar`.

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

## Bundle size

Because `GRAMMARS` names every language statically, a naïve rspack/webpack
build will emit every grammar's `.wasm` + `.scm` (around 3 MB total).
Bundlers that tree-shake based on referenced entries will only pull in
the grammars you actually load; otherwise expect the full asset set.

## Architecture

```
┌─────────────────────────────────┐
│ web-tree-sitter.wasm            │   MAIN_MODULE=2, upstream tree-sitter.
│                                 │   Ships the C runtime once (~230 KB),
│                                 │   plus the packed-table decoder.
└──────────────▲──────────────────┘
               │ loadWebAssemblyModule
       ┌───────┴────────┐
       │                │
┌──────┴──────────┐  ┌──┴──────────────────────────────┐
│ tree-sitter-    │  │ arborium_emscripten_runtime.wasm │
│ <grammar>.wasm  │  │  (this package)                  │
│ one per grammar │  │  one shared copy                 │
└─────────────────┘  └──────────────────────────────────┘
   packed tables,      session + query execution in Rust
   lexers; scanner
```

Each grammar's parse tables and lexers ship as a compact entropy-coded blob
(see `lib/packed/` in the repo root) that the host expands into a regular
`TSLanguage` the first time the grammar is loaded, and its lexers run in a
shared interpreter in the host; only external scanners remain compiled into
grammar modules. The expanded tables are byte-for-byte what
`tree-sitter generate` produced and the lexers behave identically to the
generated ones, which the build verifies for every grammar.

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

## API shape

| Symbol                  | What                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `loadArboriumRuntime`   | Load the host + arborium SIDE_MODULE; returns a `Runtime`.              |
| `GRAMMARS`              | Eager map of every bundled grammar keyed by language id.                |
| `Runtime.loadGrammar`   | Load a grammar SIDE_MODULE, register it, return a `Grammar`.            |
| `Grammar.createSession` | Open a session against this grammar.                                    |
| `Grammar.unregister`    | Tear down the grammar + all its live sessions.                          |
| `Session.setText`       | Replace the session's text. Triggers a parse.                           |
| `Session.parse`         | Return the current `Utf16ParseResult`.                                  |
| `Session.highlightToHtml` / `highlightToSpans` | Full highlight pipeline output.                  |
| `Session.cancel`        | Cancel an in-flight parse.                                              |
| `Session.free`          | Release the session.                                                    |
| `ArboriumError`         | Thrown on registration / parse / asset-fetch errors. Has `.kind`.       |

Type exports (`Utf16Span`, `Utf16Injection`, `Utf16ParseResult`,
`ThemedSpan`, `HtmlFormat`, `Edit`, `ArboriumErrorKind`,
`ArboriumGrammarPackage`, `BundledGrammarId`, `AvailableLanguage`,
`HostModule`, `HostModuleFactory`, `RuntimeAbi`, `WasmSource`) are
available from the package root. All offsets in `Utf16ParseResult` are
UTF-16 code-unit indices, compatible with `String.prototype.slice`.

## Custom grammars

`loadGrammar` also accepts a hand-assembled `LoadGrammarOptions` if you
want to load a grammar that isn't in `GRAMMARS`. The `wasm` field takes
a `URL`, `ArrayBuffer`, or `Uint8Array`; the query fields take either
raw strings or `URL`s.

```ts
const grammar = await runtime.loadGrammar({
    languageId: 'custom',
    wasm: new URL('./my-grammar.wasm', import.meta.url),
    highlights: await fetch('./highlights.scm').then((r) => r.text()),
});
```

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
[`lib/wasm/src/lib.rs`](../../lib/wasm/src/lib.rs) — pointer ownership rules,
return codes, and per-function contracts.

## License

MIT
