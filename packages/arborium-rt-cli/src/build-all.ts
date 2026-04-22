// Iterate every grammar in the arborium submodule, attempt
// build-grammar + package, collect per-grammar results.
//
// Grammars fail for a variety of reasons (tree-sitter-generate ABI mismatches,
// missing upstream node_modules that aren't declared in arborium.yaml,
// structurally-odd vendored layouts). Each failure is logged but doesn't
// abort the run; the closing summary names winners and losers.

import { buildGrammarIndex } from './arborium-yaml.js';
import { buildGrammar } from './build-grammar.js';
import { buildPackage } from './build-package.js';
import { paths } from './util.js';

export interface BuildAllArgs {
    /** If set, only try these grammar ids (for debugging). */
    only?: string[];
    /** If set, don't run `package` after `build-grammar` (wasm + queries only). */
    skipPackage?: boolean;
}

export interface BuildAllResult {
    readonly ok: string[];
    readonly failed: Array<{ id: string; reason: string }>;
}

export async function buildAll(args: BuildAllArgs = {}): Promise<BuildAllResult> {
    const p = paths();
    const index = buildGrammarIndex(p.langsRoot);

    const targets = (args.only && args.only.length > 0)
        ? args.only.filter((id) => index.has(id))
        : [...index.keys()].sort();

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
            await buildGrammar({ group: entry.group, lang: id });
            if (!args.skipPackage) {
                await buildPackage({ group: entry.group, lang: id });
            }
            ok.push(id);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            failed.push({ id, reason });
            process.stderr.write(`FAIL ${id}: ${reason}\n`);
        }
    }

    process.stderr.write(`\n===== summary =====\n`);
    process.stderr.write(`ok:     ${ok.length}/${targets.length}\n`);
    process.stderr.write(`failed: ${failed.length}/${targets.length}\n`);
    if (failed.length > 0) {
        process.stderr.write(`\nfailures:\n`);
        for (const { id, reason } of failed) {
            // First line of reason only — full stack lives in stdout above.
            process.stderr.write(`  ${id}: ${reason.split('\n')[0]}\n`);
        }
    }

    return { ok, failed };
}
