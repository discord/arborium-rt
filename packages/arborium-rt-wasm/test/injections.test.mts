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
	MARKDOWN_GRAMMAR_WASM,
	MARKDOWN_HIGHLIGHTS_SCM,
	MARKDOWN_INJECTIONS_SCM,
	MARKDOWN_INLINE_GRAMMAR_WASM,
	MARKDOWN_INLINE_HIGHLIGHTS_SCM,
	MARKDOWN_INLINE_INJECTIONS_SCM,
} from "./artifacts.mts";

// Recursive language-injection coverage.
//
// The document exercises a three-level injection chain that mirrors a real
// Discord code block: a markdown fence tagged `html` injects the HTML
// grammar, and the HTML grammar's own injections.scm pulls CSS out of
// `<style>` and JavaScript out of `<script>`. So the nesting is:
//
//   markdown (depth 0)
//     └─ html       (depth 1)  ← markdown fence `info_string`
//          ├─ css   (depth 2)  ← <style> raw_text
//          └─ js    (depth 2)  ← <script> raw_text
//
// `highlightToSpans({ maxInjectionDepth })` gates how far the runtime
// follows that chain. The contract under test: injections resolve level by
// level until the requested depth is hit, then stop — and once the chain
// bottoms out (depth 2 here) deeper budgets are a no-op.
//
// Every referenced grammar is loaded (including markdown_inline, which the
// markdown injections query pulls from inline content), so `missingInjections`
// stays empty and depth is the *only* thing gating resolution.

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
		// Omit the key entirely when absent — `exactOptionalPropertyTypes`
		// rejects an explicit `undefined` for an optional URL/string field.
		...(injections ? { injections } : {}),
	});
}

// A markdown doc whose only fenced block is HTML carrying a <style> (CSS)
// and a <script> (JS). The CSS and JS payloads each sit on their own line so
// we can address those regions by exact UTF-16 bounds below.
const CSS_LINE = ".foo { color: red; }";
const JS_LINE = "const x = 42;";
const SOURCE = [
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

// UTF-16 bounds of the innermost (depth-2) payload lines. A span "inside" a
// region is fully contained and non-empty — markdown emits zero-width
// punctuation markers at the fence boundaries that we must exclude.
const CSS_START = SOURCE.indexOf(CSS_LINE);
const CSS_END = CSS_START + CSS_LINE.length;
const JS_START = SOURCE.indexOf(JS_LINE);
const JS_END = JS_START + JS_LINE.length;

function realSpansInside(
	spans: ThemedSpan[],
	start: number,
	end: number,
): ThemedSpan[] {
	return spans.filter(
		(s) => s.end > s.start && s.start >= start && s.end <= end,
	);
}

it("resolves nested injections (markdown → html → css/js) up to the depth limit", async () => {
	const runtime = await loadArboriumRuntime();
	const grammars = await Promise.all([
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
	const [markdown] = grammars;

	const session = markdown.createSession();
	try {
		session.setText(SOURCE);

		const at = (maxInjectionDepth: number) =>
			session.highlightToSpans({ maxInjectionDepth });

		const d0 = at(0);
		const d1 = at(1);
		const d2 = at(2);
		const d3 = at(3);

		// Every grammar the chain references is loaded, so nothing is ever
		// reported missing regardless of depth — depth alone gates resolution.
		for (const r of [d0, d1, d2, d3]) {
			expect(r.missingInjections).toEqual([]);
			expect(r.timedOutLanguages).toEqual([]);
		}

		// depth 0: injection recursion disabled. Only the markdown frame is
		// highlighted; the fenced block is opaque content, so the CSS and JS
		// payload regions hold no real spans.
		expect(realSpansInside(d0.spans, CSS_START, CSS_END)).toHaveLength(0);
		expect(realSpansInside(d0.spans, JS_START, JS_END)).toHaveLength(0);

		// depth 1: the html grammar is injected (one level), adding spans for
		// the `<style>` / `<script>` / `<div>` markup — so the total grows.
		// But CSS/JS live one level deeper, inside html's raw_text, and aren't
		// reached yet.
		expect(d1.spans.length).toBeGreaterThan(d0.spans.length);
		expect(realSpansInside(d1.spans, CSS_START, CSS_END)).toHaveLength(0);
		expect(realSpansInside(d1.spans, JS_START, JS_END)).toHaveLength(0);

		// depth 2: html's own injections fire, so CSS and JS are finally
		// highlighted inside their respective elements.
		expect(d2.spans.length).toBeGreaterThan(d1.spans.length);
		const cssSpans = realSpansInside(d2.spans, CSS_START, CSS_END);
		const jsSpans = realSpansInside(d2.spans, JS_START, JS_END);
		expect(cssSpans.length).toBeGreaterThan(0);
		expect(jsSpans.length).toBeGreaterThan(0);

		// Spot-check that the deeply-injected spans carry the grammars' own
		// captures, not stray markdown/html ones. `color` is a CSS property
		// ("pr"); `const` is a JS keyword ("k") and `42` a number ("n").
		const slot = (spans: ThemedSpan[], text: string) =>
			spans.find((s) => SOURCE.slice(s.start, s.end) === text)?.tag;
		expect(slot(cssSpans, "color")).toBe("pr");
		expect(slot(jsSpans, "const")).toBe("k");
		expect(slot(jsSpans, "42")).toBe("n");

		// The chain bottoms out at depth 2 (css/js inject nothing further), so
		// asking for more depth is a no-op: the span set is byte-for-byte
		// identical. This pins the "up until the depth limit, then stop" half
		// of the contract.
		expect(d3.spans).toEqual(d2.spans);
		expect(at(8).spans).toEqual(d2.spans);
	} finally {
		session.free();
		for (const g of grammars) g.unregister();
	}
});
