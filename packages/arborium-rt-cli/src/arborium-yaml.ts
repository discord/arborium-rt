// Typed reader for the arborium submodule's `langs/*/*/def/arborium.yaml`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

export interface ArboriumYaml {
    grammars?: ArboriumGrammar[];
}

export interface ArboriumGrammar {
    id?: string;
    name?: string;
    aliases?: string[];
    /**
     * Override for the grammar's tree-sitter C symbol. The `tree_sitter_<X>`
     * function's `<X>` is this value, falling back to `id`. E.g., Rust's id
     * is `"rust"` but its c_symbol is `"rust_orchard"` (grammar-orchard fork).
     */
    c_symbol?: string;
    dependencies?: Array<{ npm?: string; crate?: string }>;
    queries?: {
        highlights?: QueryConfig;
        injections?: QueryConfig;
        locals?: QueryConfig;
    };
}

export interface QueryConfig {
    prepend?: Array<{ crate?: string }>;
}

/** Parse a single `arborium.yaml` file. Throws on malformed YAML. */
export function readArboriumYaml(path: string): ArboriumYaml {
    return (parseYaml(readFileSync(path, 'utf8')) ?? {}) as ArboriumYaml;
}

/**
 * Index mapping grammar id → its def directory. Built by scanning every
 * `arborium.yaml` under `<langsRoot>/<group>/<lang>/def/`.
 */
export interface GrammarIndexEntry {
    readonly defPath: string;
    readonly group: string;
    readonly grammar: ArboriumGrammar;
}

export function buildGrammarIndex(
    langsRoot: string,
): Map<string, GrammarIndexEntry> {
    const index = new Map<string, GrammarIndexEntry>();
    for (const group of readdirSync(langsRoot, { withFileTypes: true })) {
        if (!group.isDirectory()) continue;
        const groupPath = join(langsRoot, group.name);
        for (const lang of readdirSync(groupPath, { withFileTypes: true })) {
            if (!lang.isDirectory()) continue;
            const defPath = join(groupPath, lang.name, 'def');
            let doc: ArboriumYaml;
            try {
                doc = readArboriumYaml(join(defPath, 'arborium.yaml'));
            } catch {
                continue; // non-def dir, or missing/unreadable yaml
            }
            for (const grammar of doc.grammars ?? []) {
                if (grammar.id) {
                    index.set(grammar.id, { defPath, group: group.name, grammar });
                }
            }
        }
    }
    return index;
}
