// Query-inheritance flattener for arborium grammars.
//
// Port of the Python `scripts/flatten-queries.py`. For each query type,
// walks `arborium.yaml`'s `queries.<type>.prepend` list recursively and
// concatenates the transitively-inherited queries with this grammar's own.
//
// Matches arborium's own Rust template behavior
// (`xtask/templates/lib.stpl.rs`): prepends come first, this grammar's own
// last, so own rules win on tree-sitter pattern-priority ties.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GrammarIndexEntry } from './arborium-yaml.js';

export const QUERY_TYPES = ['highlights', 'injections', 'locals'] as const;
export type QueryType = (typeof QUERY_TYPES)[number];

/**
 * Compute the flattened content for one query type. Returns an empty string
 * if nothing contributes (this grammar has no own `<type>.scm` and no
 * prepends resolving to any base with that query type).
 *
 * The `seen` parameter catches cycles in the prepend graph — shouldn't occur
 * in practice, but cheap to guard.
 */
export function flattenQuery(
    grammarId: string,
    qtype: QueryType,
    index: Map<string, GrammarIndexEntry>,
    seen: ReadonlySet<string> = new Set(),
): string {
    if (seen.has(grammarId)) {
        throw new Error(
            `cycle in query-prepend graph at ${grammarId} (visited: ${[...seen].join(', ')})`,
        );
    }
    const entry = index.get(grammarId);
    if (!entry) {
        throw new Error(
            `unknown grammar id ${grammarId} (not present in langs/* scan)`,
        );
    }
    const nextSeen = new Set(seen).add(grammarId);

    const prepends = entry.grammar.queries?.[qtype]?.prepend ?? [];
    const chunks: string[] = [];

    for (const prepend of prepends) {
        if (!prepend.crate) continue;
        const baseId = prepend.crate.replace(/^arborium-/, '');
        if (!index.has(baseId)) {
            throw new Error(
                `${grammarId}: prepend "${prepend.crate}" resolves to unknown grammar "${baseId}"`,
            );
        }
        const sub = flattenQuery(baseId, qtype, index, nextSeen);
        if (sub) chunks.push(sub);
    }

    const ownScm = join(entry.defPath, 'queries', `${qtype}.scm`);
    if (existsSync(ownScm)) {
        chunks.push(readFileSync(ownScm, 'utf8'));
    }

    // Blank-line separator between chunks keeps the boundary readable in case
    // of debug; matches the Python flattener's behavior.
    return chunks.join('\n');
}

/**
 * Write all three query types for `grammarId` into `outDir`. Only writes a
 * file if the flattened content is non-empty — avoids misleading empty
 * `injections.scm` / `locals.scm` stubs.
 */
export function flattenAllIntoDir(
    grammarId: string,
    index: Map<string, GrammarIndexEntry>,
    outDir: string,
): void {
    mkdirSync(outDir, { recursive: true });
    for (const qtype of QUERY_TYPES) {
        const content = flattenQuery(grammarId, qtype, index);
        if (content) {
            writeFileSync(join(outDir, `${qtype}.scm`), content);
        }
    }
}
