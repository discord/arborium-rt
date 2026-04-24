// Re-run `buildPackage` for every grammar whose wasm already exists under
// target/grammars/<lang>/. Skips the (slow) grammar build step — just
// regenerates packages/arborium-rt/dist/grammars/<lang>/ from the current
// renderers in build-package.ts. Useful after changing index.js / index.d.ts
// boilerplate.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { buildGrammarIndex } from './arborium-yaml.js';
import { buildPackage } from './build-package.js';
import { Logger, paths, runPool } from './util.js';
import { writeGrammarsIndexModule } from './write-grammars-index.js';

export interface PackageAllArgs {
    /** If set, only repackage these grammar ids. */
    only?: string[];
    /** Max concurrent package steps. Defaults to `os.availableParallelism()`. */
    jobs?: number;
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

    const jobs = Math.max(1, args.jobs ?? availableParallelism());
    const root = new Logger('package-all');

    await runPool(targets, jobs, async (id) => {
        const entry = index.get(id);
        if (!entry) {
            failed.push({ id, reason: 'not in grammar index' });
            return;
        }
        const log = new Logger(id);
        try {
            await buildPackage({ group: entry.group, lang: id, log, index });
            ok.push(id);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            failed.push({ id, reason });
            log.warn(`FAIL: ${reason}`);
        }
    });

    // One regeneration after every subdir is written — avoids the write
    // race that per-grammar calls would have under parallelism.
    writeGrammarsIndexModule();

    root.step(`regenerated ${ok.length}/${targets.length} grammar subpath(s)`);
    if (failed.length > 0) {
        root.step('failures:');
        for (const { id, reason } of failed) {
            root.info(`  ${id}: ${reason.split('\n')[0]}`);
        }
    }

    return { ok, failed };
}
