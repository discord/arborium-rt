// @discord/arborium-rt-node — statically-linked tree-sitter + arborium runtime
// for Node.js. Every grammar's parser/scanner is compiled into the native
// addon and every flattened query is baked in, so there is no wasm host and no
// async grammar loading: just call `highlightToSpans(language, text)`.
//
// The native binding is the napi-rs-generated loader in `../binding.cjs` (built
// by `arborium-rt build node`, which runs `napi build`). That loader picks the
// correct `arborium-rt-node.<platform>.node` for the running platform from the
// per-platform binaries the package bundles (the CI matrix builds one per
// target). This module is the thin, friendly TypeScript wrapper over it: it
// keeps the public `HtmlFormat` union (translated to the native numeric format
// code) and wraps the native `Session` class, so the surface stays
// interchangeable with `@discord/arborium-rt`.

import {
	type HtmlOptions as NativeHtmlOptions,
	Session as NativeSession,
	availableLanguages as nativeAvailableLanguages,
	highlightToHtmlString as nativeHighlightToHtmlString,
	highlightToSpans as nativeHighlightToSpans,
} from "../binding.cjs";

import type {
	HighlightHtmlResult,
	HighlightOptions,
	HighlightSpansResult,
	HighlightToHtmlOptions,
	ParseResult,
} from "./types.js";

export type {
	HighlightHtmlResult,
	HighlightOptions,
	HighlightSpansResult,
	HighlightToHtmlOptions,
	HtmlFormat,
	ParseInjection,
	ParseResult,
	ParseSpan,
	ThemedSpan,
} from "./types.js";

/**
 * Translate the friendly `HighlightToHtmlOptions` into the native numeric
 * `HtmlOptions` the addon expects. Keys are only set when defined, so the
 * result satisfies the generated type under `exactOptionalPropertyTypes`.
 */
function nativeHtmlOptions(options: HighlightToHtmlOptions): NativeHtmlOptions {
	const native: NativeHtmlOptions = {};
	if (options.maxInjectionDepth !== undefined) {
		native.maxInjectionDepth = options.maxInjectionDepth;
	}
	switch (options.format?.kind) {
		case "custom-elements-with-prefix":
			native.format = 1;
			native.prefix = options.format.prefix;
			break;
		case "class-names":
			native.format = 2;
			break;
		case "class-names-with-prefix":
			native.format = 3;
			native.prefix = options.format.prefix;
			break;
		default:
			native.format = 0;
	}
	return native;
}

/** The ids of every grammar bundled in this addon, sorted. */
export function availableLanguages(): string[] {
	return nativeAvailableLanguages();
}

/**
 * One-shot: highlight `text` as `language` into themed UTF-16 spans. Throws if
 * `language` is not a bundled grammar id (see {@link availableLanguages}).
 */
export function highlightToSpans(
	language: string,
	text: string,
	options: HighlightOptions = {},
): HighlightSpansResult {
	return nativeHighlightToSpans(language, text, options.maxInjectionDepth);
}

/** One-shot: highlight `text` as `language` into a rendered HTML string. */
export function highlightToHtml(
	language: string,
	text: string,
	options: HighlightToHtmlOptions = {},
): HighlightHtmlResult {
	return nativeHighlightToHtmlString(
		language,
		text,
		nativeHtmlOptions(options),
	);
}

/**
 * A reusable parse session for one document. Construct with a bundled grammar
 * id, then `setText` and call any highlight/parse method repeatedly. The
 * underlying native session is released when this object is garbage-collected
 * or via {@link Session.free}.
 */
export class Session {
	#inner: NativeSession;

	constructor(language: string) {
		this.#inner = new NativeSession(language);
	}

	setText(text: string): void {
		this.#inner.setText(text);
	}

	parse(): ParseResult {
		return this.#inner.parse();
	}

	highlightToSpans(options: HighlightOptions = {}): HighlightSpansResult {
		return this.#inner.highlightToSpans(options);
	}

	highlightToHtml(options: HighlightToHtmlOptions = {}): HighlightHtmlResult {
		return this.#inner.highlightToHtml(nativeHtmlOptions(options));
	}

	cancel(): void {
		this.#inner.cancel();
	}

	free(): void {
		this.#inner.free();
	}
}
