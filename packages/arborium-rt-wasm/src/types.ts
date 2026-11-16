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
	 * Query fuel this parse consumed. Fuel models the work tree-sitter's
	 * query cursor did — operations weighted by how many candidate matches
	 * each one had to touch — in place of wall-clock time, so the cost of a
	 * given (query, tree) pair is the same on every machine. Charged in
	 * blocks of 100 cursor operations, so a document too small to reach the
	 * first block reports 0.
	 */
	fuel_used: number;
	/**
	 * `true` if the fuel allotted to this parse ran out before the
	 * QueryCursor finished. `spans` then holds whatever was collected
	 * before it ran dry — partial output. Also `true`, with no spans, if
	 * the session's tree-sitter parse ran out of fuel and left no tree to
	 * query.
	 */
	out_of_fuel: boolean;
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
	 * Language names whose highlighting is incomplete because the call's
	 * fuel pool ran dry — the grammar's query was cut off mid-run, its parse
	 * was abandoned so it had no tree to query, or it was an injected block
	 * reached after the pool was already empty and skipped. Empty when the
	 * whole document fit in budget.
	 */
	out_of_fuel_languages: string[];
	/**
	 * Fuel this call consumed out of the pipeline's fixed per-call pool,
	 * summed across every parse and query it ran — the primary grammar's
	 * (including its parse, run earlier by `setText`) and every injected
	 * block's. Deterministic for a given document, so it works as a cost
	 * metric.
	 */
	fuel_used: number;
	/** The part of `fuel_used` spent parsing; the rest went to queries. */
	parse_fuel_used: number;
}

/** Wire shape of `arborium_rt_highlight_to_html`'s JSON payload. */
export interface HtmlHighlightResult {
	html: string;
	/**
	 * Languages referenced by injection queries but not loaded in the registry.
	 * The TypeScript wrapper uses this to auto-load missing grammars and retry.
	 */
	missing_injections: string[];
	/** See [`ThemedHighlightResult.out_of_fuel_languages`]. */
	out_of_fuel_languages: string[];
	/** See [`ThemedHighlightResult.fuel_used`]. */
	fuel_used: number;
	/** See [`ThemedHighlightResult.parse_fuel_used`]. */
	parse_fuel_used: number;
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
	| { kind: "custom-elements" }
	| { kind: "custom-elements-with-prefix"; prefix: string }
	| { kind: "class-names" }
	| { kind: "class-names-with-prefix"; prefix: string };

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
