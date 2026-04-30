// High-level wrapper classes over the arborium-rt ABI.

import {
    ArboriumError,
    putUtf8,
    readUtf8,
    resolveText,
    resolveWasm,
    type HostModule,
    type HostModuleFactory,
    type RuntimeAbi,
    type WasmSource,
} from './abi.js';
import type {
    HtmlFormat,
    HtmlHighlightResult,
    ThemedHighlightResult,
    ThemedSpan,
    Utf16ParseResult,
} from './types.js';

/**
 * Load the host wasm and the arborium-rt SIDE_MODULE into it. Both assets ship
 * inside this package (`dist/host/` and `dist/runtime/`) and are resolved
 * relative to the compiled module — bundlers trace the specifiers, Node
 * resolves them directly. Host + SIDE_MODULE are versioned together at
 * publish time, so no runtime version check is performed.
 */
export async function loadArboriumRuntime(): Promise<Runtime> {
    const factory = await loadBundledHostModuleFactory();
    // The host is built with `-sENVIRONMENT=web,worker`, which drops the
    // Node branch (and therefore the `await import("module")` that breaks
    // rspack/webpack static analysis). That leaves the loader expecting to
    // fetch its companion wasm off the script URL — we pre-fetch via our
    // own `resolveWasm` so both Node (`file:` URL) and web (`http(s):`)
    // paths go through the same bytes-in-hand route.
    const [hostWasm, runtimeBytes] = await Promise.all([
        resolveWasm(new URL('./host/web-tree-sitter.wasm', import.meta.url)),
        resolveWasm(new URL('./runtime/arborium_emscripten_runtime.wasm', import.meta.url)),
    ]);
    // `@types/emscripten` types `wasmBinary` as `ArrayBuffer`, but the
    // emscripten runtime accepts any ArrayBuffer-like and wraps it through
    // `new Uint8Array(...)` — passing our `Uint8Array` directly avoids
    // slicing-out the buffer range when `resolveWasm` returns a view with
    // a non-zero offset (happens under Node's `fs.readFile`).
    const host = await factory({ wasmBinary: hostWasm as unknown as ArrayBuffer });
    const abi = (await host.loadWebAssemblyModule(runtimeBytes, {
        loadAsync: true,
    })) as unknown as RuntimeAbi;
    return new Runtime(host, abi);
}

/** Options for {@link Runtime.loadGrammar}. */
export interface LoadGrammarOptions {
    /** Bytes / URL of `tree-sitter-<lang>.wasm` (SIDE_MODULE=2). */
    wasm: WasmSource;
    /**
     * Language name used to resolve injections — the string that appears in
     * other grammars' `injections.scm` as `@injection.language`. Must be
     * non-empty; the runtime rejects registrations with empty names.
     *
     * When feeding an {@link ArboriumGrammarPackage}, prefer `languageId`
     * from the package directly — the structural assignability makes this
     * field flow through without a manual map.
     */
    languageId: string;
    /**
     * `highlights.scm` content — either the text itself or a URL pointing
     * at it. Required; a grammar with no highlights is useless. Bundled
     * grammars expose this as `new URL('./.../highlights.scm', import.meta.url)`.
     */
    highlights: string | URL;
    /** `injections.scm`, if the grammar supports language injection. */
    injections?: string | URL;
    /** `locals.scm`, if the grammar uses local-scope queries. */
    locals?: string | URL;
    /**
     * Name of the grammar's `tree_sitter_<lang>()` export. If omitted, the
     * loader auto-detects by scanning the module's exports for a single
     * function starting with `tree_sitter_`.
     */
    languageExport?: string;
}

/**
 * Stable shape for each entry in the bundled `GRAMMARS` map exported from
 * `@discord/arborium-rt/grammars`. Any object matching this interface is
 * structurally assignable to {@link LoadGrammarOptions}, so it can be
 * handed straight to {@link Runtime.loadGrammar}.
 *
 * Asset fields (`wasm`, `highlights`, `injections`, `locals`) are URLs
 * pointing at the per-grammar files shipped inside this package — they're
 * fetched lazily when `loadGrammar` runs, so listing every grammar in the
 * map costs only a few bytes of eager metadata per language.
 */
export interface ArboriumGrammarPackage {
    /** Grammar id from `arborium.yaml` (e.g. `"json"`, `"typescript"`). */
    languageId: string;
    /** Symbol the grammar wasm exports (always `"tree_sitter_<languageId>"`). */
    languageExport: string;
    /** URL to the grammar SIDE_MODULE wasm, resolved against the grammars module. */
    wasm: URL;
    /** URL to the flattened `highlights.scm` (prepend chain + own). */
    highlights: URL;
    /** URL to the flattened `injections.scm`, if the grammar defines one. */
    injections?: URL;
    /** URL to the flattened `locals.scm`, if the grammar defines one. */
    locals?: URL;
}

