// Iterate every grammar in the arborium submodule, attempt
// build-grammar + package, collect per-grammar results.
//
// Grammars fail for a variety of reasons (tree-sitter-generate ABI mismatches,
// missing upstream node_modules that aren't declared in arborium.yaml,
// structurally-odd vendored layouts). Each failure is logged but doesn't
// abort the run; the closing summary names winners and losers.
//
// Per-grammar work runs in parallel (bounded by `jobs`) — each grammar's
// stderr is line-prefixed with its id so interleaved tool output stays
// readable on a shared terminal.

import { availableParallelism } from 'node:os';

import { buildGrammarIndex } from './arborium-yaml.js';
import { buildGrammar } from './build-grammar.js';
import { buildPackage } from './build-package.js';
import { Logger, paths, runPool } from './util.js';

export interface BuildAllArgs {
    /** If set, only try these grammar ids (for debugging). */
    only?: string[];
    /** If set, don't run `package` after `build-grammar` (wasm + queries only). */
    skipPackage?: boolean;
    /** Max concurrent grammar builds. Defaults to `os.availableParallelism()`. */
    jobs?: number;
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

    const jobs = Math.max(1, args.jobs ?? availableParallelism());
    const root = new Logger('build-all');
    root.step(`building ${targets.length} grammar(s) with ${jobs} worker(s)`);

    let completed = 0;
    await runPool(targets, jobs, async (id) => {
        const entry = index.get(id);
        if (!entry) {
            failed.push({ id, reason: 'not in grammar index' });
            completed++;
            return;
        }
        const log = new Logger(id);
        log.step(`start ${entry.group}/${id}`);
        try {
            await buildGrammar({ group: entry.group, lang: id, log, index });
            if (!args.skipPackage) {
                await buildPackage({ group: entry.group, lang: id, log, index });
            }
            ok.push(id);
            const n = ++completed;
            root.step(`[${n}/${targets.length}] ok ${id}`);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            failed.push({ id, reason });
            log.warn(`FAIL: ${reason}`);
            const n = ++completed;
            root.step(`[${n}/${targets.length}] fail ${id}`);
        }
    });

    root.step(`summary: ok ${ok.length}/${targets.length}, failed ${failed.length}/${targets.length}`);
    if (failed.length > 0) {
        root.step('failures:');
        for (const { id, reason } of failed) {
            // First line of reason only — full stack lives in stdout above.
            root.info(`  ${id}: ${reason.split('\n')[0]}`);
        }
    }

    return { ok, failed };
}
