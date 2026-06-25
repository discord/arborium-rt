// Compile a tree-sitter grammar as SIDE_MODULE=2 + materialize its flattened
// queries. Port of `scripts/build-grammar.sh`.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { buildGrammarIndex, type GrammarIndexEntry } from "./arborium-yaml.js";
import { fetchLicense } from "./fetch-license.js";
import { flattenAllIntoDir } from "./flatten.js";
import {
	copySupportFiles,
	stageGrammarSource,
	stageNpmDeps,
} from "./stage-grammar.js";
import { hasCommand, Logger, normalizeCSymbol, paths, run } from "./util.js";

export interface BuildGrammarArgs {
	group: string;
	lang: string;
	/** Logger for this build. Defaults to one tagged with `lang`. */
	log?: Logger;
	/** Pre-built corpus index. Defaults to scanning the filesystem. */
	index?: Map<string, GrammarIndexEntry>;
}

export async function buildGrammar(args: BuildGrammarArgs): Promise<void> {
	const p = paths();
	const log = args.log ?? new Logger(args.lang);
	const index = args.index ?? buildGrammarIndex(p.langsRoots);
	const currentEntry = index.get(args.lang);
	if (!currentEntry) {
		throw new Error(
			`grammar id ${args.lang} not found in index (scanned ${p.langsRoots.join(", ")})`,
		);
	}
	const defDir = currentEntry.defPath;
	const grammarDir = join(defDir, "grammar");
	const grammarJs = join(grammarDir, "grammar.js");
	if (!existsSync(grammarJs)) {
		throw new Error(`grammar.js not found at ${grammarJs}`);
	}

	if (!(await hasCommand("emcc"))) {
		throw new Error(`emcc not found on PATH`);
	}
	if (!existsSync(p.treeSitterBin)) {
		throw new Error(
			`patched tree-sitter binary not found at ${p.treeSitterBin}; run \`./scripts/arborium-rt bootstrap\` first`,
		);
	}

	const outDir = join(p.grammarsOut, args.lang);
	const buildDir = join(outDir, "build");
	rmSync(buildDir, { recursive: true, force: true });
	mkdirSync(buildDir, { recursive: true });

	const cSymbol = normalizeCSymbol(currentEntry.grammar.c_symbol, args.lang);

	// --- stage npm deps -------------------------------------------------------
	//
	// Some grammars' grammar.js `require()`s upstream tree-sitter packages
	// (TSX pulls in tree-sitter-javascript, HLSL pulls in tree-sitter-cpp
	// which transitively needs tree-sitter-c, etc.). Populate a local
	// `node_modules/` with symlinks to the vendored dep grammars' def/grammar/
	// dirs, and expose it via NODE_PATH so Node's resolution finds them even
	// though the grammar.js lives at a different path.
	stageNpmDeps(currentEntry, index, buildDir, log);
	const nodeModules = join(buildDir, "node_modules");
	const runEnv = existsSync(nodeModules)
		? { NODE_PATH: nodeModules }
		: undefined;

	// --- generate parser.c ----------------------------------------------------
	//
	// Pre-create buildDir/src/ so grammar.js prelude scripts that emit files
	// cwd-relative (e.g., vim's keywords.js does `writeFileSync('src/keywords.h')`)
	// find the directory ready. tree-sitter generate itself doesn't need it.
	mkdirSync(join(buildDir, "src"), { recursive: true });

	// Stage grammar source into a nested layout so `require('../<subdir>/...')`
	// from grammar.js resolves. Some upstream grammars (markdown, several
	// multi-language ones) expect shared helper dirs to be siblings of the
	// grammar dir. arborium vendors them in one of two ways:
	//   - upstream layout: `def/common/` alongside `def/grammar/` (asciidoc)
	//   - flattened layout: `def/grammar/common/` tucked inside (markdown)
	// Stage both views so either pattern resolves.
	const stagedGrammarJs = stageGrammarSource(defDir, buildDir);

	log.step(
		`generating parser.c from ${relative(p.repoRoot, grammarJs)} (sparse-only)`,
	);
	// TREE_SITTER_SPARSE_ONLY tells our patched tree-sitter render.rs to skip
	// the dense `ts_parse_table[LARGE_STATE_COUNT][SYMBOL_COUNT]` array and
	// route every state through `ts_small_parse_table`. Cuts parser.c output
	// by ~30% and the linked SIDE_MODULE wasm by 50–75%, with a small parse-
	// time cost the highlighting workload can absorb.
	await run(log, p.treeSitterBin, ["generate", stagedGrammarJs], {
		cwd: buildDir,
		env: {
			...runEnv,
			TREE_SITTER_SPARSE_ONLY: "1",
		},
	});

	// --- scanner detection ----------------------------------------------------
	//
	// Grammars may ship a scanner in C (scanner.c) or C++ (scanner.cc/.cpp).
	// The arborium corpus is C-only today, but the C++ path is scaffolded so
	// we don't get stuck when upstream adds one. Linking in C++ mode brings
	// libc++ into the SIDE_MODULE statically.
	let scannerC: string | undefined;
	let scannerCxx: string | undefined;
	if (existsSync(join(grammarDir, "scanner.c"))) {
		scannerC = join(grammarDir, "scanner.c");
	} else if (existsSync(join(grammarDir, "scanner.cc"))) {
		scannerCxx = join(grammarDir, "scanner.cc");
	} else if (existsSync(join(grammarDir, "scanner.cpp"))) {
		scannerCxx = join(grammarDir, "scanner.cpp");
	}

	// Copy grammar-shipped headers + auxiliary C/C++ sources into src/ so
	// scanner.c's `#include`s resolve during compile.
	copySupportFiles(grammarDir, join(buildDir, "src"));

	// --- compile --------------------------------------------------------------
	const commonCflags = ["-O2", "-fPIC", "-I", "src"];
	const objs: string[] = [];

	log.step("compiling src/parser.c (C)");
	await run(
		log,
		"emcc",
		[...commonCflags, "-std=c11", "-c", "src/parser.c", "-o", "parser.o"],
		{ cwd: buildDir },
	);
	objs.push("parser.o");

	if (scannerC) {
		copyFileSync(scannerC, join(buildDir, "src", "scanner.c"));
		log.step("compiling src/scanner.c (C)");
		await run(
			log,
			"emcc",
			[...commonCflags, "-std=c11", "-c", "src/scanner.c", "-o", "scanner.o"],
			{ cwd: buildDir },
		);
		objs.push("scanner.o");
	} else if (scannerCxx) {
		const scannerBase = basename(scannerCxx);
		copyFileSync(scannerCxx, join(buildDir, "src", scannerBase));
		log.step(`compiling src/${scannerBase} (C++)`);
		await run(
			log,
			"em++",
			[
				...commonCflags,
				"-std=c++17",
				"-fno-exceptions",
				"-fno-rtti",
				"-c",
				`src/${scannerBase}`,
				"-o",
				"scanner.o",
			],
			{ cwd: buildDir },
		);
		objs.push("scanner.o");
	}

	// --- link -----------------------------------------------------------------
	const linker = scannerCxx ? "em++" : "emcc";
	const wasmOut = join(outDir, `tree-sitter-${args.lang}.wasm`);

	// The language entry point must be exported. When the grammar ships an
	// external scanner, its five `tree_sitter_<sym>_external_scanner_*`
	// entry points must be exported too. The generated parser table stores
	// them as function pointers, which emscripten emits as `GOT.func`
	// imports that the MAIN_MODULE host's dynamic linker resolves against
	// this side module's *exports* at load time. Name them explicitly rather
	// than rely on emcc auto-exporting address-taken functions: that heuristic
	// is version-dependent (emsdk 4.0.x omitted these entirely under
	// SIDE_MODULE=2, so the host threw `bad export type for
	// 'tree_sitter_<sym>_external_scanner_create': undefined` on load) and an
	// explicit `--export` is the contract-correct way to state which symbols
	// the host must resolve. (Upstream tree-sitter sidesteps the issue by
	// building grammars as wasm32-unknown-wasi `-shared` objects, where
	// intra-module pointers resolve locally and no exports are needed.)
	const exportedFns = [`_tree_sitter_${cSymbol}`];
	if (scannerC || scannerCxx) {
		for (const op of [
			"create",
			"destroy",
			"scan",
			"serialize",
			"deserialize",
		]) {
			exportedFns.push(`_tree_sitter_${cSymbol}_external_scanner_${op}`);
		}
	}

	log.step(
		`linking tree-sitter-${args.lang}.wasm (${linker}, tree_sitter_${cSymbol})`,
	);
	await run(
		log,
		linker,
		[
			"-O2",
			"-fPIC",
			"-s",
			"SIDE_MODULE=2",
			"-s",
			`EXPORTED_FUNCTIONS=${exportedFns.join(",")}`,
			"-o",
			wasmOut,
			...objs,
		],
		{ cwd: buildDir },
	);

	// --- flatten queries ------------------------------------------------------
	log.step("flattening queries");
	flattenAllIntoDir(args.lang, index, outDir);

	// --- fetch upstream LICENSE ----------------------------------------------
	//
	// The arborium submodule vendors grammar.js but not the upstream license
	// text — shallow-clone the source repo at its pinned commit and copy
	// the depth-1 LICENSE/NOTICE files alongside the wasm. Locally-vendored
	// grammars (`repo: local`) get arborium's own LICENSE-MIT + LICENSE-APACHE.
	await fetchLicense({
		id: args.lang,
		entry: currentEntry,
		outDir,
		log,
	});

	log.step(`built ${relative(p.repoRoot, outDir)}`);
}