/** Options shared by the highlight-pipeline entry points on {@link Session}. */
export interface HighlightOptions {
    /**
     * How deep to follow language injections. `0` disables recursion —
     * only the primary grammar's captures are considered. The runtime
     * caps this at 32 internally regardless of what you pass.
     *
     * Defaults to `3`, matching `arborium_highlight::HighlightConfig`.
     */
    maxInjectionDepth?: number;
}

/** Options for {@link Session.highlightToHtml}. Adds an output-format selector. */
export interface HighlightToHtmlOptions extends HighlightOptions {
    /** HTML markup style. Defaults to `{ kind: 'custom-elements' }`. */
    format?: HtmlFormat;
}

/** Result from {@link Session.highlightToSpans} including any missing injection grammars. */
export interface HighlightSpansResult {
    /** The themed spans with UTF-16 offsets. */
    spans: ThemedSpan[];
    /**
     * Languages referenced by injection queries but not loaded in the registry.
     * If non-empty, the caller may want to load these grammars and retry.
     */
    missingInjections: string[];
    /**
     * Language names whose parse exceeded the runtime's per-call wall-clock
     * query budget (~100 ms, enforced inside the QueryCursor's hot loop)
     * before the cursor finished. Empty when nothing timed out. When
     * non-empty, `spans` contains whatever the cursor produced before the
     * budget expired — partial output.
     *
     * The list is per-language because injections highlight independently:
     * highlighting markdown that injects a kotlin code block can produce
     * `["kotlin"]` (kotlin's chain-bomb-shaped query timed out) while the
     * markdown frame around it completed normally. Use the language to
     * tag metrics, render a per-grammar "interrupted" badge, or fall back
     * an alternate highlighter only for the affected language.
     *
     * Sorted, deduplicated.
     */
    timedOutLanguages: string[];
}

/** Result from {@link Session.highlightToHtml} including any missing injection grammars. */
export interface HighlightHtmlResult {
    /** The rendered HTML string. */
    html: string;
    /**
     * Languages referenced by injection queries but not loaded in the registry.
     * If non-empty, the caller may want to load these grammars and retry.
     */
    missingInjections: string[];
    /** See {@link HighlightSpansResult.timedOutLanguages}. */
    timedOutLanguages: string[];
}

/**
 * A loaded arborium runtime. One per host module. Manages zero or more
 * {@link Grammar}s, each of which can spawn zero or more {@link Session}s.
 */
export class Runtime {
    /** The underlying host module — exposed for consumers that need raw access. */
    readonly host: HostModule;
    /** Raw ABI exports — exposed for debugging / advanced use. */
    readonly abi: RuntimeAbi;

    /** @internal */
    constructor(host: HostModule, abi: RuntimeAbi) {
        this.host = host;
        this.abi = abi;
    }

    /** Register a grammar. Returns a {@link Grammar} handle. */
    async loadGrammar(options: LoadGrammarOptions): Promise<Grammar> {
        if (!options.languageId) {
            throw new ArboriumError(
                'grammar-registration-failed',
                'loadGrammar: languageId is required (must match the name referenced by injection queries)',
            );
        }
        // Pull wasm bytes + query text concurrently — each can be a URL that
        // needs fetching, and they're independent of each other.
        const [grammarBytes, highlights, injections, locals] = await Promise.all([
            resolveWasm(options.wasm),
            resolveText(options.highlights),
            options.injections === undefined ? '' : resolveText(options.injections),
            options.locals === undefined ? '' : resolveText(options.locals),
        ]);
        const grammarExports = await this.host.loadWebAssemblyModule(grammarBytes, {
            loadAsync: true,
        });
        const languageFn = pickLanguageExport(grammarExports, options.languageExport);
        const langPtr = (languageFn as () => number)();
        if (!langPtr) {
            throw new ArboriumError(
                'grammar-registration-failed',
                'grammar tree_sitter_* export returned null',
            );
        }
        const [nPtr, nLen] = putUtf8(this.host, options.languageId);
        const [hPtr, hLen] = putUtf8(this.host, highlights);
        const [iPtr, iLen] = putUtf8(this.host, injections);
        const [lPtr, lLen] = putUtf8(this.host, locals);
        let grammarId = 0;
        try {
            grammarId = this.abi.arborium_rt_register_grammar(
                langPtr,
                nPtr, nLen,
                hPtr, hLen,
                iPtr, iLen,
                lPtr, lLen,
            );
        } finally {
            if (nPtr) this.host._free(nPtr);
            if (hPtr) this.host._free(hPtr);
            if (iPtr) this.host._free(iPtr);
            if (lPtr) this.host._free(lPtr);
        }
        if (grammarId === 0) {
            throw new ArboriumError(
                'grammar-registration-failed',
                'arborium_rt_register_grammar returned 0 (query compile failure, bad language ptr, or empty name?)',
            );
        }
        return new Grammar(this, grammarId, langPtr, options.languageId);
    }
}

