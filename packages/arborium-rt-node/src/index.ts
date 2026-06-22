// @discord/arborium-rt-node — statically-linked tree-sitter + arborium runtime
// for Node.js. Every grammar's parser/scanner is compiled into the native
// addon and every flattened query is baked in, so there is no wasm host and no
// async grammar loading: just call `highlightToSpans(language, text)`.

import { createRequire } from "node:module";

import type {
	HighlightHtmlResult,
	HighlightOptions,
	HighlightSpansResult,
	HighlightToHtmlOptions,
	HtmlFormat,
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

/** Options passed to the native HTML entry points (numeric format code). */
interface NativeHtmlOptions {
	maxInjectionDepth?: number | undefined;
	format?: number | undefined;
	prefix?: string | undefined;
}

interface NativeSession {
	setText(text: string): void;
	parse(): ParseResult;
	highlightToSpans(options: HighlightOptions): HighlightSpansResult;
	highlightToHtml(options: NativeHtmlOptions): HighlightHtmlResult;
	cancel(): void;
	free(): void;
}

interface NativeAddon {
	availableLanguages(): string[];
	highlightToSpans(
		language: string,
		text: string,
		maxInjectionDepth?: number,
	): HighlightSpansResult;
	highlightToHtmlString(
		language: string,
		text: string,
		options?: NativeHtmlOptions,
	): HighlightHtmlResult;
	Session: new (language: string) => NativeSession;
}

// The compiled JS lives in dist/; `arborium-rt build-node` copies the native
// addon to the package root next to dist/, so it's one level up.
const require = createRequire(import.meta.url);
const native = require("../arborium-rt-node.node") as NativeAddon;

/** Translate the JS-facing `HtmlFormat` union into the native numeric code. */
function encodeHtmlFormat(format?: HtmlFormat): {
	format: number;
	prefix?: string;
} {
	switch (format?.kind) {
		case "custom-elements-with-prefix":
			return { format: 1, prefix: format.prefix };
		case "class-names":
			return { format: 2 };
		case "class-names-with-prefix":
			return { format: 3, prefix: format.prefix };
		default:
			return { format: 0 };
	}
}

/** The ids of every grammar bundled in this addon, sorted. */
export function availableLanguages(): string[] {
	return native.availableLanguages();
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
	return native.highlightToSpans(language, text, options.maxInjectionDepth);
}

/** One-shot: highlight `text` as `language` into a rendered HTML string. */
export function highlightToHtml(
	language: string,
	text: string,
	options: HighlightToHtmlOptions = {},
): HighlightHtmlResult {
	const { format, prefix } = encodeHtmlFormat(options.format);
	return native.highlightToHtmlString(language, text, {
		maxInjectionDepth: options.maxInjectionDepth,
		format,
		prefix,
	});
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
		this.#inner = new native.Session(language);
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
		const { format, prefix } = encodeHtmlFormat(options.format);
		return this.#inner.highlightToHtml({
			maxInjectionDepth: options.maxInjectionDepth,
			format,
			prefix,
		});
	}

	cancel(): void {
		this.#inner.cancel();
	}

	free(): void {
		this.#inner.free();
	}
}
