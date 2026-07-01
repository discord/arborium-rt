# @discord/arborium-rt-node

TypeScript package that statically links tree-sitter, arborium, and **every**
per-grammar parser/scanner into one native Node.js addon — no wasm host, no
dynamic grammar loading, no assets to trace.

See the repo root for the architectural story. This README covers consumer
usage.

## Install

Grab the platform-appropriate `.node` binary and the package from the latest
GitHub Release. The napi-rs loader picks the correct binary for the running
platform automatically. Prebuilt binaries ship for:

- darwin `x64`, `arm64`
- linux gnu `x64`, `arm64`
- win32 `x64` (msvc)

Each is published as a `@discord/arborium-rt-node-<platform>` optional
dependency, gated by `os`/`cpu`/`libc` so only the matching one installs.

## Usage

```ts
import {
    availableLanguages,
    highlightToHtml,
    highlightToSpans,
    Session,
} from '@discord/arborium-rt-node';

// One-shot: language id + text → themed spans (offsets are UTF-16).
const { spans } = highlightToSpans('json', '[1, 2, 3]');
// spans: [{ start, end, tag }, ...]

// Or straight to HTML.
const { html } = highlightToHtml('json', '[1, 2, 3]');

// Or a reusable session for one document.
const session = new Session('typescript');
try {
    session.setText('const x = 1;');
    const out = session.highlightToHtml({ maxInjectionDepth: 3 });
} finally {
    session.free(); // also released on GC
}

availableLanguages(); // -> sorted list of bundled grammar ids
```

Unlike the browser package there is no `loadArboriumRuntime` / `loadGrammar`
step: every grammar is compiled into the addon, so you name the language by
id directly. `highlightToSpans` / `highlightToHtml` throw if the id isn't a
bundled grammar (see `availableLanguages`).

The `format` / `maxInjectionDepth` options and the `ThemedSpan` /
`HighlightSpansResult` / `HighlightHtmlResult` result shapes match
`@discord/arborium-rt-wasm`, so highlighting code ports between the two by
swapping the import and the grammar-loading step. `maxInjectionDepth`
defaults to `3` and is capped at `32` internally.

`highlightToHtml` accepts a `format` option — `custom-elements` (default,
compact `<a-k>…</a-k>`), `class-names` (`<span class="keyword">…</span>`),
or either with a prefix to avoid collisions.

## API shape

| Symbol                      | What                                                              |
| --------------------------- | ----------------------------------------------------------------- |
| `availableLanguages`        | Sorted list of every bundled grammar id.                          |
| `highlightToSpans`          | One-shot: language + text → themed spans.                         |
| `highlightToHtml`           | One-shot: language + text → rendered HTML string.                 |
| `Session`                   | Reusable parse session for one document.                          |
| `Session.setText`           | Replace the session's text.                                       |
| `Session.parse`             | Return the raw `ParseResult` (captures + injection points).       |
| `Session.highlightToSpans` / `highlightToHtml` | Full highlight pipeline output.                |
| `Session.cancel`            | Cancel an in-flight parse.                                        |
| `Session.free`              | Release the session (also released on GC).                        |

Type exports (`ThemedSpan`, `ParseSpan`, `ParseInjection`, `ParseResult`,
`HighlightOptions`, `HighlightToHtmlOptions`, `HighlightSpansResult`,
`HighlightHtmlResult`, `HtmlFormat`) are available from the package root.
All offsets are UTF-16 code-unit indices, compatible with
`String.prototype.slice`.

## License

MIT.
