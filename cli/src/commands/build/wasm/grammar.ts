// Compile a tree-sitter grammar as SIDE_MODULE=2 + materialize its flattened
// queries. Port of `scripts/build-grammar.sh`.

import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ListrTask } from "listr2";
import {
	buildGrammarIndex,
	type GrammarIndexEntry,
	resolveCommit,
} from "../../../lib/arborium-yaml.ts";
import { flattenAllIntoDir } from "../../../lib/flatten.ts";
import {
	cloneDirFor,
	detectLicenses,
	ensureClone,
	findNoticeFiles,
	isLocalGrammar,
} from "../../../lib/grammar-clone.ts";
import {
	copySupportFiles,
	stageGrammarSource,
	stageNpmDeps,
} from "../../../lib/stage-grammar.ts";
import { normalizeCSymbol, paths, run } from "../../../lib/util.ts";

export interface BuildGrammarArgs {
	group: string;
	lang: string;
	/** Pre-built corpus index. Defaults to scanning the filesystem. */
	index?: Map<string, GrammarIndexEntry>;
}

interface BuildGrammarContext {
	index: Map<string, GrammarIndexEntry>;
	currentEntry: GrammarIndexEntry;
	grammarDir: string;
	grammarJs: string;
	cSymbol: string;
	outDir: string;
	buildDir: string;
	objs: string[];
	hasScanner: boolean;
}

