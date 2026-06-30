// Shared manifest model for the statically-linked Node addon, used by both
// halves of the Node build:
//
//   build node grammars (cli/src/commands/build/node/grammars.ts) — stages each
//                 grammar's sources, then records a manifest entry per grammar.
//   build node          (cli/src/commands/build/node/index.ts)    — links from
//                 already-staged sources, rebuilding the manifest by scanning the dirs.
//
// Both derive their entries from the same source of truth (the files on disk
// under `nodeGrammarsOut`), so the manifest is identical whether produced fresh
// during staging or reconstructed from a downloaded staging matrix.

import type { Dirent } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildGrammarIndex } from "./arborium-yaml.ts";
import { normalizeCSymbol, type paths } from "./util.ts";

export type ScannerKind = "none" | "c";

/** One grammar's entry in the manifest `lib/node/build.rs` reads. */
export interface ManifestGrammar {
	/** arborium grammar id (the language name used for injection lookups). */
	id: string;
	/** tree-sitter C export symbol; `tree_sitter_<cSymbol>()`. */
	cSymbol: string;
	scannerKind: ScannerKind;
	/** Per-grammar staging dir, relative to the node-grammars root. */
	dir: string;
	/**
	 * Compile units relative to the node-grammars root. parser.c always; the
	 * single scanner file when present. Support `.c` files are `#include`d by
	 * the scanner and live alongside in `src/`, so they are NOT listed here.
	 */
	sources: string[];
	/** Flattened query paths, relative to the node-grammars root; null if empty. */
	highlights: string | null;
	injections: string | null;
	locals: string | null;
}

async function isFile(path: string): Promise<boolean> {
	return stat(path)
		.then((s) => s.isFile())
		.catch(() => false);
}

/**
 * Build one grammar's manifest entry purely from its staged dir on disk
 * (`<nodeGrammarsOut>/<id>/`) — no generate, no access to the original def dir.
 * Shared by the staging step (right after staging) and
 * {@link rebuildManifestFromStaged} (link-only, from downloaded sources), so the
 * manifest is always derived from the same source of truth: the staged files.
 */
export async function manifestEntryFor(
	p: ReturnType<typeof paths>,
	id: string,
	cSymbol: string,
): Promise<ManifestGrammar> {
	const langOut = join(p.nodeGrammarsOut, id);

	// The external scanner (if any) was staged into src/ alongside parser.c.
	// build.rs picks C vs C++ by file extension; no arborium grammar ships a C++
	// scanner, so we only look for scanner.c.
	const sources = [join(id, "src", "parser.c")];
	let scannerKind: ScannerKind = "none";
	if (await isFile(join(langOut, "src", "scanner.c"))) {
		sources.push(join(id, "src", "scanner.c"));
		scannerKind = "c";
	}

	const rel = async (name: string): Promise<string | null> =>
		(await isFile(join(langOut, name))) ? join(id, name) : null;

	return {
		id,
		cSymbol,
		scannerKind,
		dir: id,
		sources,
		highlights: await rel("highlights.scm"),
		injections: await rel("injections.scm"),
		locals: await rel("locals.scm"),
	};
}

/**
 * Rebuild `manifest.json` by scanning every staged grammar dir under
 * `nodeGrammarsOut` (a dir is "staged" once it holds `src/parser.c`). Used by
 * the link-only build (`build node`) so a runner that merely
 * downloaded the staging matrix's sources can produce a complete, accurate
 * manifest without the tree-sitter CLI or a manifest artifact.
 */
export async function rebuildManifestFromStaged(
	p: ReturnType<typeof paths>,
): Promise<void> {
	const index = await buildGrammarIndex(p.langsRoots);

	let dirents: Dirent[];
	try {
		dirents = await readdir(p.nodeGrammarsOut, { withFileTypes: true });
	} catch {
		throw new Error(
			`no staged grammars at ${p.nodeGrammarsOut}. run \`arborium-rt build node grammars\` first (or download the grammars-node artifacts).`,
		);
	}

	const built: ManifestGrammar[] = [];
	for (const d of dirents) {
		if (!d.isDirectory()) continue;
		const id = d.name;
		if (!(await isFile(join(p.nodeGrammarsOut, id, "src", "parser.c")))) continue;
		const entry = index.get(id);
		if (!entry) {
			throw new Error(`staged grammar \`${id}\` is not in the corpus index`);
		}
		built.push(
			await manifestEntryFor(p, id, normalizeCSymbol(entry.grammar.c_symbol, id)),
		);
	}

	if (built.length === 0) {
		throw new Error(
			`no staged grammars found under ${p.nodeGrammarsOut}; nothing to build`,
		);
	}

	built.sort((a, b) => a.id.localeCompare(b.id));
	await writeFile(
		join(p.nodeGrammarsOut, "manifest.json"),
		`${JSON.stringify({ grammars: built }, null, 2)}\n`,
	);
}
