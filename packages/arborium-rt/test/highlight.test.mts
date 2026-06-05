import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { loadArboriumRuntime } from "../dist/index.js";
import { JSON_GRAMMAR_WASM, JSON_HIGHLIGHTS_SCM } from "./artifacts.mts";

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
