import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { loadArboriumRuntime } from "../dist/index.js";
import {
	JAVASCRIPT_GRAMMAR_WASM,
	JAVASCRIPT_HIGHLIGHTS_SCM,
	KOTLIN_GRAMMAR_WASM,
	KOTLIN_HIGHLIGHTS_SCM,
	MARKDOWN_GRAMMAR_WASM,
	MARKDOWN_HIGHLIGHTS_SCM,
	MARKDOWN_INJECTIONS_SCM,
} from "./artifacts.mts";

// Coverage for the parse side of the fuel pool. Parsing is metered in the
// same fuel as queries (`PARSE_FUEL_PER_*` in arborium-plugin-runtime), and
// one highlight call's pool (`HIGHLIGHT_FUEL` in src/highlight.rs) covers
// every parse and every query it runs: the primary parse (which `setText`
// runs on the whole pool, and highlighting then charges), the primary query,
// and each injected block's parse and query in document order. A parse that
// runs out is abandoned, leaving no tree, and its language is reported as out
// of fuel just as a cut-off query's is.
//
// Two parse-side attack shapes, both in error recovery:
//
// - Repeated kotlin `-}`: one parser operation costs 5–10x an ordinary one,
//   and the operations needed roughly double each time the input doubles.
//   4 KB of it takes ~3 s to parse unbounded.
// - An unterminated javascript template literal: recovery keeps growing one
//   ERROR node and rebuilds it from all of its children for every token it
//   skips, so the work is quadratic while the operation count stays linear.
//   50 KB takes ~2 s to parse unbounded.

/** Mirrors `HIGHLIGHT_FUEL` in src/highlight.rs. */
const HIGHLIGHT_FUEL = 110_000_000;

const SUPERLINEAR_KOTLIN = "-}".repeat(2000);

async function loadGrammars(
	runtime: Awaited<ReturnType<typeof loadArboriumRuntime>>,
) {
	const [
		markdownWasm,
		markdownHighlights,
		markdownInjections,
		kotlinWasm,
		kotlinHighlights,
	] = await Promise.all([
		readFile(MARKDOWN_GRAMMAR_WASM),
		readFile(MARKDOWN_HIGHLIGHTS_SCM, "utf8"),
		readFile(MARKDOWN_INJECTIONS_SCM, "utf8"),
		readFile(KOTLIN_GRAMMAR_WASM),
		readFile(KOTLIN_HIGHLIGHTS_SCM, "utf8"),
	]);
	const markdown = await runtime.loadGrammar({
		languageId: "markdown",
		languageExport: "tree_sitter_markdown",
		wasm: markdownWasm,
		highlights: markdownHighlights,
		injections: markdownInjections,
	});
	const kotlin = await runtime.loadGrammar({
		languageId: "kotlin",
		languageExport: "tree_sitter_kotlin",
		wasm: kotlinWasm,
		highlights: kotlinHighlights,
	});
	return { markdown, kotlin };
}

it("abandons a parse that drains the pool", async () => {
	const runtime = await loadArboriumRuntime();
	const { markdown, kotlin } = await loadGrammars(runtime);
	const session = kotlin.createSession();
	try {
		const start = performance.now();
		session.setText(SUPERLINEAR_KOTLIN);
		const elapsed = performance.now() - start;

		// An abandoned parse leaves the session with no tree. Highlighting
		// reports that the way it reports a cut-off query: out of fuel, with
		// whatever was resolved, which here is nothing.
		const result = session.highlightToSpans();
		expect(result.spans).toEqual([]);
		expect(result.outOfFuelLanguages).toEqual(["kotlin"]);
		// The parse spent the whole pool and stopped within a tick of it;
		// nothing was left for a query.
		expect(result.fuelUsed).toBeGreaterThanOrEqual(HIGHLIGHT_FUEL);
		expect(result.fuelUsed).toBeLessThan(HIGHLIGHT_FUEL * 1.05);
		expect(result.parseFuelUsed).toBe(result.fuelUsed);

		// The raw parse says the same thing.
		const parsed = session.parse();
		expect(parsed.spans).toEqual([]);
		expect(parsed.out_of_fuel).toBe(true);

		// The fuel assertions above are the real check. This is a loose
		// backstop with headroom for a slow CI box: ~250 ms locally, against
		// ~3 s unbounded.
		expect(elapsed).toBeLessThan(1500);
	} finally {
		session.free();
		markdown.unregister();
		kotlin.unregister();
	}
});

it("charges recovery that keeps rebuilding one ERROR node", async () => {
	// Counting parser operations alone, this input costs ~1/7 of what its
	// time says, so the pool lets it run ~1.7 s. Charging the children each
	// rebuilt node summarizes cuts it off as early as the other attacks.
	const runtime = await loadArboriumRuntime();
	const [wasm, highlights] = await Promise.all([
		readFile(JAVASCRIPT_GRAMMAR_WASM),
		readFile(JAVASCRIPT_HIGHLIGHTS_SCM, "utf8"),
	]);
	const javascript = await runtime.loadGrammar({
		languageId: "javascript",
		languageExport: "tree_sitter_javascript",
		wasm,
		highlights,
	});
	const session = javascript.createSession();
	try {
		const start = performance.now();
		session.setText(`\`${"a ".repeat(25_000)}`);
		const elapsed = performance.now() - start;

		const result = session.highlightToSpans();
		expect(result.spans).toEqual([]);
		expect(result.outOfFuelLanguages).toEqual(["javascript"]);
		expect(result.parseFuelUsed).toBeGreaterThanOrEqual(HIGHLIGHT_FUEL);
		expect(result.parseFuelUsed).toBeLessThan(HIGHLIGHT_FUEL * 1.05);
		// ~290 ms locally, against ~1.7 s were the rebuilds not charged and
		// ~2 s unbounded. Loose backstop for a slow CI box.
		expect(elapsed).toBeLessThan(1000);
	} finally {
		session.free();
		javascript.unregister();
	}
});

