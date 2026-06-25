# @discord/arborium-rt

TypeScript package that dynamically links tree-sitter, arborium, and per-grammar
parser tables in the browser so each pays for itself exactly once.

See the repo root for the architectural story. This README covers consumer
usage.

## Install

```sh
npm install @discord/arborium-rt
```

The package ships three asset kinds alongside its compiled JS:
`dist/host/web-tree-sitter.{wasm,mjs}` (the MAIN_MODULE tree-sitter C runtime
rebuilt with the plain `ts_*` exports + libc/pthread surface arborium-rt's
SIDE_MODULEs import), `dist/runtime/arborium_emscripten_runtime.wasm` (the
arborium-rt SIDE_MODULE), and `dist/grammars/<lang>/{tree-sitter-<lang>.wasm, *.scm}`
(one subdir per bundled language).

## Usage

```ts
import { GRAMMARS, loadArboriumRuntime } from '@discord/arborium-rt';

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

## Bundle size

Because `GRAMMARS` names every language statically, a naïve rspack/webpack
build will emit every grammar's `.wasm` + `.scm` (around 160 MB total).
Bundlers that tree-shake based on referenced entries will only pull in
the grammars you actually load; otherwise expect the full asset set.

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

## License

MIT.
