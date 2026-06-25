// Stage every grammar for the statically-linked Node addon.
//
// Unlike `build-grammar.ts` (which compiles + links a SIDE_MODULE wasm via
// emcc), this only runs the target-agnostic prefix: `tree-sitter generate`
// + flatten queries + collect the C sources into a self-contained per-grammar
// `src/` dir. It emits `target/node-grammars/manifest.json`, which
// `lib/node/build.rs` consumes to `cc`-compile the parsers/scanners into the
// addon and bake the flattened queries as `&'static str`. Requires only the
// patched tree-sitter binary + Node — NOT emcc.

import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";

import { buildGrammarIndex, type GrammarIndexEntry } from "./arborium-yaml.js";
import { flattenAllIntoDir } from "./flatten.js";
import {
	copySupportFiles,
	stageGrammarSource,
	stageNpmDeps,
} from "./stage-grammar.js";
import { Logger, normalizeCSymbol, paths, run, runPool } from "./util.js";

export type ScannerKind = "none" | "c" | "cxx";

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

export interface BuildNodeGrammarsArgs {
	/** Restrict to these grammar ids (dev loop). */
	only?: readonly string[];
	jobs?: number;
}

export interface BuildNodeGrammarsResult {
	built: string[];
	failed: Array<{ id: string; reason: string }>;
}

export async function buildNodeGrammars(
	args: BuildNodeGrammarsArgs = {},
): Promise<BuildNodeGrammarsResult> {
	const p = paths();
	if (!existsSync(p.treeSitterBin)) {
		throw new Error(
			`patched tree-sitter binary not found at ${p.treeSitterBin}; run \`./scripts/arborium-rt bootstrap\` first`,
		);
	}

	const index = buildGrammarIndex(p.langsRoots);
	let ids = [...index.keys()].sort();
	if (args.only && args.only.length > 0) {
		const want = new Set(args.only);
		ids = ids.filter((id) => want.has(id));
	}

	mkdirSync(p.nodeGrammarsOut, { recursive: true });

	const built: ManifestGrammar[] = [];
	const failed: Array<{ id: string; reason: string }> = [];
	const jobs = args.jobs ?? availableParallelism();

	await runPool(ids, jobs, async (id) => {
		try {
			built.push(await stageOne(p, index, id));
		} catch (e) {
			failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
			new Logger(id).warn(`failed: ${e instanceof Error ? e.message : e}`);
		}
	});

	built.sort((a, b) => a.id.localeCompare(b.id));
	writeFileSync(
		join(p.nodeGrammarsOut, "manifest.json"),
		`${JSON.stringify({ grammars: built }, null, 2)}\n`,
	);

	return { built: built.map((g) => g.id), failed };
}

async function stageOne(
	p: ReturnType<typeof paths>,
	index: Map<string, GrammarIndexEntry>,
	id: string,
): Promise<ManifestGrammar> {
	const log = new Logger(id);
	const entry = index.get(id);
	if (!entry) throw new Error(`grammar id ${id} not found in index`);
	const defDir = entry.defPath;
	const grammarDir = join(defDir, "grammar");
	const grammarJs = join(grammarDir, "grammar.js");
	if (!existsSync(grammarJs)) {
		throw new Error(`grammar.js not found at ${grammarJs}`);
	}
	const cSymbol = normalizeCSymbol(entry.grammar.c_symbol, id);

	const langOut = join(p.nodeGrammarsOut, id);
	const buildDir = join(langOut, "build");
	rmSync(buildDir, { recursive: true, force: true });
	// Pre-create src/ so grammar.js prelude scripts that emit cwd-relative
	// files (e.g. vim's keywords.js) find the dir ready.
	mkdirSync(join(buildDir, "src"), { recursive: true });

	stageNpmDeps(entry, index, buildDir, log);
	const nodeModules = join(buildDir, "node_modules");
	const runEnv = existsSync(nodeModules)
		? { NODE_PATH: nodeModules }
		: undefined;

	const stagedGrammarJs = stageGrammarSource(defDir, buildDir);
	log.step("generating parser.c (sparse-only)");
	await run(log, p.treeSitterBin, ["generate", stagedGrammarJs], {
		cwd: buildDir,
		env: { ...runEnv, TREE_SITTER_SPARSE_ONLY: "1" },
	});

	// Scanner detection (matches build-grammar.ts).
	let scannerKind: ScannerKind = "none";
	let scannerSrc: string | undefined;
	if (existsSync(join(grammarDir, "scanner.c"))) {
		scannerKind = "c";
		scannerSrc = join(grammarDir, "scanner.c");
	} else if (existsSync(join(grammarDir, "scanner.cc"))) {
		scannerKind = "cxx";
		scannerSrc = join(grammarDir, "scanner.cc");
	} else if (existsSync(join(grammarDir, "scanner.cpp"))) {
		scannerKind = "cxx";
		scannerSrc = join(grammarDir, "scanner.cpp");
	}

	// Copy grammar-shipped headers + aux C/C++ into src/ so scanner #includes
	// resolve. Then snapshot the whole generated src/ (parser.c +
	// tree_sitter/*.h + support files) into the persistent staging dir.
	copySupportFiles(grammarDir, join(buildDir, "src"));
	const srcOut = join(langOut, "src");
	rmSync(srcOut, { recursive: true, force: true });
	cpSync(join(buildDir, "src"), srcOut, { recursive: true });

	const sources = [join(id, "src", "parser.c")];
	if (scannerSrc) {
		const base = scannerKind === "c" ? "scanner.c" : basename(scannerSrc);
		copyFileSync(scannerSrc, join(srcOut, base));
		sources.push(join(id, "src", base));
	}

	// Flatten queries into langOut/.
	flattenAllIntoDir(id, index, langOut);
	const rel = (name: string): string | null =>
		existsSync(join(langOut, name)) ? join(id, name) : null;

	// Drop the scratch build dir; the persistent src/ + .scm are all build.rs needs.
	rmSync(buildDir, { recursive: true, force: true });

	log.step(`staged ${id} (scanner: ${scannerKind})`);
	return {
		id,
		cSymbol,
		scannerKind,
		dir: id,
		sources,
		highlights: rel("highlights.scm"),
		injections: rel("injections.scm"),
		locals: rel("locals.scm"),
	};
}