export function buildGrammar(
	args: BuildGrammarArgs,
): ListrTask<BuildGrammarContext>[] {
	const p = paths();

	return [
		{
			async task(ctx) {
				ctx.index = args.index ?? (await buildGrammarIndex(p.langsRoots));

				const currentEntry = ctx.index.get(args.lang);
				if (!currentEntry) {
					throw new Error(
						`grammar id ${args.lang} not found in index (scanned ${p.langsRoots.join(", ")})`,
					);
				}
				ctx.currentEntry = currentEntry;

				ctx.grammarDir = join(currentEntry.defPath, "grammar");
				ctx.grammarJs = join(ctx.grammarDir, "grammar.js");
				ctx.cSymbol = normalizeCSymbol(
					ctx.currentEntry.grammar.c_symbol,
					args.lang,
				);

				const outDir = join(p.grammarsOut, args.lang);
				ctx.outDir = outDir;
				const buildDir = join(outDir, "build");
				ctx.buildDir = buildDir;

				ctx.objs = [];
				ctx.hasScanner = false;
			},
		},
		{
			title: "staging npm dependencies",
			async task(ctx, task) {
				await rm(ctx.buildDir, { recursive: true, force: true });
				await mkdir(join(ctx.buildDir, "src"), { recursive: true });

				// --- stage npm deps -------------------------------------------------------
				//
				// Some grammars' grammar.js `require()`s upstream tree-sitter packages
				// (TSX pulls in tree-sitter-javascript, HLSL pulls in tree-sitter-cpp
				// which transitively needs tree-sitter-c, etc.). Populate a local
				// `node_modules/` with symlinks to the vendored dep grammars' def/grammar/
				// dirs, and expose it via NODE_PATH so Node's resolution finds them even
				// though the grammar.js lives at a different path.
				return task.newListr(
					stageNpmDeps(ctx.currentEntry, ctx.index, ctx.buildDir),
				);
			},
		},
		{
			async task(ctx, task) {
				task.title = `generating parser.c from ${relative(p.repoRoot, ctx.grammarJs)} (sparse-only)`;

				const nodeModules = join(ctx.buildDir, "node_modules");
				const runEnv = { NODE_PATH: nodeModules };

				// Stage grammar source into a nested layout so `require('../<subdir>/...')`
				// from grammar.js resolves. Some upstream grammars (markdown, several
				// multi-language ones) expect shared helper dirs to be siblings of the
				// grammar dir. arborium vendors them in one of two ways:
				//   - upstream layout: `def/common/` alongside `def/grammar/` (asciidoc)
				//   - flattened layout: `def/grammar/common/` tucked inside (markdown)
				// Stage both views so either pattern resolves.
				const stagedGrammarJs = await stageGrammarSource(
					ctx.currentEntry.defPath,
					ctx.buildDir,
				);

				// TREE_SITTER_SPARSE_ONLY tells our patched tree-sitter render.rs to skip
				// the dense `ts_parse_table[LARGE_STATE_COUNT][SYMBOL_COUNT]` array and
				// route every state through `ts_small_parse_table`. Cuts parser.c output
				// by ~30% and the linked SIDE_MODULE wasm by 50–75%, with a small parse-
				// time cost the highlighting workload can absorb.
				await run(
					task.stdout(),
					p.treeSitterBin,
					["generate", stagedGrammarJs],
					{
						cwd: ctx.buildDir,
						env: {
							...runEnv,
							TREE_SITTER_SPARSE_ONLY: "1",
						},
					},
				);
			},
		},
		{
			title: "compiling src/parser.c (C)",
			async task(ctx, task) {
				// Copy grammar-shipped headers + auxiliary C/C++ sources into src/ so
				// scanner.c's `#include`s resolve during compile.
				await copySupportFiles(ctx.grammarDir, join(ctx.buildDir, "src"));

				await run(
					task.stdout(),
					"emcc",
					[
						"-O2",
						"-fPIC",
						"-I",
						"src",
						"-std=c11",
						"-c",
						"src/parser.c",
						"-o",
						"parser.o",
					],
					{ cwd: ctx.buildDir },
				);
				ctx.objs.push("parser.o");
			},
		},
		{
			title: "compiling src/scanner.c (C)",
			async task(ctx, task) {
				const scannerC = join(ctx.grammarDir, "scanner.c");
				try {
					await copyFile(scannerC, join(ctx.buildDir, "src", "scanner.c"));
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					) {
						task.skip();
						return;
					}
				}

				ctx.hasScanner = true;

				await run(
					task.stdout(),
					"emcc",
					[
						"-O2",
						"-fPIC",
						"-I",
						"src",
						"-std=c11",
						"-c",
						"src/scanner.c",
						"-o",
						"scanner.o",
					],
					{ cwd: ctx.buildDir },
				);
				ctx.objs.push("scanner.o");
			},
		},
		{
			title: "linking grammars into wasm",
			async task(ctx, task) {
				const wasmOut = join(ctx.outDir, `tree-sitter-${args.lang}.wasm`);

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
				const exportedFns = [`_tree_sitter_${ctx.cSymbol}`];
				if (ctx.hasScanner) {
					for (const op of [
						"create",
						"destroy",
						"scan",
						"serialize",
						"deserialize",
					]) {
						exportedFns.push(
							`_tree_sitter_${ctx.cSymbol}_external_scanner_${op}`,
						);
					}
				}

				await run(
					task.stdout(),
					"emcc",
					[
						"-O2",
						"-fPIC",
						"-s",
						"SIDE_MODULE=2",
						"-s",
						`EXPORTED_FUNCTIONS=${exportedFns.join(",")}`,
						"-o",
						wasmOut,
						...ctx.objs,
					],
					{ cwd: ctx.buildDir },
				);
			},
		},
		{
			title: "flattening queries",
			async task(ctx) {
				await flattenAllIntoDir(args.lang, ctx.index, ctx.outDir);
			},
		},
		{
			title: "preparing licenses",
			async task(ctx, task) {
				/**
				 * Resolve the directory we'll copy LICENSE/NOTICE files from. For a
				 * locally-vendored grammar (yuri, x86asm) that's the arborium submodule
				 * root (carries `LICENSE-MIT` + `LICENSE-APACHE`). For everything else,
				 * a shallow clone of the upstream at its (override-resolved) commit.
				 */
				async function sourceDirFor(): Promise<string> {
					if (isLocalGrammar(ctx.currentEntry)) {
						return paths().submoduleRoot;
					}
					if (!ctx.currentEntry.repo) {
						throw new Error(
							`${args.lang}: arborium.yaml is missing a top-level \`repo:\` field`,
						);
					}
					const cloneDir = cloneDirFor(args.lang);
					const commit = resolveCommit(args.lang, ctx.currentEntry);
					await ensureClone(
						task.stdout(),
						cloneDir,
						ctx.currentEntry.repo,
						commit,
					);
					return cloneDir;
				}

				const sourceDir = await sourceDirFor();
				const licenses = await detectLicenses(task.stdout(), sourceDir);
				const notices = await findNoticeFiles(sourceDir);
				const allFiles = [
					...licenses.map((l) => l.file),
					...notices
						.filter((n) => !licenses.some((l) => l.file === n.file))
						.map((n) => n.file),
				];

				if (allFiles.length === 0) {
					throw new Error(
						`no LICENSE or NOTICE files found at ${sourceDir} for ${args.lang}`,
					);
				}

				await mkdir(ctx.outDir, { recursive: true });
				for (const fname of allFiles) {
					await copyFile(join(sourceDir, fname), join(ctx.outDir, fname));
				}

				// Tag dual-licensed grammars (multi-LICENSE) and Apache projects
				// (NOTICE) so `--license already cached` runs are still informative.
				const detected = licenses
					.map((l) => `${l.file}=${l.spdx}@${l.score.toFixed(3)}`)
					.join(", ");

				task.output = `staged ${allFiles.length} attribution file(s) from ${sourceDir}: ${detected}${notices.length > 0 ? ` (+${notices.length} NOTICE)` : ""}`;
			},
		},
	];
}
