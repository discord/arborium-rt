import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { ArboriumError, loadArboriumRuntime } from "../dist/index.js";
import {
	KOTLIN_GRAMMAR_WASM,
	KOTLIN_HIGHLIGHTS_SCM,
	MARKDOWN_GRAMMAR_WASM,
	MARKDOWN_HIGHLIGHTS_SCM,
	MARKDOWN_INJECTIONS_SCM,
} from "./artifacts.mts";

// Coverage for the parse budget (`PARSE_OPERATIONS_PER_BYTE` in
// arborium-plugin-runtime). Query fuel only meters the query cursor, so the
// tree-sitter parse that `setText` runs needs its own bound. The budget scales
// with input length: ordinary source costs ~0.5–7 parser operations per byte
// and stays inside it, while a parse that grows faster than its input is
// abandoned.
//
// Repeated `-}` is one such input for the kotlin grammar: its cost per byte
// roughly doubles each time the input doubles, and 4 KB of it takes ~3 s to
// parse unbounded.

const SUPERLINEAR_KOTLIN = "-}".repeat(2000);

async function loadKotlin(
	runtime: Awaited<ReturnType<typeof loadArboriumRuntime>>,
) {
	const [wasm, highlights] = await Promise.all([
		readFile(KOTLIN_GRAMMAR_WASM),
		readFile(KOTLIN_HIGHLIGHTS_SCM, "utf8"),
	]);
	return runtime.loadGrammar({
		languageId: "kotlin",
		languageExport: "tree_sitter_kotlin",
		wasm,
		highlights,
	});
}

function highlightError(highlight: () => unknown): unknown {
	try {
		highlight();
	} catch (error) {
		return error;
	}
	return undefined;
}

it("abandons a parse that grows faster than its input", async () => {
	const runtime = await loadArboriumRuntime();
	const grammar = await loadKotlin(runtime);
	const session = grammar.createSession();
	try {
		const start = performance.now();
		session.setText(SUPERLINEAR_KOTLIN);
		const elapsed = performance.now() - start;

		// An abandoned parse leaves the session with no tree, so highlighting
		// fails cleanly instead of running on a partial one.
		const error = highlightError(() => session.highlightToSpans());
		expect(error).toBeInstanceOf(ArboriumError);
		expect((error as ArboriumError).kind).toBe("highlight-failed");

		// The operation count above is what's deterministic; this is a loose
		// backstop with headroom for a slow CI box, against ~3 s unbounded.
		expect(elapsed).toBeLessThan(1000);
	} finally {
		session.free();
		grammar.unregister();
	}
});

it("starts the next parse fresh after abandoning one", async () => {
	// tree-sitter resumes an abandoned parse on the next call unless the
	// parser is reset, which would parse the new text as a continuation of
	// the old.
	const runtime = await loadArboriumRuntime();
	const grammar = await loadKotlin(runtime);
	const session = grammar.createSession();
	try {
		session.setText(SUPERLINEAR_KOTLIN);
		expect(highlightError(() => session.highlightToSpans())).toBeDefined();

		session.setText('fun main() {\n    println("hi")\n}\n');
		const result = session.highlightToSpans();
		expect(result.spans.length).toBeGreaterThan(0);
	} finally {
		session.free();
		grammar.unregister();
	}
});

it("leaves the host document highlighted when an injected block runs out", async () => {
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
		session.setText(
			["# Heading", "", "```kotlin", SUPERLINEAR_KOTLIN, "```", ""].join("\n"),
		);

		const start = performance.now();
		const result = session.highlightToSpans();
		const elapsed = performance.now() - start;

		// The injected kotlin parse is abandoned and that block is skipped;
		// the markdown around it still highlights.
		expect(result.spans.length).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(1000);
	} finally {
		session.free();
		markdownGrammar.unregister();
		kotlinGrammar.unregister();
	}
});
