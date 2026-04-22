# @appellation/arborium-rt

TypeScript package that dynamically links tree-sitter, arborium, and per-grammar
parser tables in the browser so each pays for itself exactly once.

See the repo root for the architectural story. This README covers consumer
usage.

## Install

```sh
npm install @appellation/arborium-rt
```

The package ships three wasm/mjs assets alongside its compiled JS:
`dist/host/web-tree-sitter.{wasm,mjs}` (the MAIN_MODULE tree-sitter C runtime
rebuilt with the plain `ts_*` exports + libc/pthread surface arborium-rt's
SIDE_MODULEs import) and `dist/runtime/arborium_emscripten_runtime.wasm`.

## Usage

```ts
import { loadArboriumRuntime } from '@appellation/arborium-rt';

const runtime = await loadArboriumRuntime();

const grammar = await runtime.loadGrammar({
    wasm: fetch('https://.../tree-sitter-rust.wasm'),
    highlights: await fetch('.../rust/highlights.scm').then((r) => r.text()),
});

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
(Vite, webpack, esbuild) trace those specifiers so the wasm assets are
copied automatically into the consumer's build.

`wasm` on `loadGrammar` accepts anything fetchable: `ArrayBuffer`,
`Uint8Array`, `Response`, `URL`, or a `Promise` of any of those — use
whatever your environment makes easy.

## API shape

| Symbol                | What                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `loadArboriumRuntime` | Load the host + runtime; returns a `Runtime`. Checks ABI version.  |
| `Runtime.loadGrammar` | Load a grammar SIDE_MODULE, register it, return a `Grammar`.       |
| `Grammar.createSession` | Open a session against this grammar.                             |
| `Grammar.unregister`  | Tear down the grammar + all its live sessions.                     |
| `Session.setText`     | Replace the session's text. Triggers a parse.                      |
| `Session.parse`       | Return the current `Utf16ParseResult`.                             |
| `Session.cancel`      | Cancel an in-flight parse.                                         |
| `Session.free`        | Release the session.                                               |
| `ArboriumError`       | Thrown on ABI mismatch / registration / parse errors. Has `.kind`. |

Type exports (`Utf16Span`, `Utf16Injection`, `Utf16ParseResult`, `Edit`,
`ArboriumErrorKind`, `HostModule`, `HostModuleFactory`, `RuntimeAbi`,
`WasmSource`) are available from the package root. All offsets in
`Utf16ParseResult` are UTF-16 code-unit indices, compatible with
`String.prototype.slice`.

## Grammar source

Grammars ship as separate packages (`@appellation/arborium-rt-<lang>`) whose default
export is an `ArboriumGrammarPackage`. The object is structurally
assignable to `loadGrammar`'s input, so no glue code is needed:

```ts
import jsonGrammar from '@appellation/arborium-rt-json';
const grammar = await runtime.loadGrammar(jsonGrammar);
```

Each grammar package ships:

- `tree-sitter-<lang>.wasm` — SIDE_MODULE parser tables.
- `highlights.scm` (+ optional `injections.scm`, `locals.scm`) — flattened
  with any inherited queries prepended.
- `index.js` — default-exports `{ languageId, languageExport, wasm: URL,
  highlights, ... }`. The `wasm` URL is resolved against `import.meta.url`
  so bundlers handle asset copying automatically.

`loadGrammar` accepts `wasm` as a `URL` in addition to bytes/Response —
it'll `fetch` for `http(s):` URLs and `fs.readFile` for `file:` URLs under
Node. Consumers that want to pre-fetch or supply bytes directly can still
do so.

This package also ships the `arborium-rt` dev CLI (`bin` entry in
`package.json`) used to build grammars + generate these packages. See
the repo root for commands: `./scripts/arborium-rt --help`.

## License

MIT.
