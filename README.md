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
  (x64, arm64), linux gnu (x64, arm64), and win32 msvc (x64, arm64).

Both packages expose the same highlight pipeline over the same
target-agnostic `arborium-rt` Rust core and return structurally identical
result types, so they're interchangeable for highlighting.

> **Distribution.** Each release attaches the browser tarball and the
> per-platform Node `.node` binaries to a **GitHub Release** — install
> from there.

## Quick start

The fastest way to get started is to install the WASM package, which works
on both web and Node. Grab the `discord-arborium-rt-wasm-<version>.tgz`
tarball from the latest GitHub Release and install it:

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
for the full consumer API. To use the native Node module instead, see
[`packages/arborium-rt-node/README.md`](./packages/arborium-rt-node/README.md).

## Building from source

### Prerequisites

- `emcc`
- Rust Nightly
- Node >= 22, pnpm >= 9
- askalono
  - `cargo install --locked askalono-cli`
- Optional, Node only: C/C++ compiler

### Browser (wasm) package

```sh
git clone --recurse-submodules <this-repo>
cd arborium-rt
./scripts/arborium-rt bootstrap               # apply patches + render Cargo manifests
./scripts/arborium-rt build wasm runtime      # arborium_rt_wasm.wasm (SIDE_MODULE)
./scripts/arborium-rt build wasm host         # web-tree-sitter.{wasm,mjs}
./scripts/arborium-rt build wasm grammars     # build all grammars (browser)
./scripts/arborium-rt package wasm host       # stage host + runtime wasms into the wasm package
./scripts/arborium-rt package wasm grammars   # stage grammars + generate the GRAMMARS index
pnpm install
pnpm -r --filter='!@discord/arborium-rt-node' build
pnpm -r --filter='!@discord/arborium-rt-node' test
```

### Node native addon

Only needed to work on `@discord/arborium-rt-node`. Run after the steps above.

```sh
./scripts/arborium-rt build node grammars     # stage Node addon grammar sources
./scripts/arborium-rt build node              # link the statically-linked Node addon
pnpm --filter @discord/arborium-rt-node build
pnpm --filter @discord/arborium-rt-node test
```

Once both are built, `pnpm -r build && pnpm -r test` covers every package.

## License

MIT
