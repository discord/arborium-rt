// High-level wrapper classes over the arborium-rt ABI.

import {
    ArboriumError,
    putUtf8,
    readUtf8,
    resolveWasm,
    type HostModule,
    type HostModuleFactory,
    type RuntimeAbi,
    type WasmSource,
} from './abi.js';
import type {
    HtmlFormat,
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
    const host = await factory();
    const runtimeBytes = await resolveWasm(
        new URL('./runtime/arborium_emscripten_runtime.wasm', import.meta.url),
    );
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
    /** Contents of `highlights.scm`. Required — a grammar with no highlights is useless. */
    highlights: string;
    /** Contents of `injections.scm`, if the grammar supports language injection. */
    injections?: string;
    /** Contents of `locals.scm`, if the grammar uses local-scope queries. */
    locals?: string;
    /**
     * Name of the grammar's `tree_sitter_<lang>()` export. If omitted, the
     * loader auto-detects by scanning the module's exports for a single
     * function starting with `tree_sitter_`.
     */
    languageExport?: string;
}

/**
 * Stable shape emitted by the `@appellation/arborium-rt/grammars/<lang>`
 * subpath modules. Any module whose default export satisfies this interface
 * can be handed straight to {@link Runtime.loadGrammar}: it's structurally
 * assignable to {@link LoadGrammarOptions}.
 */
export interface ArboriumGrammarPackage {
    /** Grammar id from `arborium.yaml` (e.g. `"json"`, `"typescript"`). */
    languageId: string;
    /** Symbol the grammar wasm exports (always `"tree_sitter_<languageId>"`). */
    languageExport: string;
    /** URL to the grammar SIDE_MODULE wasm, resolved against the subpath module. */
    wasm: URL;
    /** Flattened highlights query (prepend chain + own). */
    highlights: string;
    /** Flattened injections query, if the grammar defines one. */
    injections?: string;
    /** Flattened locals query, if the grammar defines one. */
    locals?: string;
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
        const grammarBytes = await resolveWasm(options.wasm);
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
        const [hPtr, hLen] = putUtf8(this.host, options.highlights);
        const [iPtr, iLen] = putUtf8(this.host, options.injections ?? '');
        const [lPtr, lLen] = putUtf8(this.host, options.locals ?? '');
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
                    ? { spans: [], injections: [] }
                    : (JSON.parse(json) as Utf16ParseResult)),
        );
    }

    /**
     * Full highlight pipeline as themed spans: parse + recursive injection
     * resolution + dedup + coalesce + capture→tag mapping, UTF-16 offsets.
     */
    highlightToSpans(options: HighlightOptions = {}): ThemedSpan[] {
        this.#assertLive();
        const depth = options.maxInjectionDepth ?? 3;
        return this.#withJsonOutput(
            'highlight-failed',
            (outPtr, outLen) =>
                this.grammar.runtime.abi.arborium_rt_highlight_to_spans_utf16(
                    this.id,
                    depth,
                    outPtr,
                    outLen,
                ),
            (json) => {
                if (json.length === 0) return [];
                return (JSON.parse(json) as ThemedHighlightResult).spans;
            },
        );
    }

    /**
     * Full highlight pipeline rendered straight to HTML. Matches
     * `arborium_highlight::spans_to_html` output byte-for-byte for the same
     * format + source.
     */
    highlightToHtml(options: HighlightToHtmlOptions = {}): string {
        this.#assertLive();
        const depth = options.maxInjectionDepth ?? 3;
        const format = options.format ?? { kind: 'custom-elements' };
        const { host } = this.grammar.runtime;
        const { code, prefix } = encodeHtmlFormat(format);
        const [prefixPtr, prefixLen] = putUtf8(host, prefix);
        try {
            return this.#withJsonOutput(
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
                (html) => html,
            );
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
 * (staged by `arborium-rt stage-dist`) is reached at runtime. Bundlers
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
