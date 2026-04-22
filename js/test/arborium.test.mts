// End-to-end integration test for @discord/arborium-rt.
//
// Mirrors scripts/harness.mjs (repo-root), but drives the typed API rather
// than the raw ABI. Reads the three wasms + highlights.scm directly from
// target/ so the test works in a fresh checkout after `cargo build` +
// `build-host-wasm.sh` + `build-grammar.sh group-acorn json`.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadArboriumRuntime } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const HOST_MJS = resolve(repoRoot, 'target/host-wasm/web-tree-sitter.mjs');
const RUNTIME_WASM = resolve(
    repoRoot,
    'target/wasm32-unknown-emscripten/release/arborium_emscripten_runtime.wasm',
);
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
        const { default: hostModuleFactory } = await import(HOST_MJS);
        const [runtimeWasm, grammarWasm, highlights] = await Promise.all([
            readFile(RUNTIME_WASM),
            readFile(JSON_GRAMMAR_WASM),
            readFile(JSON_HIGHLIGHTS_SCM, 'utf8'),
        ]);

        const runtime = await loadArboriumRuntime({
            hostModuleFactory,
            runtimeWasm,
        });
        const grammar = await runtime.loadGrammar({
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

    it('consumes a generated @arborium-rt/<lang> package end-to-end', async () => {
        const { default: hostModuleFactory } = await import(HOST_MJS);
        const { default: jsonGrammarPackage } = await import(
            resolve(repoRoot, 'target/packages/json/index.js')
        );
        const runtimeWasm = await readFile(RUNTIME_WASM);

        const runtime = await loadArboriumRuntime({ hostModuleFactory, runtimeWasm });
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
        const { default: hostModuleFactory } = await import(HOST_MJS);
        const [runtimeWasm, grammarWasm, highlights] = await Promise.all([
            readFile(RUNTIME_WASM),
            readFile(JSON_GRAMMAR_WASM),
            readFile(JSON_HIGHLIGHTS_SCM, 'utf8'),
        ]);

        const runtime = await loadArboriumRuntime({ hostModuleFactory, runtimeWasm });
        const grammar = await runtime.loadGrammar({ wasm: grammarWasm, highlights });

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
});