it("starts the next parse fresh after abandoning one", async () => {
	// tree-sitter resumes an abandoned parse on the next call unless the
	// parser is reset, which would parse the new text as a continuation of
	// the old.
	const runtime = await loadArboriumRuntime();
	const { markdown, kotlin } = await loadGrammars(runtime);
	const session = kotlin.createSession();
	try {
		session.setText(SUPERLINEAR_KOTLIN);
		expect(session.highlightToSpans().outOfFuelLanguages).toEqual(["kotlin"]);

		session.setText('fun main() {\n    println("hi")\n}\n');
		const result = session.highlightToSpans();
		expect(result.spans.length).toBeGreaterThan(0);
		expect(result.outOfFuelLanguages).toEqual([]);
	} finally {
		session.free();
		markdown.unregister();
		kotlin.unregister();
	}
});

it("charges the parse and the query to the same pool", async () => {
	// `fuelUsed` is the whole call's cost: the primary parse (run by
	// `setText`) plus its query. The raw parse reports the query alone.
	const runtime = await loadArboriumRuntime();
	const { markdown, kotlin } = await loadGrammars(runtime);
	const session = kotlin.createSession();
	try {
		session.setText(
			'fun main(args: Array<String>) {\n    val x = listOf(1, 2, 3).map { it * 2 }\n    println("hello $x")\n}\n'.repeat(
				50,
			),
		);
		const result = session.highlightToSpans({ maxInjectionDepth: 0 });
		const queryFuel = session.parse().fuel_used;

		expect(result.outOfFuelLanguages).toEqual([]);
		expect(result.parseFuelUsed).toBeGreaterThan(0);
		expect(queryFuel).toBeGreaterThan(0);
		expect(result.fuelUsed).toBe(result.parseFuelUsed + queryFuel);
	} finally {
		session.free();
		markdown.unregister();
		kotlin.unregister();
	}
});

it("leaves the host document highlighted when an injected parse runs out", async () => {
	const runtime = await loadArboriumRuntime();
	const { markdown, kotlin } = await loadGrammars(runtime);
	const session = markdown.createSession();
	try {
		session.setText(
			["# Heading", "", "```kotlin", SUPERLINEAR_KOTLIN, "```", ""].join("\n"),
		);

		const start = performance.now();
		const result = session.highlightToSpans();
		const elapsed = performance.now() - start;

		// The injected kotlin parse drains the pool and that block is
		// skipped; the markdown around it still highlights, and only kotlin
		// is reported.
		expect(result.spans.length).toBeGreaterThan(0);
		expect(result.outOfFuelLanguages).toContain("kotlin");
		expect(result.outOfFuelLanguages).not.toContain("markdown");
		expect(result.fuelUsed).toBeLessThan(HIGHLIGHT_FUEL * 1.05);
		expect(elapsed).toBeLessThan(1500);
	} finally {
		session.free();
		markdown.unregister();
		kotlin.unregister();
	}
});

it("bounds a document's parsing by the pool, not by the number of injected blocks", async () => {
	// Each `-}` x 200 block costs ~13e6 fuel to parse, comfortably inside the
	// pool on its own. Were every injected parse given its own allotment,
	// ten of them would cost ten times one. Sharing the call's pool, the
	// first blocks drain it and the rest are reported.
	const runtime = await loadArboriumRuntime();
	const { markdown, kotlin } = await loadGrammars(runtime);

	const blocks = (count: number) => {
		const lines: string[] = [];
		for (let i = 0; i < count; i++) {
			lines.push("```kotlin", "-}".repeat(200), "```", "");
		}
		return lines.join("\n");
	};

	const session = markdown.createSession();
	try {
		// One block fits in the pool.
		session.setText(blocks(1));
		expect(session.highlightToSpans().outOfFuelLanguages).toEqual([]);

		// Ten don't, though each alone would.
		session.setText(blocks(10));
		const start = performance.now();
		const result = session.highlightToSpans();
		const elapsed = performance.now() - start;

		expect(result.outOfFuelLanguages).toEqual(["kotlin"]);
		expect(result.spans.length).toBeGreaterThan(0);
		expect(result.fuelUsed).toBeLessThan(HIGHLIGHT_FUEL * 1.05);
		// ~280 ms locally, against ~49 ms per block (~490 ms for all ten)
		// were each block given its own allotment. Loose backstop for a slow
		// CI box.
		expect(elapsed).toBeLessThan(1500);
	} finally {
		session.free();
		markdown.unregister();
		kotlin.unregister();
	}
});
