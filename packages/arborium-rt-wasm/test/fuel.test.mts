import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { loadArboriumRuntime } from "../dist/index.js";
import {
	KOTLIN_GRAMMAR_WASM,
	KOTLIN_HIGHLIGHTS_SCM,
	MARKDOWN_GRAMMAR_WASM,
	MARKDOWN_HIGHLIGHTS_SCM,
	MARKDOWN_INJECTIONS_SCM,
	TYPESCRIPT_GRAMMAR_WASM,
	TYPESCRIPT_HIGHLIGHTS_SCM,
} from "./artifacts.mts";

// Regression coverage for the kotlin chain-method DoS, and for the fuel
// budget that bounds it.
//
// arborium-plugin-runtime meters query work as *fuel* — a cost model of
// tree-sitter's query-cursor advance loop, charged inside the cursor's
// progress callback — and arborium-rt gives one highlight call a fixed pool
// of it (`HIGHLIGHT_FUEL` in src/highlight.rs) to share across every parse
// and query it runs, the primary grammar's and every injected block's.
// (Parsing is metered in the same fuel; parse-budget.test.mts covers the
// parse side.) The upstream kotlin highlights query
// is O(n^2) on deeply chained method calls — `a.b().b().b()…` — and at
// 16 KB of input the chain-bomb pattern would take ~3 s without the budget.
//
// These tests pair against the upstream submodule kotlin highlights (no
// downstream highlights patches) so they exercise the budget primitive
// directly. If the pool is removed or sized far too generously, they fail
// first.

/** Mirrors `HIGHLIGHT_FUEL` in src/highlight.rs. */
const HIGHLIGHT_FUEL = 110_000_000;

/**
 * `depth` chained `.b()` calls, wrapped so no single line is absurdly long
 * (the shape of the attack is the chain, not the line length).
 */
function chainBomb(depth: number): string[] {
	const raw = "a" + ".b()".repeat(depth);
	const lines: string[] = [];
	for (let i = 0; i < raw.length; i += 950) lines.push(raw.slice(i, i + 950));
	return lines;
}

async function loadKotlin(
	runtime: Awaited<ReturnType<typeof loadArboriumRuntime>>,
) {
	const [wasm, highlights] = await Promise.all([
		readFile(KOTLIN_GRAMMAR_WASM),
		readFile(KOTLIN_HIGHLIGHTS_SCM, "utf8"),
	]);
	return runtime.loadGrammar({
		// Kotlin's grammar exposes external_scanner_* helpers alongside
		// the canonical `tree_sitter_kotlin` symbol; disambiguate.
		languageId: "kotlin",
		languageExport: "tree_sitter_kotlin",
		wasm,
		highlights,
	});
}

it("caps query cost on a kotlin chain-method DoS via the fuel pool", async () => {
	const runtime = await loadArboriumRuntime();
	const grammar = await loadKotlin(runtime);
	const session = grammar.createSession();
	try {
		session.setText(chainBomb(4000).join("\n"));

		const start = performance.now();
		const result = session.highlightToSpans();
		const elapsed = performance.now() - start;

		// The pipeline surfaces which language(s) ran out of fuel so the
		// caller can tag metrics by grammar / fall back per-language. This
		// chain depth costs ~1.36e9 fuel unmetered — ~12x the pool — so it
		// always runs dry.
		expect(result.outOfFuelLanguages).toContain("kotlin");
		// Spent the pool (its parse first, then the query) and stopped: never
		// wildly past it, since the cursor is interruptible every 100
		// operations.
		expect(result.fuelUsed).toBeGreaterThanOrEqual(HIGHLIGHT_FUEL);
		expect(result.fuelUsed).toBeLessThan(HIGHLIGHT_FUEL * 1.05);

		// The fuel assertions above are the real check — they hold exactly on
		// any machine. This is a loose backstop for cost the fuel meter does
		// not see (span post-processing), with enough headroom for a slow or
		// loaded CI box: ~230 ms locally, against ~3 s pre-fix at this depth.
		expect(elapsed).toBeLessThan(2000);
	} finally {
		session.free();
		grammar.unregister();
	}
});

it("burns exactly the same fuel on every run", async () => {
	// The point of metering work instead of wall-clock time: output no longer
	// depends on how loaded the machine is. Two runs of the same document cut
	// off at the same place and produce the same spans — an assertion the old
	// 300 ms deadline could not have made.
	const runtime = await loadArboriumRuntime();
	const grammar = await loadKotlin(runtime);
	const session = grammar.createSession();
	try {
		session.setText(chainBomb(2000).join("\n"));

		const first = session.highlightToSpans();
		const second = session.highlightToSpans();

		expect(first.outOfFuelLanguages).toEqual(["kotlin"]);
		expect(second.fuelUsed).toBe(first.fuelUsed);
		expect(second.spans).toEqual(first.spans);
	} finally {
		session.free();
		grammar.unregister();
	}
});