/**
 * A registered grammar. Spawn sessions with {@link Grammar.createSession}.
 * Call {@link Grammar.unregister} when done; any sessions still open are torn
 * down as part of unregistration.
 */
export class Grammar {
    readonly runtime: Runtime;
    readonly id: number;
    /** The `*const TSLanguage` this grammar owns in shared memory. */
    readonly languagePtr: number;
    /** Language name the grammar was registered under (injection lookup key). */
    readonly languageId: string;
    #unregistered = false;

    /** @internal */
    constructor(runtime: Runtime, id: number, languagePtr: number, languageId: string) {
        this.runtime = runtime;
        this.id = id;
        this.languagePtr = languagePtr;
        this.languageId = languageId;
    }

    createSession(): Session {
        this.#assertLive();
        const sessionId = this.runtime.abi.arborium_rt_create_session(this.id);
        if (sessionId === 0) {
            throw new ArboriumError(
                'session-creation-failed',
                `arborium_rt_create_session(${this.id}) returned 0`,
            );
        }
        return new Session(this, sessionId);
    }

    unregister(): void {
        if (this.#unregistered) return;
        this.runtime.abi.arborium_rt_unregister_grammar(this.id);
        this.#unregistered = true;
    }

    #assertLive(): void {
        if (this.#unregistered) {
            throw new ArboriumError(
                'grammar-registration-failed',
                `grammar ${this.id} has been unregistered`,
            );
        }
    }
}

/**
 * A parser session — a per-document stream of `setText`/`parse` calls.
 * Sessions are cheap; create one per document/viewer. Always {@link Session.free}
 * when done, or call {@link Grammar.unregister} to tear down en masse.
 */
export class Session {
    readonly grammar: Grammar;
    readonly id: number;
    #freed = false;

    /** @internal */
    constructor(grammar: Grammar, id: number) {
        this.grammar = grammar;
        this.id = id;
    }

    setText(text: string): void {
        this.#assertLive();
        const [ptr, len] = putUtf8(this.grammar.runtime.host, text);
        try {
            this.grammar.runtime.abi.arborium_rt_set_text(this.id, ptr, len);
        } finally {
            if (ptr) this.grammar.runtime.host._free(ptr);
        }
    }

