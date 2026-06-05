// Node-default WASM source helper. Paired with `wasm-loader.browser.ts`;
// the two are swapped via the `"#wasm-loader"` entry in the package's
// `imports` field (with a `"browser"` condition). Keeping the Node `fs`
// touch isolated here means `abi.ts` has no Node-specific imports for
// bundlers to trace.

/**
 * Read a `file:` URL off the local filesystem. Returns `null` for any other
 * protocol so the caller can fall through to `fetch()`.
 *
 * `fetch(file:)` is unsupported in Node's global fetch as of v22; the
 * generated grammar packages always emit `new URL('./x.wasm',
 * import.meta.url)`, which is `file:` under Node and `http(s):` in
 * browsers.
 */
export async function readLocalWasm(url: URL): Promise<Uint8Array | null> {
	if (url.protocol !== "file:") return null;
	const { readFile } = await import("node:fs/promises");
	const buf = await readFile(url);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
