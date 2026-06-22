// Public types for @discord/arborium-rt-node. Kept structurally identical to
// @discord/arborium-rt's user-facing API (ThemedSpan, HighlightSpansResult,
// HighlightHtmlResult, HtmlFormat, HighlightOptions) so the two packages are
// interchangeable for highlighting — the only difference is that this package
// links every grammar statically, so there is no async grammar loading.

/**
 * A themed span emitted by the full highlight pipeline (parse + injection
 * resolution + dedup + coalesce). Offsets are UTF-16 code units; the `tag`
 * is the short theme slot string (`"k"`, `"f"`, `"s"`, …) matching the
 * default `custom-elements` HTML format.
 */
export interface ThemedSpan {
	start: number;
	end: number;
	tag: string;
}

/** A raw highlight-query capture span (UTF-16 offsets, not themed). */
export interface ParseSpan {
	start: number;
	end: number;
	/** Capture name from highlights.scm (e.g. "keyword", "string", "number"). */
	capture: string;
	/** Pattern index from the query; higher = later rule = higher priority. */
	patternIndex: number;
}

/** A language-injection point discovered during the primary parse. */
export interface ParseInjection {
	start: number;
	end: number;
	/** Injected language ID (e.g. "javascript" inside HTML). */
	language: string;
	includeChildren: boolean;
}

/** Raw parse result: the primary grammar's captures + injection points. */
export interface ParseResult {
	spans: ParseSpan[];
	injections: ParseInjection[];
	/**
	 * `true` if the runtime's wall-clock query budget fired before the
	 * QueryCursor finished. `spans` then holds partial output.
	 */
	timedOut: boolean;
}

export interface HighlightOptions {
	/**
	 * How deep to follow language injections. `0` disables recursion — only
	 * the primary grammar's captures are considered. The runtime caps this at
	 * 32 internally. Defaults to `3`.
	 */
	maxInjectionDepth?: number;
}

/** Options for HTML highlighting. Adds an output-format selector. */
export interface HighlightToHtmlOptions extends HighlightOptions {
	/** HTML markup style. Defaults to `{ kind: 'custom-elements' }`. */
	format?: HtmlFormat;
}

/** Result from `highlightToSpans`, including any missing injection grammars. */
export interface HighlightSpansResult {
	spans: ThemedSpan[];
	/** Languages referenced by injections but not bundled in this addon. */
	missingInjections: string[];
	/**
	 * Language names whose parse exceeded the runtime's wall-clock query
	 * budget. Empty when nothing timed out. Sorted, deduplicated.
	 */
	timedOutLanguages: string[];
}

/** Result from `highlightToHtml`, including any missing injection grammars. */
export interface HighlightHtmlResult {
	html: string;
	missingInjections: string[];
	timedOutLanguages: string[];
}

/**
 * Output format for HTML highlighting. Mirrors `arborium_highlight::HtmlFormat`.
 *
 * - `custom-elements`: `<a-k>keyword</a-k>` — default, most compact.
 * - `custom-elements-with-prefix`: `<code-k>keyword</code-k>`.
 * - `class-names`: `<span class="keyword">keyword</span>`.
 * - `class-names-with-prefix`: `<span class="arb-keyword">…</span>`.
 */
export type HtmlFormat =
	| { kind: "custom-elements" }
	| { kind: "custom-elements-with-prefix"; prefix: string }
	| { kind: "class-names" }
	| { kind: "class-names-with-prefix"; prefix: string };
