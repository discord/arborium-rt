import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { Grammar, Runtime, ThemedSpan } from "../dist/index.js";
import { loadArboriumRuntime } from "../dist/index.js";
import {
	CSS_GRAMMAR_WASM,
	CSS_HIGHLIGHTS_SCM,
	HTML_GRAMMAR_WASM,
	HTML_HIGHLIGHTS_SCM,
	HTML_INJECTIONS_SCM,
	JAVASCRIPT_GRAMMAR_WASM,
	JAVASCRIPT_HIGHLIGHTS_SCM,
	JAVASCRIPT_INJECTIONS_SCM,
	JSON_GRAMMAR_WASM,
	JSON_HIGHLIGHTS_SCM,
	MARKDOWN_GRAMMAR_WASM,
	MARKDOWN_HIGHLIGHTS_SCM,
	MARKDOWN_INJECTIONS_SCM,
	MARKDOWN_INLINE_GRAMMAR_WASM,
	MARKDOWN_INLINE_HIGHLIGHTS_SCM,
	MARKDOWN_INLINE_INJECTIONS_SCM,
} from "./artifacts.mts";

// Each grammar is loaded with its flattened highlights + (optional)
// injections, matching how the bundled packages ship.
async function loadGrammar(
	runtime: Runtime,
	id: string,
	wasmPath: string,
	highlightsPath: string,
	injectionsPath?: string,
): Promise<Grammar> {
	const [wasm, highlights, injections] = await Promise.all([
		readFile(wasmPath),
		readFile(highlightsPath, "utf8"),
		injectionsPath
			? readFile(injectionsPath, "utf8")
			: Promise.resolve(undefined),
	]);
	return runtime.loadGrammar({
		languageId: id,
		languageExport: `tree_sitter_${id}`,
		wasm,
		highlights,
		...(injections ? { injections } : {}),
	});
}

// A three-level injection chain, mirroring a real Discord code block:
//
//   markdown (level 1)
//     └─ html   (level 2)  ← markdown fence `info_string`
//          ├─ css (level 3) ← <style> raw_text
//          └─ js  (level 3) ← <script> raw_text
//
// The CSS/JS payloads each sit on their own line so we can address those
// innermost regions by exact UTF-16 bounds and confirm the injected
// grammars — not markdown or html — own the highlighting there.
const CSS_LINE = ".foo { color: red; }";
const JS_LINE = "const x = 42;";
const CHAIN_SOURCE = [
	"# Title",
	"",
	"```html",
	"<style>",
	CSS_LINE,
	"</style>",
	"<script>",
	JS_LINE,
	"</script>",
	"```",
	"",
].join("\n");

// Loads every grammar the chain references (including markdown_inline, which
// the markdown injections query pulls from inline content) so `maxInjectionDepth`
// is the only thing gating resolution. Returns the grammars with markdown first.
async function loadInjectionChain(runtime: Runtime): Promise<Grammar[]> {
	return Promise.all([
		loadGrammar(
			runtime,
			"markdown",
			MARKDOWN_GRAMMAR_WASM,
			MARKDOWN_HIGHLIGHTS_SCM,
			MARKDOWN_INJECTIONS_SCM,
		),
		loadGrammar(
			runtime,
			"markdown_inline",
			MARKDOWN_INLINE_GRAMMAR_WASM,
			MARKDOWN_INLINE_HIGHLIGHTS_SCM,
			MARKDOWN_INLINE_INJECTIONS_SCM,
		),
		loadGrammar(
			runtime,
			"html",
			HTML_GRAMMAR_WASM,
			HTML_HIGHLIGHTS_SCM,
			HTML_INJECTIONS_SCM,
		),
		loadGrammar(runtime, "css", CSS_GRAMMAR_WASM, CSS_HIGHLIGHTS_SCM),
		loadGrammar(
			runtime,
			"javascript",
			JAVASCRIPT_GRAMMAR_WASM,
			JAVASCRIPT_HIGHLIGHTS_SCM,
			JAVASCRIPT_INJECTIONS_SCM,
		),
	]);
}

it("produces themed spans via the full highlight pipeline", async () => {
	const [grammarWasm, highlights] = await Promise.all([
		readFile(JSON_GRAMMAR_WASM),
		readFile(JSON_HIGHLIGHTS_SCM, "utf8"),
	]);

	const runtime = await loadArboriumRuntime();
	const grammar = await runtime.loadGrammar({
		languageId: "json",
		wasm: grammarWasm,
		highlights,
	});
	const session = grammar.createSession();
	try {
		session.setText("[1, 2, 3]");
		const { spans } = session.highlightToSpans();

		// Numbers resolve to a single theme tag; the pipeline should
		// return three non-empty spans, one per digit.
		expect(spans).toHaveLength(3);
		for (const span of spans) {
			expect(span.end).toBeGreaterThan(span.start);
			expect(span.tag.length).toBeGreaterThan(0);
		}
	} finally {
		session.free();
		grammar.unregister();
	}
});

