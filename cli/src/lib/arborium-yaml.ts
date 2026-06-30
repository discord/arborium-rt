// Typed reader for the arborium submodule's `langs/*/*/def/arborium.yaml`.

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import spdxSatisfies from "spdx-satisfies";
import { parse as parseYaml } from "yaml";

const ALLOWED_LICENSES = [
	"CC0-1.0",
	"MIT",
	"Apache-2.0",
	"Unlicense",
	"ISC",
	"Apache-2.0 WITH LLVM-exception",
];

/**
 * Grammars excluded from the corpus, keyed by id with a free-form reason.
 * Anything that filters grammars (the build pipeline, the notices
 * generator, future tools) should consult this single map rather than
 * maintain a parallel skip list.
 */
export const DISABLED_GRAMMARS: Record<string, string> = {
	cobol: "has performance issues",
	nginx: "GPL licensed",
	uiua: "MPL licensed",
	vb: "upstream repo ships no LICENSE file; cannot attribute",
};

/**
 * Per-grammar commit overrides for upstreams whose manifest-pinned SHA is
 * no longer reachable (force-push, repo cleanup). The manifest itself
 * lives in the arborium submodule and isn't editable from here, so this
 * pins downstream tooling (notices generator, license fetcher) to a
 * current default-branch HEAD. Refresh when upstream rotates again.
 */
export const COMMIT_OVERRIDES: Record<string, string> = {
	rust: "a2d578348a195fe9fc97bd14a9fc84f314a0c2fe",
	styx: "0655eb2b0f9e1ddbd0e27a0b9063f1317c990f70",
	vim: "3092fcd99eb87bbd0fc434aa03650ba58bd5b43b",
};

/** Effective commit for a grammar, after applying COMMIT_OVERRIDES. */
export function resolveCommit(
	id: string,
	entry: GrammarIndexEntry,
): string | undefined {
	return COMMIT_OVERRIDES[id] ?? entry.commit;
}

export interface ArboriumYaml {
	grammars?: ArboriumGrammar[];
	license?: string;
	/** Upstream source repo URL (typically `https://github.com/<owner>/<name>`). */
	repo?: string;
	/** Pinned upstream commit SHA. Empty string means "use the default branch". */
	commit?: string;
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
export async function readArboriumYaml(path: string): Promise<ArboriumYaml> {
	return (parseYaml(await readFile(path, "utf8")) ?? {}) as ArboriumYaml;
}

/**
 * Index mapping grammar id → its def directory. Built by scanning every
 * `arborium.yaml` under `<langsRoot>/<group>/<lang>/def/`.
 */
export interface GrammarIndexEntry {
	readonly defPath: string;
	readonly group: string;
	readonly grammar: ArboriumGrammar;
	/** Upstream source repo URL from the def's `arborium.yaml`. */
	readonly repo: string | undefined;
	/** Pinned upstream commit; empty string is normalized to undefined. */
	readonly commit: string | undefined;
	/** SPDX license identifier from the def's `arborium.yaml`. */
	readonly license: string | undefined;
}

export async function buildGrammarIndex(
	roots: readonly string[],
): Promise<Map<string, GrammarIndexEntry>> {
	const index = new Map<string, GrammarIndexEntry>();
	for (const root of roots) {
		await scanRoot(root, index);
	}
	return index;
}

/**
 * Scan a single langs root and merge its entries into `index`. Later roots
 * shadow earlier ones on id collision, which lets a repo-local lang dir
 * override an arborium-vendored grammar with the same id.
 */
async function scanRoot(
	langsRoot: string,
	index: Map<string, GrammarIndexEntry>,
): Promise<void> {
	let groups: Dirent[];
	try {
		groups = await readdir(langsRoot, { withFileTypes: true });
	} catch {
		return; // root doesn't exist (e.g. local langs not yet populated)
	}
	for (const group of groups) {
		if (!group.isDirectory()) continue;
		const groupPath = join(langsRoot, group.name);
		for (const lang of await readdir(groupPath, { withFileTypes: true })) {
			if (!lang.isDirectory()) continue;
			const defPath = join(groupPath, lang.name, "def");
			let doc: ArboriumYaml;
			try {
				doc = await readArboriumYaml(join(defPath, "arborium.yaml"));
			} catch {
				continue; // non-def dir, or missing/unreadable yaml
			}

			if (
				doc.grammars?.some(
					(grammar) => grammar.id && grammar.id in DISABLED_GRAMMARS,
				)
			) {
				continue;
			}

			if (!doc.license || !spdxSatisfies(doc.license, ALLOWED_LICENSES)) {
				continue;
			}

			const commit = doc.commit && doc.commit !== "" ? doc.commit : undefined;
			for (const grammar of doc.grammars ?? []) {
				if (grammar.id) {
					index.set(grammar.id, {
						defPath,
						group: group.name,
						grammar,
						repo: doc.repo,
						commit,
						license: doc.license,
					});
				}
			}
		}
	}
}
