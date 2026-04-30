// End-to-end integration test for @discord/arborium-rt.
//
// Mirrors scripts/harness.mjs (repo-root), but drives the typed API rather
// than the raw ABI. Imports from `../dist/` so `loadArboriumRuntime()` can
// find its bundled host + runtime siblings under `dist/host/` and
// `dist/runtime/`. The `pretest` script builds + stages those assets.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GRAMMARS, loadArboriumRuntime } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const JSON_GRAMMAR_WASM = resolve(
    repoRoot,
    'target/grammars/json/tree-sitter-json.wasm',
);
const JSON_HIGHLIGHTS_SCM = resolve(
    repoRoot,
    'third_party/arborium/langs/group-acorn/json/def/queries/highlights.scm',
);
const KOTLIN_GRAMMAR_WASM = resolve(
    repoRoot,
    'target/grammars/kotlin/tree-sitter-kotlin.wasm',
);
// Read the post-flatten output from target/grammars rather than the raw
// submodule source, so the test sees what the build pipeline actually ships
// — this matters in CI where the `package` job downloads the artifact built
// by the `grammars` job and never re-flattens.
const KOTLIN_HIGHLIGHTS_SCM = resolve(
    repoRoot,
    'target/grammars/kotlin/highlights.scm',
);
const MARKDOWN_GRAMMAR_WASM = resolve(
    repoRoot,
    'target/grammars/markdown/tree-sitter-markdown.wasm',
);
const MARKDOWN_HIGHLIGHTS_SCM = resolve(
    repoRoot,
    'target/grammars/markdown/highlights.scm',
);
const MARKDOWN_INJECTIONS_SCM = resolve(
    repoRoot,
    'target/grammars/markdown/injections.scm',
);

