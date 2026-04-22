// Wire types for arborium-rt. Mirrors third_party/arborium/crates/arborium-wire/src/lib.rs.
// The runtime serializes Utf16ParseResult as JSON before handing it back through
// shared linear memory; these types describe the shape after JSON.parse.

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
}

/**
 * An edit to apply to the text for incremental parsing.
 *
 * Not yet surfaced through arborium-rt's ABI (ABI v1 re-parses from scratch on
 * each `setText`). Kept here to match the wire crate's shape so consumers can
 * start typing against it ahead of the ABI bump.
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