it("renders HTML via the full highlight pipeline", async () => {
	const [grammarWasm, highlights] = await Promise.all([
		readFile(JSON_GRAMMAR_WASM),
		readFile(JSON_HIGHLIGHTS_SCM, "utf8"),
	]);

	const runtime = await loadArboriumRuntime();
	const grammar = await runtime.loadGrammar({
		languageId: "json",
		wasm: grammarWasm,
		highlights,
	});
	const session = grammar.createSession();
	try {
		session.setText('{"x": 42}');

		const { html: customElements } = session.highlightToHtml();
		// Default format wraps captures in `<a-*>` tags. We assert only
		// that the output contains at least one such tag; the exact tag
		// depends on the theme-slot map which upstream owns.
		expect(customElements).toMatch(/<a-[a-z]+>/);

		const { html: withClasses } = session.highlightToHtml({
			format: { kind: "class-names" },
		});
		expect(withClasses).toMatch(/<span class="[^"]+">/);
	} finally {
		session.free();
		grammar.unregister();
	}
});

it("highlights languages injected three levels deep", async () => {
	const cssStart = CHAIN_SOURCE.indexOf(CSS_LINE);
	const cssEnd = cssStart + CSS_LINE.length;
	const jsStart = CHAIN_SOURCE.indexOf(JS_LINE);
	const jsEnd = jsStart + JS_LINE.length;

	// A span "inside" a region is fully contained and non-empty — markdown
	// emits zero-width punctuation markers at the fence boundaries.
	const realSpansInside = (
		spans: ThemedSpan[],
		start: number,
		end: number,
	): ThemedSpan[] =>
		spans.filter((s) => s.end > s.start && s.start >= start && s.end <= end);

	const runtime = await loadArboriumRuntime();
	const grammars = await loadInjectionChain(runtime);
	const [markdown] = grammars;

	const session = markdown.createSession();
	try {
		session.setText(CHAIN_SOURCE);

		// Depth 2 reaches all three levels (markdown → html → css/js); every
		// referenced grammar is loaded, so nothing is reported missing.
		const { spans, missingInjections, timedOutLanguages } =
			session.highlightToSpans({ maxInjectionDepth: 2 });
		expect(missingInjections).toEqual([]);
		expect(timedOutLanguages).toEqual([]);

		// The innermost CSS and JS regions are highlighted...
		const cssSpans = realSpansInside(spans, cssStart, cssEnd);
		const jsSpans = realSpansInside(spans, jsStart, jsEnd);
		expect(cssSpans.length).toBeGreaterThan(0);
		expect(jsSpans.length).toBeGreaterThan(0);

		// ...by the injected grammars' own captures, not stray markdown/html
		// ones. `color` is a CSS property ("pr"); `const` is a JS keyword
		// ("k") and `42` a number ("n").
		const slot = (subset: ThemedSpan[], text: string) =>
			subset.find((s) => CHAIN_SOURCE.slice(s.start, s.end) === text)?.tag;
		expect(slot(cssSpans, "color")).toBe("pr");
		expect(slot(jsSpans, "const")).toBe("k");
		expect(slot(jsSpans, "42")).toBe("n");
	} finally {
		session.free();
		for (const g of grammars) g.unregister();
	}
});

it("renders injected languages into HTML with the injected grammars' classes", async () => {
	const runtime = await loadArboriumRuntime();
	const grammars = await loadInjectionChain(runtime);
	const [markdown] = grammars;

	const session = markdown.createSession();
	try {
		session.setText(CHAIN_SOURCE);

		// The HTML render must agree with the spans pipeline: at depth 2 the
		// injected CSS/JS captures should reach the HTML output, so `color` is a
		// CSS property, and `const`/`42` are a JS keyword/number.
		// `highlightToSpans` already classifies these as "pr"/"k"/"n" — the
		// regression was that the HTML path mis-resolved the overlapping
		// captures recursive injection produces (dropping `const` to the
		// enclosing markdown-literal/punctuation tag). Assert both the
		// Discord-facing custom-element format and the class-names format.
		const { html: customElements } = session.highlightToHtml({
			maxInjectionDepth: 2,
		});
		expect(customElements).toContain("<a-pr>color</a-pr>");
		expect(customElements).toContain("<a-k>const</a-k>");
		expect(customElements).toContain("<a-n>42</a-n>");

		// class-names maps the same slots to `property`/`keyword`/`number`.
		const { html } = session.highlightToHtml({
			maxInjectionDepth: 2,
			format: { kind: "class-names" },
		});
		expect(html).toMatch(/<span class="property">color<\/span>/);
		expect(html).toMatch(/<span class="keyword">const<\/span>/);
		expect(html).toMatch(/<span class="number">42<\/span>/);
	} finally {
		session.free();
		for (const g of grammars) g.unregister();
	}
});
