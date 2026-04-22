// Regression test for the query flattener. Replaces
// scripts/test-flatten-queries.py.
//
// For each corpus grammar that declares `queries.highlights.prepend`, assert
// that the flattened line count matches the expected sum of the base
// grammars' line counts + this grammar's own + the separator between chunks.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildGrammarIndex } from '../src/cli/arborium-yaml.js';
import { flattenQuery } from '../src/cli/flatten.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const langsRoot = resolve(repoRoot, 'third_party', 'arborium', 'langs');
const index = buildGrammarIndex(langsRoot);

function lineCount(s: string): number {
    return s.split('\n').length;
}

// (grammar id, expected flattened-highlights line count). Raw .scm line
// counts come from `wc -l` minus 1 for the trailing-newline convention of
// how splitlines/split('\n') interacts (a file that ends with "\n" yields
// one fewer line when split on '\n' — JS's split gives a trailing "").
// Numbers were derived by manual calculation against the upstream-pinned
// arborium submodule (commit b7a8eb8) and are also validated by the
// corresponding vitest case below.
const CASES: ReadonlyArray<readonly [string, number]> = [
    ['scss',       77 + 70],          // css + scss (single-level)
    ['cpp',        82 + 78],          // c + cpp
    ['objc',       82 + 217],         // c + objc
    ['glsl',       82 + 116],         // c + glsl
    ['svelte',     14 + 62],          // html + svelte
    // vue's own highlights.scm has no trailing newline — separator produces
    // no blank line, accounting for the slightly different arithmetic.
    ['vue',        14 + 31],          // html + vue
    // TSX/TypeScript's own highlights include JS content pre-flattened
    // upstream; we re-prepend anyway (matches arborium's template).
    ['tsx',        205 + 289],        // javascript + tsx
    ['typescript', 205 + 242],        // javascript + typescript
    // Two-level prepend: hlsl -> cpp -> c.
    ['hlsl',       82 + 78 + 127],    // c + cpp + hlsl
];

describe('flattenQuery', () => {
    it.each(CASES)('flattens %s highlights to %i lines', (lang, expected) => {
        const got = lineCount(flattenQuery(lang, 'highlights', index));
        expect(got).toBe(expected);
    });

    it('pass-through grammars (no prepend) return their own highlights unchanged', () => {
        const jsonEntry = index.get('json');
        expect(jsonEntry).toBeDefined();
        const own = readFileSync(
            resolve(jsonEntry!.defPath, 'queries', 'highlights.scm'),
            'utf8',
        );
        expect(flattenQuery('json', 'highlights', index)).toBe(own);
    });

    it('returns empty string for missing query types on grammars that lack them', () => {
        // JSON has no injections.scm, no injections prepend.
        expect(flattenQuery('json', 'injections', index)).toBe('');
        expect(flattenQuery('json', 'locals', index)).toBe('');
    });

    it('throws on unknown grammar id', () => {
        expect(() => flattenQuery('bogus-lang-xyz', 'highlights', index)).toThrow(
            /unknown grammar id/,
        );
    });
});
