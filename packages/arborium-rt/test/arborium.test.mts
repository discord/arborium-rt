// End-to-end integration test for @appellation/arborium-rt.
//
// Mirrors scripts/harness.mjs (repo-root), but drives the typed API rather
// than the raw ABI. Imports from `../dist/` so `loadArboriumRuntime()` can
// find its bundled host + runtime siblings under `dist/host/` and
// `dist/runtime/`. The `pretest` script builds + stages those assets.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadArboriumRuntime } from '../dist/index.js';

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

    it('consumes a generated @appellation/arborium-rt-<lang> package end-to-end', async () => {
        const { default: jsonGrammarPackage } = await import(
            resolve(repoRoot, 'target/packages/json/index.js')
        );

        const runtime = await loadArboriumRuntime();
        // The whole package is structurally a LoadGrammarOptions — no cherry-picking.
        const grammar = await runtime.loadGrammar(jsonGrammarPackage);
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
            const spans = session.highlightToSpans();

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

            const customElements = session.highlightToHtml();
            // Default format wraps captures in `<a-*>` tags. We assert only
            // that the output contains at least one such tag; the exact tag
            // depends on the theme-slot map which upstream owns.
            expect(customElements).toMatch(/<a-[a-z]+>/);

            const withClasses = session.highlightToHtml({ format: { kind: 'class-names' } });
            expect(withClasses).toMatch(/<span class="[^"]+">/);
        } finally {
            session.free();
            grammar.unregister();
        }
    });
});