it("leaves ordinary source files far inside the pool", async () => {
	// The cap has to be generous enough that real files are never truncated.
	// A ~750 KB TypeScript document — far larger than anything a code block
	// holds in practice — spends well under the pool and reports no
	// starvation.
	const runtime = await loadArboriumRuntime();
	const [wasm, highlights] = await Promise.all([
		readFile(TYPESCRIPT_GRAMMAR_WASM),
		readFile(TYPESCRIPT_HIGHLIGHTS_SCM, "utf8"),
	]);
	const grammar = await runtime.loadGrammar({
		languageId: "typescript",
		languageExport: "tree_sitter_typescript",
		wasm,
		highlights,
	});
	const session = grammar.createSession();
	try {
		const unit = await readFile(
			new URL("../src/runtime.ts", import.meta.url),
			"utf8",
		);
		session.setText(unit.repeat(40));

		const result = session.highlightToSpans();

		expect(result.outOfFuelLanguages).toEqual([]);
		expect(result.spans.length).toBeGreaterThan(10_000);
		// Measured ~80e6 for this input (~28e6 parsing, ~52e6 querying):
		// under the pool with room to spare. Ordinary documents up to ~1 MB
		// highlight in full.
		expect(result.fuelUsed).toBeLessThan(HIGHLIGHT_FUEL * 0.8);
	} finally {
		session.free();
		grammar.unregister();
	}
});

// Per-language scoping of the fuel signal: a markdown document that injects
// kotlin should report kotlin — not markdown — when the kotlin chain bomb
// fires inside an otherwise-cheap markdown frame. The markdown parse itself
// is small and finishes on a sliver of the pool.
//
// Without per-language scoping, callers can't tell whether to fall back the
// whole document or just the inline span — this test pins the contract.
it("reports the inner injected language, not the frame around it", async () => {
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

	const runtime = await loadArboriumRuntime();
	// Both grammars must live in the same runtime so the injection
	// resolver can find kotlin by its `languageId`. The markdown
	// injections.scm pulls the language name from the code fence's
	// info_string, then arborium-rt looks it up in the registry's
	// name → grammar_id map.
	const markdownGrammar = await runtime.loadGrammar({
		languageId: "markdown",
		languageExport: "tree_sitter_markdown",
		wasm: markdownWasm,
		highlights: markdownHighlights,
		injections: markdownInjections,
	});
	const kotlinGrammar = await runtime.loadGrammar({
		languageId: "kotlin",
		languageExport: "tree_sitter_kotlin",
		wasm: kotlinWasm,
		highlights: kotlinHighlights,
	});

	const session = markdownGrammar.createSession();
	try {
		// Wrap the chain in a fenced kotlin code block. A bit of surrounding
		// markdown so the markdown parse has actual work to do (heading +
		// paragraph) and we know it completed normally.
		session.setText(
			[
				"# Heading",
				"",
				"Some prose before the code block.",
				"",
				"```kotlin",
				...chainBomb(4000),
				"```",
				"",
				"Trailing prose after the code block.",
			].join("\n"),
		);

		const result = session.highlightToSpans();

		// kotlin's chain bomb drains the pool.
		expect(result.outOfFuelLanguages).toContain("kotlin");
		// The surrounding markdown completed normally — the signal is
		// per-grammar, not aggregate.
		expect(result.outOfFuelLanguages).not.toContain("markdown");
	} finally {
		session.free();
		kotlinGrammar.unregister();
		markdownGrammar.unregister();
	}
});

it("bounds a document by the pool, not by the number of injected blocks", async () => {
	// The pool is per highlight call, not per query. Ten chain bombs in one
	// markdown document therefore cost the same as one — the first blocks
	// drain the pool and the rest are skipped and reported. Under a
	// per-query budget this document would cost 10x a single block, which is
	// exactly the hole a shared pool closes.
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

	const runtime = await loadArboriumRuntime();
	const markdownGrammar = await runtime.loadGrammar({
		languageId: "markdown",
		languageExport: "tree_sitter_markdown",
		wasm: markdownWasm,
		highlights: markdownHighlights,
		injections: markdownInjections,
	});
	const kotlinGrammar = await runtime.loadGrammar({
		languageId: "kotlin",
		languageExport: "tree_sitter_kotlin",
		wasm: kotlinWasm,
		highlights: kotlinHighlights,
	});

	const session = markdownGrammar.createSession();
	try {
		const lines: string[] = [];
		for (let i = 0; i < 10; i++) {
			lines.push(
				`## block ${i}`,
				"",
				"```kotlin",
				...chainBomb(2000),
				"```",
				"",
			);
		}
		session.setText(lines.join("\n"));

		const start = performance.now();
		const result = session.highlightToSpans();
		const elapsed = performance.now() - start;

		expect(result.outOfFuelLanguages).toContain("kotlin");
		expect(result.fuelUsed).toBeLessThan(HIGHLIGHT_FUEL * 1.05);
		// ~120 ms locally for all ten blocks; ~6.8 s pre-fix, which is what
		// this bound is really watching for.
		expect(elapsed).toBeLessThan(3000);
	} finally {
		session.free();
		kotlinGrammar.unregister();
		markdownGrammar.unregister();
	}
});
