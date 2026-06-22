import { expect, it } from "vitest";
import {
	availableLanguages,
	highlightToHtml,
	highlightToSpans,
	Session,
	type ThemedSpan,
} from "../dist/index.js";

// These ids match the package's `pretest` --only set.
const EXPECTED = [
	"css",
	"html",
	"javascript",
	"json",
	"markdown",
	"markdown_inline",
];

it("exposes the bundled languages", () => {
	const langs = availableLanguages();
	for (const id of EXPECTED) expect(langs).toContain(id);
});

it("highlights a json document into themed spans", () => {
	const { spans, missingInjections, timedOutLanguages } = highlightToSpans(
		"json",
		'{"a": 1}',
	);
	expect(missingInjections).toEqual([]);
	expect(timedOutLanguages).toEqual([]);
	// "a" (with quotes) is a string at UTF-16 [1,4); 1 is a number at [6,7).
	expect(spans).toContainEqual({ start: 1, end: 4, tag: "s" });
	expect(spans).toContainEqual({ start: 6, end: 7, tag: "n" });
});

it("renders json to HTML in both formats", () => {
	expect(highlightToHtml("json", '{"a": 1}').html).toBe(
		"{<a-s>&quot;a&quot;</a-s>: <a-n>1</a-n>}",
	);
	expect(
		highlightToHtml("json", '{"a": 1}', { format: { kind: "class-names" } })
			.html,
	).toBe(
		'{<span class="string">&quot;a&quot;</span>: <span class="number">1</span>}',
	);
});

// The markdown → html → {css,js} injection chain, mirroring the wasm
// package's injections test: the native pipeline must resolve it identically.
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

it("resolves nested injections up to the depth limit", () => {
	const session = new Session("markdown");
	try {
		session.setText(SOURCE);
		const at = (maxInjectionDepth: number) =>
			session.highlightToSpans({ maxInjectionDepth });

		const d0 = at(0);
		const d1 = at(1);
		const d2 = at(2);
		const d3 = at(3);

		for (const r of [d0, d1, d2, d3]) {
			expect(r.missingInjections).toEqual([]);
			expect(r.timedOutLanguages).toEqual([]);
		}

		// Depth 0 and 1 don't reach the depth-2 css/js payloads.
		expect(realSpansInside(d0.spans, CSS_START, CSS_END)).toHaveLength(0);
		expect(realSpansInside(d1.spans, CSS_START, CSS_END)).toHaveLength(0);
		expect(realSpansInside(d1.spans, JS_START, JS_END)).toHaveLength(0);

		// Depth 2: css/js are highlighted with their own captures.
		const cssSpans = realSpansInside(d2.spans, CSS_START, CSS_END);
		const jsSpans = realSpansInside(d2.spans, JS_START, JS_END);
		expect(cssSpans.length).toBeGreaterThan(0);
		expect(jsSpans.length).toBeGreaterThan(0);
		const slot = (spans: ThemedSpan[], text: string) =>
			spans.find((s) => SOURCE.slice(s.start, s.end) === text)?.tag;
		expect(slot(cssSpans, "color")).toBe("pr");
		expect(slot(jsSpans, "const")).toBe("k");
		expect(slot(jsSpans, "42")).toBe("n");

		// The chain bottoms out at depth 2 — deeper budgets are a no-op.
		expect(d3.spans).toEqual(d2.spans);
	} finally {
		session.free();
	}
});

it("reports missing injections for unbundled fenced languages", () => {
	// `python` isn't in the --only set, so a python fence's injection can't
	// resolve and the language is reported as missing.
	const src = ["```python", "x = 1", "```", ""].join("\n");
	const { missingInjections } = highlightToSpans("markdown", src, {
		maxInjectionDepth: 2,
	});
	expect(missingInjections).toContain("python");
});
