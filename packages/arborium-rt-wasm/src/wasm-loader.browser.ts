// Browser variant of `wasm-loader.ts`. Selected via the `"browser"`
// condition on `#wasm-loader` in package.json's `imports` field, so the
// Node `fs` import in the default module never lands in a browser build.
//
// In browsers, `new URL('./x.wasm', import.meta.url)` resolves to
// `http(s):` / `blob:` — `file:` URLs don't appear — so there's nothing
// to read off the filesystem and everything falls through to `fetch()`.

export async function readLocalWasm(_url: URL): Promise<Uint8Array | null> {
	return null;
}
