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
// Read the flattened, post-bootstrap-patched highlights from target/grammars,
// not the raw submodule source under third_party/arborium/. CI's `package`
// job runs `actions/checkout@v4` with `submodules: recursive` (which fetches
// the submodule at its pinned SHA) but does NOT run `arborium-rt bootstrap`
// — only the upstream `prep` and `grammars` jobs do — so the submodule's
// def/queries/ files in that job are unpatched. The grammars artifact
// downloaded into target/grammars/ contains the post-patch, post-flatten
// output and is what gets shipped in the published tarball.
const KOTLIN_HIGHLIGHTS_SCM = resolve(
    repoRoot,
    'target/grammars/kotlin/highlights.scm',
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

    // Regression coverage for the kotlin chain-method DoS (CVSS 4.0 / VA:H).
    // Two things this exercises that the JSON tests don't:
    //
    //   1. The `callable.chain` scaffolding capture is consumed by the
    //      pipeline's `apply_call_context_upgrades` pass and never appears
    //      in user-visible output.
    //   2. The chain `obj.foo().bar()` is genuinely O(n): the highlight
    //      query runs in single-digit ms even at 4000 chained calls — i.e.
    //      `(call_expression (navigation_expression (navigation_suffix …)))`
    //      is no longer driving `ts_query_cursor_exec` quadratic.
    describe('kotlin: chain-method highlighting + DoS regression', () => {
        const loadKotlin = async () => {
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
            return { runtime, grammar };
        };

        it('upgrades chained method names from @property to @function', async () => {
            const { grammar } = await loadKotlin();
            const session = grammar.createSession();
            try {
                // `obj.x.y()` — `y` is the call target; `x` is a chain-internal
                // property access. Pipeline post-process should retag the
                // simple_identifier ending at the same byte as the receiver
                // chain (= `y`) into @function (theme tag "f"), while `x`
                // stays @property (theme tag "pr").
                const src = 'fun f() { obj.x.y() }\n';
                session.setText(src);
                const { spans } = session.highlightToSpans();
                const yStart = src.indexOf('.y(') + 1;
                const yEnd = yStart + 1;
                const xStart = src.indexOf('.x.') + 1;
                const xEnd = xStart + 1;

                const ySpan = spans.find((s) => s.start === yStart && s.end === yEnd);
                const xSpan = spans.find((s) => s.start === xStart && s.end === xEnd);

                // The pipeline strips the `callable.chain` scaffolding
                // capture entirely — it has no theme tag and exists only to
                // drive the post-process upgrade.
                expect(spans.find((s) => s.tag === 'callable.chain')).toBeUndefined();

                // Call target retagged to @function; chain-internal property
                // stays @property. Theme tags from `arborium_theme::tag_for_capture`
                // ("f" = function, "pr" = property).
                expect(ySpan?.tag).toBe('f');
                expect(xSpan?.tag).toBe('pr');
            } finally {
                session.free();
                grammar.unregister();
            }
        });

        it('runs a 4000-deep chain in well under 1 s (was 3 s pre-fix)', async () => {
            const { grammar } = await loadKotlin();
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
                const { spans } = session.highlightToSpans();
                const elapsed = performance.now() - start;
                // Pre-fix: ~3000 ms. Post-fix (Path 2): ~30 ms. We pad
                // generously to keep the test stable across machines without
                // letting a regression to O(n^2) sneak through.
                expect(elapsed).toBeLessThan(500);
                expect(spans.length).toBeGreaterThan(0);
            } finally {
                session.free();
                grammar.unregister();
            }
        });
    });
});
