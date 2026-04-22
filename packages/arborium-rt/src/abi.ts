// Low-level types + helpers for the arborium-rt ABI surface.
//
// Every `arborium_rt_*` symbol exported from the runtime SIDE_MODULE is
// described here as a TypeScript function signature (RuntimeAbi). Callers
// shouldn't use these directly — the Runtime/Grammar/Session classes wrap
// them — but the types are exported for consumers that need to bypass the
// wrapper.

/// <reference types="emscripten" />

/**
 * The MAIN_MODULE host surface. Extends the upstream `EmscriptenModule`
 * interface with the two bits we rely on that aren't part of the base type:
 *
 * - `loadWebAssemblyModule` — MAIN_MODULE-specific loader that instantiates a
 *   SIDE_MODULE wasm against the host's linear memory and returns its exports.
 * - `getValue` — module-level runtime method exported via
 *   `EXPORTED_RUNTIME_METHODS` (already declared as a global by
 *   `@types/emscripten`; we pin it onto the module shape so call sites go
 *   through `host.getValue(...)`).
 */
export interface HostModule extends EmscriptenModule {
    loadWebAssemblyModule(
        binary: Uint8Array,
        options: { loadAsync: true },
    ): Promise<Record<string, (...args: number[]) => number | void>>;
    getValue: typeof getValue;
}

/** Factory produced by emscripten's `-sMODULARIZE -sEXPORT_ES6`. */
export type HostModuleFactory = EmscriptenModuleFactory<HostModule>;

/**
 * The raw C ABI the runtime SIDE_MODULE exposes. Each function is a plain
 * WebAssembly export — all pointers are `i32` offsets into the shared heap.
 */
export interface RuntimeAbi {
    /**
     * Register a grammar. `language` is a `*const TSLanguage` returned by the
     * grammar module's `tree_sitter_<name>()` export. `name_ptr` / `name_len`
     * describe the language name (used for injection lookups — must be
     * non-empty). `*_ptr` / `*_len` for queries describe UTF-8 strings in
     * shared memory (use 0/0 for unused). Returns a non-zero grammar id on
     * success, 0 on failure.
     */
    arborium_rt_register_grammar(
        language: number,
        name_ptr: number,
        name_len: number,
        highlights_ptr: number,
        highlights_len: number,
        injections_ptr: number,
        injections_len: number,
        locals_ptr: number,
        locals_len: number,
    ): number;
    arborium_rt_unregister_grammar(grammar_id: number): void;
    arborium_rt_create_session(grammar_id: number): number;
    arborium_rt_free_session(session_id: number): void;
    arborium_rt_set_text(session_id: number, text_ptr: number, text_len: number): void;
    arborium_rt_cancel(session_id: number): void;
    /**
     * Raw parse. Writes a JSON-encoded `Utf16ParseResult` into shared memory;
     * on success returns 0 and populates `*out_ptr` / `*out_len`. Caller
     * owns the buffer and must free it via `arborium_rt_free`.
     */
    arborium_rt_parse_utf16(
        session_id: number,
        out_ptr_slot: number,
        out_len_slot: number,
    ): number;
    /**
     * Full highlight pipeline: parse + recursive injection resolution +
     * dedup + coalesce + theming. Writes a JSON-encoded
     * `{ spans: ThemedSpan[] }` with UTF-16 offsets into shared memory.
     * Caller owns the buffer and must free it via `arborium_rt_free`.
     *
     * `max_injection_depth` of 0 disables injection recursion (only the
     * primary grammar's captures are returned).
     */
    arborium_rt_highlight_to_spans_utf16(
        session_id: number,
        max_injection_depth: number,
        out_ptr_slot: number,
        out_len_slot: number,
    ): number;
    /**
     * Full highlight pipeline, rendered straight to HTML. `format` selects
     * the markup style (see `HtmlFormat` in types.ts / `highlight.rs`).
     * Caller owns the buffer and must free it via `arborium_rt_free`.
     */
    arborium_rt_highlight_to_html(
        session_id: number,
        max_injection_depth: number,
        format: number,
        prefix_ptr: number,
        prefix_len: number,
        out_ptr_slot: number,
        out_len_slot: number,
    ): number;
    arborium_rt_free(ptr: number, len: number): void;
}

