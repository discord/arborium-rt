// Wire types for arborium-rt. Mirrors third_party/arborium/crates/arborium-wire/src/lib.rs
// plus the handful of arborium-rt-specific wire shapes defined in src/highlight.rs.
// The runtime serializes these as JSON before handing them back through shared
// linear memory; the interfaces below describe the shape after JSON.parse.

/** A highlighted span with UTF-16 code-unit indices (suitable for JS string slice). */
export interface Utf16Span {
    /** UTF-16 code unit where the span starts. */
    start: number;
    /** UTF-16 code unit where the span ends (exclusive). */
    end: number;
    /** Capture name from highlights.scm (e.g. "keyword", "string", "number"). */
    capture: string;
    /** Pattern index from the query; higher = later rule = higher priority. */
    pattern_index: number;
}

/** An injection point with UTF-16 code-unit indices. */
export interface Utf16Injection {
    start: number;
    end: number;
    /** Injected language ID (e.g. "javascript" inside HTML). */
    language: string;
    include_children: boolean;
}

/** Full parse result in UTF-16-indexed form. */
export interface Utf16ParseResult {
    spans: Utf16Span[];
    injections: Utf16Injection[];
    /**
     * `true` if the runtime's wall-clock query budget fired before the
     * QueryCursor finished. `spans` then holds whatever was collected
     * before the budget expired — partial output.
     */
    timed_out: boolean;
}

/**
 * A themed span emitted by the full highlight pipeline (parse + injection
 * resolution + dedup + coalesce). Offsets are UTF-16 code units; the `tag`
 * is the short theme slot string (`"k"`, `"f"`, `"s"`, …) matching the
 * default `CustomElements` HTML format — map it to a longer class name via
 * arborium-theme's `tag_to_name` if you want `"keyword"` / `"function"` /
 * `"string"`.
 */
export interface ThemedSpan {
    start: number;
    end: number;
    tag: string;
}

/** Wire shape of `arborium_rt_highlight_to_spans_utf16`'s JSON payload. */
export interface ThemedHighlightResult {
    spans: ThemedSpan[];
    /**
     * Languages referenced by injection queries but not loaded in the registry.
     * The TypeScript wrapper uses this to auto-load missing grammars and retry.
     */
    missing_injections: string[];
    /**
     * Language names whose parse exceeded the runtime's wall-clock query
     * budget. Empty when no parse timed out.
     */
    timed_out_languages: string[];
}

/** Wire shape of `arborium_rt_highlight_to_html`'s JSON payload. */
export interface HtmlHighlightResult {
    html: string;
    /**
     * Languages referenced by injection queries but not loaded in the registry.
     * The TypeScript wrapper uses this to auto-load missing grammars and retry.
     */
    missing_injections: string[];
    /** See [`ThemedHighlightResult.timed_out_languages`]. */
    timed_out_languages: string[];
}

/**
 * Output format for `arborium_rt_highlight_to_html`. Mirrors
 * `arborium_highlight::HtmlFormat`; the numeric `format` codes match the
 * ones the Rust ABI decodes.
 *
 * - `custom-elements`: `<a-k>keyword</a-k>` — default, the most compact.
 * - `custom-elements-with-prefix`: `<code-k>keyword</code-k>` — pass a
 *   `prefix` to namespace the element name.
 * - `class-names`: `<span class="keyword">keyword</span>` — drop-in for
 *   CSS that expects traditional long class names.
 * - `class-names-with-prefix`: `<span class="arb-keyword">…</span>` —
 *   class names prefixed so they don't collide with page CSS.
 */
export type HtmlFormat =
    | { kind: 'custom-elements' }
    | { kind: 'custom-elements-with-prefix'; prefix: string }
    | { kind: 'class-names' }
    | { kind: 'class-names-with-prefix'; prefix: string };

/**
 * An edit to apply to the text for incremental parsing.
 *
 * Not yet surfaced through arborium-rt's ABI (v2 still re-parses from scratch
 * on each `setText`). Kept here to match the wire crate's shape so consumers
 * can start typing against it ahead of the ABI bump.
 */
export interface Edit {
    start_byte: number;
    old_end_byte: number;
    new_end_byte: number;
    start_row: number;
    start_col: number;
    old_end_row: number;
    old_end_col: number;
    new_end_row: number;
    new_end_col: number;
}
