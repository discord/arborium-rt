# arborium-rt playground

A small private Vite app for trying out `@discord/arborium-rt-wasm`
highlighting in a real browser. Pick a grammar, paste code, and see what the
runtime produces.

- **Output**: themed spans rendered by the page (hover a token to see its tag
  and UTF-16 range), or the runtime's own `highlightToHtml` in either the
  custom-element or class-name format.
- **Injections**: grammars named in `missingInjections` are loaded on demand
  and the document is highlighted again. Fence aliases such as `js`, `py`, and
  `sh` map to bundled grammars (the `ALIASES` table in `src/main.ts`). Names
  that still can't be resolved are listed in the stats bar.
- **Stats**: highlight time, span count, `fuelUsed`, `outOfFuelLanguages`, and
  which grammars are registered.
- **Copy link**: puts the language and code in the URL hash so you can share a
  repro. The last session is also saved in `localStorage`.

## Running

The site uses the workspace copy of `@discord/arborium-rt-wasm`, so that
package's `dist/` must be built first (see the root `CLAUDE.md` for toolchain
prereqs):

```sh
./scripts/arborium-rt build wasm runtime
./scripts/arborium-rt build wasm host
./scripts/arborium-rt build wasm grammars            # or a subset: json markdown …
./scripts/arborium-rt package wasm grammars          # same ids as above
./scripts/arborium-rt package wasm host
pnpm --filter @discord/arborium-rt-wasm build

pnpm --filter @discord/arborium-rt-site dev          # http://localhost:5173
```

`pnpm --filter @discord/arborium-rt-site bundle` produces a static build in
`site/dist/` (`preview` serves it). The script is called `bundle` rather than
`build` so that `pnpm -r build` in CI skips the site.