/**
 * Error shape for the runtime's well-defined failure modes. Thrown by the
 * high-level wrappers; callers that want to discriminate can switch on
 * `.kind`.
 */
export class ArboriumError extends Error {
    readonly kind: ArboriumErrorKind;
    constructor(kind: ArboriumErrorKind, message: string) {
        super(message);
        this.name = 'ArboriumError';
        this.kind = kind;
    }
}

export type ArboriumErrorKind =
    /** `arborium_rt_register_grammar` returned 0 (query compile failure, bad language ptr, or empty name). */
    | 'grammar-registration-failed'
    /** `arborium_rt_create_session` returned 0 (unknown grammar id). */
    | 'session-creation-failed'
    /** `arborium_rt_parse_utf16` returned a non-zero status. */
    | 'parse-failed'
    /** `arborium_rt_highlight_*` returned a non-zero status. */
    | 'highlight-failed'
    /** Grammar SIDE_MODULE didn't export a `tree_sitter_*` function. */
    | 'grammar-language-export-missing'
    /** Couldn't resolve a `URL` WasmSource (fetch failed, or file read failed). */
    | 'wasm-fetch-failed';

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/**
 * Copy a JS string into the shared linear heap as UTF-8. Returns
 * `[ptr, byteLength]`; the caller owns `ptr` and must release it via
 * `Module._free(ptr)`.
 *
 * Returns `[0, 0]` for empty strings — the runtime treats null+0 as an empty
 * query/text, so there's no need to allocate.
 */
export function putUtf8(module: HostModule, s: string): readonly [number, number] {
    if (s.length === 0) return [0, 0];
    const bytes = encoder.encode(s);
    const ptr = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, ptr);
    return [ptr, bytes.length];
}

/**
 * Decode a UTF-8 buffer at `[ptr, len]` in shared memory into a JS string.
 * Does NOT free the buffer — the caller decides ownership.
 */
export function readUtf8(module: HostModule, ptr: number, len: number): string {
    if (len === 0) return '';
    return decoder.decode(module.HEAPU8.subarray(ptr, ptr + len));
}

// ---------------------------------------------------------------------------
// Wasm loading
// ---------------------------------------------------------------------------

/**
 * A source for a SIDE_MODULE wasm. `URL` covers the common case — generated
 * grammar packages emit `new URL('./tree-sitter-<lang>.wasm', import.meta.url)`
 * — while the byte variants let callers pre-fetch or hand-assemble the buffer.
 */
export type WasmSource = URL | ArrayBuffer | Uint8Array;

/** Resolve a {@link WasmSource} to the bytes `loadWebAssemblyModule` expects. */
export async function resolveWasm(source: WasmSource): Promise<Uint8Array> {
    if (source instanceof URL) return fetchWasm(source);
    if (source instanceof Uint8Array) return source;
    return new Uint8Array(source);
}

async function fetchWasm(url: URL): Promise<Uint8Array> {
    if (url.protocol === 'file:') {
        // `fetch(file:)` is unsupported in Node's global fetch as of v22; the
        // generated grammar packages always emit `new URL('./x.wasm',
        // import.meta.url)`, which is `file:` under Node and `http(s):` in
        // browsers. Gate the fs import so bundlers can skip it — only
        // executed when a file: URL is actually encountered.
        const { readFile } = await import(
            /* @vite-ignore */ /* webpackIgnore: true */ 'node:fs/promises'
        );
        const buf = await readFile(url);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new ArboriumError(
            'wasm-fetch-failed',
            `failed to fetch ${url.href}: ${response.status} ${response.statusText}`,
        );
    }
    return new Uint8Array(await response.arrayBuffer());
}

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();
