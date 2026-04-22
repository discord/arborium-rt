// Re-run `buildPackage` for every grammar whose wasm already exists under
// target/grammars/<lang>/. Skips the (slow) grammar build step — just
// regenerates packages/arborium-rt/dist/grammars/<lang>/ from the current
// renderers in build-package.ts. Useful after changing index.js / index.d.ts
// boilerplate.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildGrammarIndex } from './arborium-yaml.js';
import { buildPackage } from './build-package.js';
import { paths, step } from './util.js';

export interface PackageAllArgs {
    /** If set, only repackage these grammar ids. */
    only?: string[];
}

export interface PackageAllResult {
    readonly ok: string[];
    readonly failed: Array<{ id: string; reason: string }>;
}

export async function packageAll(args: PackageAllArgs = {}): Promise<PackageAllResult> {
    const p = paths();
    const index = buildGrammarIndex(p.langsRoot);

    if (!existsSync(p.grammarsOut)) {
        throw new Error(
            `no grammar build artifacts at ${p.grammarsOut}. run \`arborium-rt build-all\` first.`,
        );
    }

    const wanted = (args.only && args.only.length > 0) ? new Set(args.only) : undefined;

    const candidates = readdirSync(p.grammarsOut)
        .filter((name) => statSync(join(p.grammarsOut, name)).isDirectory())
        .filter((name) => existsSync(join(p.grammarsOut, name, `tree-sitter-${name}.wasm`)))
        .sort();

    const targets = wanted ? candidates.filter((id) => wanted.has(id)) : candidates;

    const ok: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];

    for (const [i, id] of targets.entries()) {
        const entry = index.get(id);
        if (!entry) {
            failed.push({ id, reason: 'not in grammar index' });
            continue;
        }
        const progress = `[${i + 1}/${targets.length}]`;
        process.stderr.write(`\n===== ${progress} ${entry.group}/${id} =====\n`);
        try {
            await buildPackage({ group: entry.group, lang: id });
            ok.push(id);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            failed.push({ id, reason });
            process.stderr.write(`FAIL ${id}: ${reason}\n`);
        }
    }

    step(`regenerated ${ok.length}/${targets.length} grammar subpath(s)`);
    if (failed.length > 0) {
        process.stderr.write(`\nfailures:\n`);
        for (const { id, reason } of failed) {
            process.stderr.write(`  ${id}: ${reason.split('\n')[0]}\n`);
        }
    }

    return { ok, failed };
}