describe('loadArboriumRuntime + Grammar + Session', () => {
    it('parses JSON and emits number spans for literal digits', async () => {
        const [grammarWasm, highlights] = await Promise.all([
            readFile(JSON_GRAMMAR_WASM),
            readFile(JSON_HIGHLIGHTS_SCM, 'utf8'),
        ]);

        const runtime = await loadArboriumRuntime();
        const grammar = await runtime.loadGrammar({
            languageId: 'json',
            wasm: grammarWasm,
            highlights,
        });
        const session = grammar.createSession();
        try {
            session.setText('[1, 2, 3]');
            const result = session.parse();
            expect(result.injections).toEqual([]);
            // The digit characters sit at UTF-16 positions 1, 4, 7 in "[1, 2, 3]".
            expect(result.spans).toHaveLength(3);
            expect(result.spans.map((s) => [s.start, s.end, s.capture])).toEqual([
                [1, 2, 'number'],
                [4, 5, 'number'],
                [7, 8, 'number'],
            ]);
        } finally {
            session.free();
            grammar.unregister();
        }
    });

    it('consumes a bundled grammar end-to-end', async () => {
        // Mirrors how a consumer uses the bundled metadata:
        //   import { GRAMMARS } from '@discord/arborium-rt';
        //   const grammar = await runtime.loadGrammar(GRAMMARS.json);
        const runtime = await loadArboriumRuntime();
        // Entry is structurally a LoadGrammarOptions — URL-typed queries are
        // fetched by loadGrammar itself.
        const grammar = await runtime.loadGrammar(GRAMMARS.json);
        const session = grammar.createSession();
        try {
            session.setText('{"x": 42}');
            const result = session.parse();
            const captures = result.spans.map((s) => s.capture).sort();
            // { "x": 42 } should produce: @string.special.key, @string (for "x"),
            // @number (for 42). Order within the spans list follows tree-sitter
            // match order, so compare sets.
            expect(captures).toEqual(['number', 'string', 'string.special.key']);
        } finally {
            session.free();
            grammar.unregister();
        }
    });

    it('supports multiple sessions against the same grammar', async () => {
        const [grammarWasm, highlights] = await Promise.all([
            readFile(JSON_GRAMMAR_WASM),
            readFile(JSON_HIGHLIGHTS_SCM, 'utf8'),
        ]);

        const runtime = await loadArboriumRuntime();
        const grammar = await runtime.loadGrammar({
            languageId: 'json',
            wasm: grammarWasm,
            highlights,
        });

        const s1 = grammar.createSession();
        const s2 = grammar.createSession();
        expect(s1.id).not.toBe(s2.id);

        s1.setText('true');
        s2.setText('"hi"');
        const r1 = s1.parse();
        const r2 = s2.parse();

        expect(r1.spans.map((s) => s.capture)).toEqual(['constant.builtin']);
        expect(r2.spans.map((s) => s.capture)).toEqual(['string']);

        s1.free();
        s2.free();
        grammar.unregister();
    });

    it('produces themed spans via the full highlight pipeline', async () => {
        const [grammarWasm, highlights] = await Promise.all([
            readFile(JSON_GRAMMAR_WASM),
            readFile(JSON_HIGHLIGHTS_SCM, 'utf8'),
        ]);

        const runtime = await loadArboriumRuntime();
        const grammar = await runtime.loadGrammar({
            languageId: 'json',
            wasm: grammarWasm,
            highlights,
        });
        const session = grammar.createSession();
        try {
            session.setText('[1, 2, 3]');
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

    it('renders HTML via the full highlight pipeline', async () => {
        const [grammarWasm, highlights] = await Promise.all([
            readFile(JSON_GRAMMAR_WASM),
            readFile(JSON_HIGHLIGHTS_SCM, 'utf8'),
        ]);

        const runtime = await loadArboriumRuntime();
        const grammar = await runtime.loadGrammar({
            languageId: 'json',
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

            const { html: withClasses } = session.highlightToHtml({ format: { kind: 'class-names' } });
            expect(withClasses).toMatch(/<span class="[^"]+">/);
        } finally {
            session.free();
            grammar.unregister();
        }
    });

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
    it('caps query cost on a kotlin chain-method DoS via the runtime budget', async () => {
        const [grammarWasm, highlights] = await Promise.all([
            readFile(KOTLIN_GRAMMAR_WASM),
            readFile(KOTLIN_HIGHLIGHTS_SCM, 'utf8'),
        ]);

        const runtime = await loadArboriumRuntime();
        const grammar = await runtime.loadGrammar({
            // Kotlin's grammar exposes external_scanner_* helpers alongside
            // the canonical `tree_sitter_kotlin` symbol; disambiguate.
            languageId: 'kotlin',
            languageExport: 'tree_sitter_kotlin',
            wasm: grammarWasm,
            highlights,
        });
        const session = grammar.createSession();
        try {
            const depth = 4000;
            const raw = 'a' + '.b()'.repeat(depth);
            const lines: string[] = [];
            for (let i = 0; i < raw.length; i += 950) {
                lines.push(raw.slice(i, i + 950));
            }
            session.setText(lines.join('\n'));

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
            expect(result.timedOutLanguages).toContain('kotlin');
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
    it('reports only the inner injected language when its parse times out', async () => {
        const [
            markdownWasm,
            markdownHighlights,
            markdownInjections,
            kotlinWasm,
            kotlinHighlights,
        ] = await Promise.all([
            readFile(MARKDOWN_GRAMMAR_WASM),
            readFile(MARKDOWN_HIGHLIGHTS_SCM, 'utf8'),
            readFile(MARKDOWN_INJECTIONS_SCM, 'utf8'),
            readFile(KOTLIN_GRAMMAR_WASM),
            readFile(KOTLIN_HIGHLIGHTS_SCM, 'utf8'),
        ]);

        const runtime = await loadArboriumRuntime();
        // Both grammars must live in the same runtime so the injection
        // resolver can find kotlin by its `languageId`. The markdown
        // injections.scm pulls the language name from the code fence's
        // info_string, then arborium-rt looks it up in the registry's
        // name → grammar_id map.
        const markdownGrammar = await runtime.loadGrammar({
            languageId: 'markdown',
            languageExport: 'tree_sitter_markdown',
            wasm: markdownWasm,
            highlights: markdownHighlights,
            injections: markdownInjections,
        });
        const kotlinGrammar = await runtime.loadGrammar({
            languageId: 'kotlin',
            languageExport: 'tree_sitter_kotlin',
            wasm: kotlinWasm,
            highlights: kotlinHighlights,
        });

        const session = markdownGrammar.createSession();
        try {
            const depth = 4000;
            const chain = 'a' + '.b()'.repeat(depth);
            // Wrap the chain in a fenced kotlin code block. A bit of
            // surrounding markdown so the markdown parse has actual
            // work to do (heading + paragraph) and we know it
            // completed normally.
            const lines: string[] = [];
            lines.push('# Heading');
            lines.push('');
            lines.push('Some prose before the code block.');
            lines.push('');
            lines.push('```kotlin');
            for (let i = 0; i < chain.length; i += 950) {
                lines.push(chain.slice(i, i + 950));
            }
            lines.push('```');
            lines.push('');
            lines.push('Trailing prose after the code block.');
            session.setText(lines.join('\n'));

            const result = session.highlightToSpans();

            // kotlin's chain bomb should hit the budget.
            expect(result.timedOutLanguages).toContain('kotlin');
            // The surrounding markdown completed normally — the
            // signal is per-grammar, not aggregate.
            expect(result.timedOutLanguages).not.toContain('markdown');
        } finally {
            session.free();
            kotlinGrammar.unregister();
            markdownGrammar.unregister();
        }
    });
});
