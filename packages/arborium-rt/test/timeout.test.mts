import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { loadArboriumRuntime } from "../dist/index.js";
import {
	KOTLIN_GRAMMAR_WASM,
	KOTLIN_HIGHLIGHTS_SCM,
	MARKDOWN_GRAMMAR_WASM,
	MARKDOWN_HIGHLIGHTS_SCM,
	MARKDOWN_INJECTIONS_SCM,
} from "./artifacts.mts";

// Regression coverage for the kotlin chain-method DoS.
//
// arborium-plugin-runtime sets a 100 ms wall-clock budget on every
// QueryCursor exec. The upstream kotlin highlights query is O(n^2)
// on deeply chained method calls — `a.b().b().b()…` — and at 16 KB
// of input the chain-bomb pattern would take ~3 s without the
// budget. With the budget the cursor's progress callback fires
// inside `ts_query_cursor_exec`'s hot loop and bails out early,
// returning whatever spans were collected so far.
//
// This test pairs against the upstream submodule kotlin highlights
// (no downstream highlights patches) so it exercises the budget
// primitive directly. If the budget is removed or set too high,
// this test fails first.
it("caps query cost on a kotlin chain-method DoS via the runtime budget", async () => {
	const [grammarWasm, highlights] = await Promise.all([
		readFile(KOTLIN_GRAMMAR_WASM),
		readFile(KOTLIN_HIGHLIGHTS_SCM, "utf8"),
	]);

	const runtime = await loadArboriumRuntime();
	const grammar = await runtime.loadGrammar({
		// Kotlin's grammar exposes external_scanner_* helpers alongside
		// the canonical `tree_sitter_kotlin` symbol; disambiguate.
		languageId: "kotlin",
		languageExport: "tree_sitter_kotlin",
		wasm: grammarWasm,
		highlights,
	});
	const session = grammar.createSession();
	try {
		const depth = 4000;
		const raw = "a" + ".b()".repeat(depth);
		const lines: string[] = [];
		for (let i = 0; i < raw.length; i += 950) {
			lines.push(raw.slice(i, i + 950));
		}
		session.setText(lines.join("\n"));

		const start = performance.now();
		const result = session.highlightToSpans();
		const elapsed = performance.now() - start;

		// 100 ms runtime budget + dedup/coalesce/UTF-16 conversion +
		// setup. 500 ms cap keeps the test stable across machines
		// while still failing loudly on an O(n^2) regression
		// (pre-fix: ~3 s at this depth).
		expect(elapsed).toBeLessThan(500);
		// The pipeline surfaces which language(s) timed out so the
		// caller can tag metrics by grammar / fall back per-language.
		// On this chain depth the kotlin parse should always exceed
		// the budget.
		expect(result.timedOutLanguages).toContain("kotlin");
	} finally {
		session.free();
		grammar.unregister();
	}
});

// Per-language scoping of the timeout signal: a markdown document
// that injects kotlin should report ONLY kotlin in
// `timedOutLanguages` when the kotlin chain bomb fires inside an
// otherwise-cheap markdown frame. The markdown parse itself is
// small and finishes well under the budget.
//
// Without per-language scoping, callers can't tell whether to
// fall back the whole document or just the inline span — this
// test pins the contract.
it("reports only the inner injected language when its parse times out", async () => {
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
		const depth = 4000;
		const chain = "a" + ".b()".repeat(depth);
		// Wrap the chain in a fenced kotlin code block. A bit of
		// surrounding markdown so the markdown parse has actual
		// work to do (heading + paragraph) and we know it
		// completed normally.
		const lines: string[] = [];
		lines.push("# Heading");
		lines.push("");
		lines.push("Some prose before the code block.");
		lines.push("");
		lines.push("```kotlin");
		for (let i = 0; i < chain.length; i += 950) {
			lines.push(chain.slice(i, i + 950));
		}
		lines.push("```");
		lines.push("");
		lines.push("Trailing prose after the code block.");
		session.setText(lines.join("\n"));

		const result = session.highlightToSpans();

		// kotlin's chain bomb should hit the budget.
		expect(result.timedOutLanguages).toContain("kotlin");
		// The surrounding markdown completed normally — the
		// signal is per-grammar, not aggregate.
		expect(result.timedOutLanguages).not.toContain("markdown");
	} finally {
		session.free();
		kotlinGrammar.unregister();
		markdownGrammar.unregister();
	}
});