    /** Raw parse — returns primary-grammar spans + injection points only. */
    parse(): Utf16ParseResult {
        this.#assertLive();
        return this.#withJsonOutput(
            'parse-failed',
            (outPtr, outLen) =>
                this.grammar.runtime.abi.arborium_rt_parse_utf16(this.id, outPtr, outLen),
            (json) =>
                (json.length === 0
                    ? { spans: [], injections: [], timed_out: false }
                    : (JSON.parse(json) as Utf16ParseResult)),
        );
    }

    /**
     * Full highlight pipeline as themed spans: parse + recursive injection
     * resolution + dedup + coalesce + capture→tag mapping, UTF-16 offsets.
     *
     * Returns both the spans and any languages that were referenced by injection
     * queries but not loaded. The caller can check `missingInjections` and decide
     * whether to load those grammars and retry.
     */
    highlightToSpans(options: HighlightOptions = {}): HighlightSpansResult {
        this.#assertLive();
        const depth = options.maxInjectionDepth ?? 3;
        const result = this.#withJsonOutput(
            'highlight-failed',
            (outPtr, outLen) =>
                this.grammar.runtime.abi.arborium_rt_highlight_to_spans_utf16(
                    this.id,
                    depth,
                    outPtr,
                    outLen,
                ),
            (json) => {
                if (json.length === 0) {
                    return { spans: [], missing_injections: [], timed_out_languages: [] };
                }
                return JSON.parse(json) as ThemedHighlightResult;
            },
        );

        return {
            spans: result.spans,
            missingInjections: result.missing_injections,
            timedOutLanguages: result.timed_out_languages,
        };
    }

    /**
     * Full highlight pipeline rendered straight to HTML. Matches
     * `arborium_highlight::spans_to_html` output byte-for-byte for the same
     * format + source.
     *
     * Returns both the HTML and any languages that were referenced by injection
     * queries but not loaded. The caller can check `missingInjections` and decide
     * whether to load those grammars and retry.
     */
    highlightToHtml(options: HighlightToHtmlOptions = {}): HighlightHtmlResult {
        this.#assertLive();
        const depth = options.maxInjectionDepth ?? 3;
        const format = options.format ?? { kind: 'custom-elements' };
        const { host } = this.grammar.runtime;
        const { code, prefix } = encodeHtmlFormat(format);
        const [prefixPtr, prefixLen] = putUtf8(host, prefix);
        try {
            const result = this.#withJsonOutput(
                'highlight-failed',
                (outPtr, outLen) =>
                    this.grammar.runtime.abi.arborium_rt_highlight_to_html(
                        this.id,
                        depth,
                        code,
                        prefixPtr,
                        prefixLen,
                        outPtr,
                        outLen,
                    ),
                (json) => {
                    if (json.length === 0) {
                        return { html: '', missing_injections: [], timed_out_languages: [] };
                    }
                    return JSON.parse(json) as HtmlHighlightResult;
                },
            );

            return {
                html: result.html,
                missingInjections: result.missing_injections,
                timedOutLanguages: result.timed_out_languages,
            };
        } finally {
            if (prefixPtr) host._free(prefixPtr);
        }
    }

    cancel(): void {
        this.#assertLive();
        this.grammar.runtime.abi.arborium_rt_cancel(this.id);
    }

    free(): void {
        if (this.#freed) return;
        this.grammar.runtime.abi.arborium_rt_free_session(this.id);
        this.#freed = true;
    }

    #assertLive(): void {
        if (this.#freed) {
            throw new ArboriumError(
                'session-creation-failed',
                `session ${this.id} has been freed`,
            );
        }
    }

    /**
     * Shared plumbing for the three ABI entry points that write a
     * (ptr, len) tuple of output into caller-allocated `u32` slots. Calls
     * `invoke`, reads the resulting buffer, hands it to `decode`, and
     * always frees the output buffer + scratch slots.
     */
    #withJsonOutput<T>(
        errorKind: 'parse-failed' | 'highlight-failed',
        invoke: (outPtrSlot: number, outLenSlot: number) => number,
        decode: (payload: string) => T,
    ): T {
        const { host, abi } = this.grammar.runtime;
        const outPtrSlot = host._malloc(4);
        const outLenSlot = host._malloc(4);
        try {
            const rc = invoke(outPtrSlot, outLenSlot);
            if (rc !== 0) {
                throw new ArboriumError(
                    errorKind,
                    `arborium_rt call returned status ${rc}`,
                );
            }
            const ptr = host.getValue(outPtrSlot, 'i32');
            const len = host.getValue(outLenSlot, 'i32');
            if (len === 0) {
                return decode('');
            }
            try {
                return decode(readUtf8(host, ptr, len));
            } finally {
                abi.arborium_rt_free(ptr, len);
            }
        } finally {
            host._free(outPtrSlot);
            host._free(outLenSlot);
        }
    }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Dynamically import the bundled host-module factory. Resolves relative to
 * the compiled `dist/runtime.js`, so the sibling `dist/host/web-tree-sitter.mjs`
 * (staged by `arborium-rt stage`) is reached at runtime. Bundlers
 * (Vite, webpack, esbuild) trace the literal specifier and ship the asset
 * alongside the consumer's build.
 */
async function loadBundledHostModuleFactory(): Promise<HostModuleFactory> {
    // @ts-expect-error — resolves from dist/ at runtime; no sibling exists under src/.
    const mod = (await import('./host/web-tree-sitter.mjs')) as { default: HostModuleFactory };
    return mod.default;
}

function pickLanguageExport(
    exports: Record<string, unknown>,
    name: string | undefined,
): (...args: number[]) => number {
    if (name !== undefined) {
        const fn = exports[name];
        if (typeof fn !== 'function') {
            throw new ArboriumError(
                'grammar-language-export-missing',
                `grammar module has no function export named ${JSON.stringify(name)}`,
            );
        }
        return fn as (...args: number[]) => number;
    }
    const candidates = Object.keys(exports).filter(
        (k) => k.startsWith('tree_sitter_') && typeof exports[k] === 'function',
    );
    if (candidates.length === 0) {
        throw new ArboriumError(
            'grammar-language-export-missing',
            'grammar module has no function export starting with tree_sitter_',
        );
    }
    if (candidates.length > 1) {
        throw new ArboriumError(
            'grammar-language-export-missing',
            `grammar module has multiple tree_sitter_* exports: ${candidates.join(', ')}. Pass options.languageExport to disambiguate.`,
        );
    }
    // Safe: candidates[0] is defined (we just checked length === 1).
    return exports[candidates[0]!] as (...args: number[]) => number;
}

/** Translate a structured {@link HtmlFormat} into the `(code, prefix)` pair
 *  the ABI expects. The integer codes must stay in sync with `decode_format`
 *  in `src/highlight.rs`. */
function encodeHtmlFormat(format: HtmlFormat): { code: number; prefix: string } {
    switch (format.kind) {
        case 'custom-elements':
            return { code: 0, prefix: '' };
        case 'custom-elements-with-prefix':
            return { code: 1, prefix: format.prefix };
        case 'class-names':
            return { code: 2, prefix: '' };
        case 'class-names-with-prefix':
            return { code: 3, prefix: format.prefix };
    }
}
