// Low-level types + helpers for the arborium-rt ABI surface.
//
// Every `arborium_rt_*` symbol exported from the runtime SIDE_MODULE is
// described here as a TypeScript function signature (ABI.runtime). Callers
// shouldn't use these directly — the Runtime/Grammar/Session classes wrap
// them — but the types are exported for consumers that need to bypass the
// wrapper.

/** ABI version this package targets. Must match `ABI_VERSION` in src/lib.rs. */
export const ABI_VERSION = 1;

/**
 * Minimal subset of the Emscripten MAIN_MODULE surface we rely on. The host
 * wasm built by `scripts/build-host-wasm.sh` ships all of these via
 * `EXPORTED_RUNTIME_METHODS` (see that script for the full list emcc keeps
 * alive).
 *
 * Intentionally not depending on `@types/emscripten` — the surface we use is
 * small and stable, and pinning it here keeps the type story self-contained.
 */
export interface HostModule {
    /** Load a SIDE_MODULE wasm into the host; returns its exports. */
    loadWebAssemblyModule(
        binary: ArrayBuffer | Uint8Array | WebAssembly.Module,
        options: { loadAsync: true },
    ): Promise<Record<string, (...args: number[]) => number | void>>;
    /** Allocate `n` bytes in the shared linear heap. */
    _malloc(size: number): number;
    /** Free a pointer previously returned from `_malloc` / emscripten's allocator. */
    _free(ptr: number): void;
    /** View into the shared linear heap. */
    HEAPU8: Uint8Array;
    /** Read an `i32` at `ptr`. */
    getValue(ptr: number, type: 'i32'): number;
    /** Write an `i32` at `ptr`. */
    setValue(ptr: number, value: number, type: 'i32'): void;
}

/** Factory produced by emscripten's `-sMODULARIZE -sEXPORT_ES6`. */
export type HostModuleFactory = (
    overrides?: Partial<HostModule>,
) => Promise<HostModule>;

/**
 * The raw C ABI the runtime SIDE_MODULE exposes. Each function is a plain
 * WebAssembly export — all pointers are `i32` offsets into the shared heap.
 */
export interface RuntimeAbi {
    /** Returns the ABI version the runtime was built against. */
    arborium_rt_abi_version(): number;
    /**
     * Register a grammar. `language` is a `*const TSLanguage` returned by the
     * grammar module's `tree_sitter_<name>()` export. `*_ptr` / `*_len`
     * describe UTF-8 query strings in shared memory (use 0/0 for unused).
     * Returns a non-zero grammar id on success, 0 on failure.
     */
    arborium_rt_register_grammar(
        language: number,
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
     * Parse and return a JSON-encoded `Utf16ParseResult` in shared memory.
     * On success: writes ptr into `*out_ptr`, length into `*out_len`, returns 0.
     * On failure: returns non-zero; outputs are untouched. Caller owns the
     * returned buffer and must free via `arborium_rt_free(ptr, len)`.
     */
    arborium_rt_parse_utf16(
        session_id: number,
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
    /** Runtime's `arborium_rt_abi_version()` didn't match the value this package targets. */
    | 'abi-mismatch'
    /** `arborium_rt_register_grammar` returned 0 (query compile failure or bad language ptr). */
    | 'grammar-registration-failed'
    /** `arborium_rt_create_session` returned 0 (unknown grammar id). */
    | 'session-creation-failed'
    /** `arborium_rt_parse_utf16` returned a non-zero status. */
    | 'parse-failed'
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

/**
 * A source for a SIDE_MODULE wasm. Accepts common wasm-loading shapes so
 * callers can `fetch()`, `fs.readFile()`, hand over a URL, or pass an
 * already-compiled `WebAssembly.Module`. `URL` and `Response` flow through
 * `WebAssembly.compileStreaming` inside {@link resolveWasm} (with `file:`
 * URLs falling back to `fs.readFile` under Node).
 */
export type WasmSource =
    | ArrayBuffer
    | Uint8Array
    | Response
    | URL
    | WebAssembly.Module
    | Promise<ArrayBuffer | Uint8Array | Response | URL | WebAssembly.Module>;

/**
 * Resolve a {@link WasmSource} to something `loadWebAssemblyModule` accepts:
 * either raw bytes (caller handed us bytes) or a `WebAssembly.Module`
 * (streaming-compiled from a `Response` / `URL`, so compile overlaps the
 * download).
 */
export async function resolveWasm(
    source: WasmSource,
): Promise<Uint8Array | WebAssembly.Module> {
    const resolved = await source;
    if (resolved instanceof WebAssembly.Module) return resolved;
    if (resolved instanceof URL) return resolveUrl(resolved);
    if (resolved instanceof Response) return compileResponse(resolved, resolved.url || 'wasm response');
    if (resolved instanceof Uint8Array) return resolved;
    return new Uint8Array(resolved);
}

async function resolveUrl(url: URL): Promise<Uint8Array | WebAssembly.Module> {
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
    return compileResponse(response, url.href);
}

async function compileResponse(
    response: Response,
    label: string,
): Promise<WebAssembly.Module> {
    try {
        return await WebAssembly.compileStreaming(Promise.resolve(response));
    } catch (err) {
        // `compileStreaming` rejects if the body MIME type isn't
        // `application/wasm`. The response body has already been consumed,
        // so we can't fall back to a buffered compile here — surface the
        // failure with context so the caller can fix the server config or
        // pre-buffer themselves.
        throw new ArboriumError(
            'wasm-fetch-failed',
            `WebAssembly.compileStreaming failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();
