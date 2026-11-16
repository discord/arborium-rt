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
	const { spans, missingInjections, outOfFuelLanguages } = highlightToSpans(
		"json",
		'{"a": 1}',
	);
	expect(missingInjections).toEqual([]);
	expect(outOfFuelLanguages).toEqual([]);
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
			expect(r.outOfFuelLanguages).toEqual([]);
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
	// A fenced info string that can never be a real grammar id: its injection
	// can't resolve, so the language is reported as missing. (Using a sentinel
	// keeps this robust whether the addon was linked with the small pretest set
	// or the full corpus, as in CI's package-node matrix.)
	const missing = "totally-not-a-real-language";
	const src = [`\`\`\`${missing}`, "x = 1", "```", ""].join("\n");
	const { missingInjections } = highlightToSpans("markdown", src, {
		maxInjectionDepth: 2,
	});
	expect(missingInjections).toContain(missing);
});

// The addon links its own copy of the tree-sitter C runtime (arborium's,
// compiled by lib/node/build.rs) rather than resolving ts_* against the
// emscripten host, so the fuel meter has to be verified on this path too:
// the per-tick charges read fields the patched query.c and parser.c publish,
// and an unpatched copy would silently mis-meter.
it("bounds a chained-member DoS with the fuel pool", () => {
	// javascript's member_expression is left-recursive, the same shape that
	// makes the upstream kotlin highlights query quadratic: `a.b().b()…`
	// costs ~1e9 fuel unmetered, well past the per-call pool.
	const raw = `a${".b()".repeat(4000)}`;
	const lines: string[] = [];
	for (let i = 0; i < raw.length; i += 950) lines.push(raw.slice(i, i + 950));

	const start = performance.now();
	const result = highlightToSpans("javascript", lines.join("\n"));
	const elapsed = performance.now() - start;

	expect(result.outOfFuelLanguages).toEqual(["javascript"]);
	// Mirrors HIGHLIGHT_FUEL in src/highlight.rs: spent the pool, stopped
	// within one tick of it.
	expect(result.fuelUsed).toBeGreaterThanOrEqual(110_000_000);
	expect(result.fuelUsed).toBeLessThan(110_000_000 * 1.05);
	expect(elapsed).toBeLessThan(1000);
});

it("reports fuel deterministically across runs", () => {
	const source = `const x = ${"1 + ".repeat(2000)}1;\n`.repeat(20);
	const a = highlightToSpans("javascript", source);
	const b = highlightToSpans("javascript", source);
	expect(a.outOfFuelLanguages).toEqual([]);
	expect(a.fuelUsed).toBeGreaterThan(0);
	expect(b.fuelUsed).toBe(a.fuelUsed);
	// Parsing draws on the same pool, so part of `fuelUsed` is the parse.
	expect(a.parseFuelUsed).toBeGreaterThan(0);
	expect(a.parseFuelUsed).toBeLessThan(a.fuelUsed);
	expect(b.parseFuelUsed).toBe(a.parseFuelUsed);
});
