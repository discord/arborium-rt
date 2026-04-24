// Smoke tests for the bundled THEMES index + the CSS shape emitted by
// `crates/theme-codegen`. The `pretest` hook runs `stage` so the
// fixtures under dist/themes/ are fresh.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { THEMES } from '../dist/index.js';

describe('THEMES index', () => {
    it('exposes every bundled theme with id/name/variant/css URL', () => {
        const ids = Object.keys(THEMES);
        // The submodule currently ships 32 themes. Assert lower bound so
        // adding one doesn't break the test; assert upper to catch accidental
        // runaway output.
        expect(ids.length).toBeGreaterThan(20);
        expect(ids.length).toBeLessThan(100);

        for (const [id, entry] of Object.entries(THEMES)) {
            expect(entry.themeId).toBe(id);
            expect(entry.name).toBeTypeOf('string');
            expect(entry.name.length).toBeGreaterThan(0);
            expect(['dark', 'light']).toContain(entry.variant);
            expect(entry.css).toBeInstanceOf(URL);
            expect(entry.css.pathname).toMatch(new RegExp(`/themes/${id}\\.css$`));
        }
    });

    it('every css URL resolves to a file scoped under .arborium-<id>', async () => {
        await Promise.all(
            Object.values(THEMES).map(async (entry) => {
                const body = await readFile(fileURLToPath(entry.css), 'utf8');
                expect(body).toMatch(new RegExp(`\\.arborium-${entry.themeId}\\s*\\{`));
            }),
        );
    });
});

describe('theme CSS shape (one-dark as representative)', () => {
    it('emits per-slot --arb-<tag> custom properties', async () => {
        const body = await readOneDarkCss();
        // Background + foreground vars derived from top-level theme fields.
        expect(body).toMatch(/--arb-bg:\s*#[0-9a-f]{6};/);
        expect(body).toMatch(/--arb-fg:\s*#[0-9a-f]{6};/);
        // A handful of per-slot vars — arborium's tags are stable.
        for (const tag of ['k', 'f', 's', 'c', 't']) {
            expect(body).toMatch(new RegExp(`--arb-${tag}:\\s*#[0-9a-f]{6};`));
        }
    });

    it('root-level background/color reference the vars, not concrete hex', async () => {
        const body = await readOneDarkCss();
        expect(body).toMatch(/\n\s*background:\s*var\(--arb-bg\);/);
        expect(body).toMatch(/\n\s*color:\s*var\(--arb-fg\);/);
        // The concrete-hex form the pre-var generator produced must NOT
        // reappear — regressing to that breaks every downstream var override.
        expect(body).not.toMatch(/\n\s*background:\s*#[0-9a-f]{6};/);
    });

    it('element rules consume the vars via var(--arb-<tag>)', async () => {
        const body = await readOneDarkCss();
        // The specific tags we just asserted vars for must also appear as
        // element rules referencing those vars.
        for (const tag of ['k', 'f', 's', 'c', 't']) {
            expect(body).toMatch(new RegExp(`a-${tag}\\s*\\{[^}]*color:\\s*var\\(--arb-${tag}\\);`));
        }
    });

    it('modifier-only rules stay concrete (no var indirection)', async () => {
        const body = await readOneDarkCss();
        // `a-em` / `a-st` are modifier-only — no color, just font-style /
        // font-weight. They should appear as plain property:value pairs.
        expect(body).toMatch(/a-em\s*\{[^}]*font-style:\s*italic;/);
        expect(body).toMatch(/a-st\s*\{[^}]*font-weight:\s*bold;/);
    });

    it('light variants still carry bg/fg/slot vars', async () => {
        const light = THEMES['github-light'];
        expect(light).toBeDefined();
        expect(light!.variant).toBe('light');
        const body = await readFile(fileURLToPath(light!.css), 'utf8');
        expect(body).toMatch(/--arb-bg:\s*#[0-9a-f]{6};/);
        expect(body).toMatch(/--arb-k:\s*#[0-9a-f]{6};/);
    });
});

async function readOneDarkCss(): Promise<string> {
    const entry = THEMES['one-dark'];
    expect(entry).toBeDefined();
    return readFile(fileURLToPath(entry!.css), 'utf8');
}
