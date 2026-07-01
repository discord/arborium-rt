// Stage the statically-linked native targets' grammar sources (`build native
// grammars`).
//
// For each grammar it runs `tree-sitter generate` (sparse-only), snapshots the
// generated `src/` + flattened queries into a persistent per-grammar dir, and
// records a manifest entry. The linking halves (`build node` / `build android`,
// in build/node/index.ts and build/android/index.ts) consume those staged
// sources — they need neither the tree-sitter CLI nor emcc, just a C/C++
// (or NDK) compiler. The shared manifest model lives in lib/native-manifest.ts.

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import type { ListrTask } from "listr2";
import {
	buildGrammarIndex,
	type GrammarIndexEntry,
} from "../../../lib/arborium-yaml.ts";
import { flattenAllIntoDir } from "../../../lib/flatten.ts";
import {
	type ManifestGrammar,
	manifestEntryFor,
} from "../../../lib/native-manifest.ts";
import {
	copySupportFiles,
	stageGrammarSource,
	stageNpmDeps,
} from "../../../lib/stage-grammar.ts";
import { normalizeCSymbol, paths, run } from "../../../lib/util.ts";

/**
 * Concurrency for grammar staging, bounded by BOTH cpu and memory.
 *
 * `tree-sitter generate` for the largest grammars (verilog, typescript, lean,
 * cobol, …) can each spike to several GB while it builds the full parse table.
 * Unlike the wasm build — which is sharded one arborium group per runner, so big
 * grammars rarely coincide — the native targets stage the whole corpus on a
 * single runner, so a cluster of big grammars generating at once will OOM-kill
 * the runner (it dies with SIGTERM / exit 143 mid-staging). Reserve ~6 GiB of
 * headroom per concurrent generate so memory, not just cpu count, caps the pool.
 */
function stagingConcurrency(): number {
	const perJobBytes = 6 * 1024 ** 3;
	const byMemory = Math.max(1, Math.floor(totalmem() / perJobBytes));
	return Math.max(1, Math.min(availableParallelism(), byMemory));
}

export interface BuildNativeGrammarsArgs {
	/** Restrict to these grammar ids (dev loop). */
	only?: readonly string[];
	/** Restrict to one arborium group (drives the per-group staging matrix). */
	group?: string;
}

interface BuildNativeGrammarsContext {
	index: Map<string, GrammarIndexEntry>;
	built: ManifestGrammar[];
}

interface BuildSingleGrammarContext extends BuildNativeGrammarsContext {
	defDir: string;
	langOut: string;
	buildDir: string;
	cSymbol: string;
}

export function buildNativeGrammars(
	args: BuildNativeGrammarsArgs = {},
): ListrTask<BuildNativeGrammarsContext>[] {
	const p = paths();

	return [
		{
			async task(ctx) {
				ctx.index = await buildGrammarIndex(p.langsRoots);
				ctx.built = [];
			},
		},
		{
			async task(ctx, task) {
				let ids = [...ctx.index.keys()].sort();
				if (args.only && args.only.length > 0) {
					const want = new Set(args.only);
					ids = ids.filter((id) => want.has(id));
				}
				if (args.group) {
					ids = ids.filter((id) => ctx.index.get(id)?.group === args.group);
				}

				await mkdir(p.nativeGrammarsOut, { recursive: true });

				return task.newListr(
					ids.map((id) => ({
						title: `staging grammar ${id}`,
						async task(ctx, task) {
							// `concurrent: false` is load-bearing: listr2 merges the
							// parent list's options into every nested list, so without
							// this override the per-grammar steps inherit the outer
							// `concurrent: stagingConcurrency()` and run in parallel.
							// They are strictly ordered (mkdir/stage → generate →
							// copy/manifest), so the copy step would otherwise race the
							// generate step and ENOENT on `build/src`.
							return task.newListr(stageOne(p, id), {
								ctx: {
									...ctx,
									buildDir: "",
									defDir: "",
									langOut: "",
									cSymbol: "",
								},
								concurrent: false,
							});
						},
					})),
					{ concurrent: stagingConcurrency() },
				);
			},
		},
		{
			async task(ctx) {
				ctx.built.sort((a, b) => a.id.localeCompare(b.id));
				await writeFile(
					join(p.nativeGrammarsOut, "manifest.json"),
					`${JSON.stringify({ grammars: ctx.built }, null, 2)}\n`,
				);
			},
		},
	];
}

function stageOne(
	p: ReturnType<typeof paths>,
	id: string,
): ListrTask<BuildSingleGrammarContext>[] {
	return [
		{
			async task(ctx, task) {
				const entry = ctx.index.get(id);
				if (!entry) throw new Error(`grammar id ${id} not found in index`);
				ctx.defDir = entry.defPath;
				ctx.cSymbol = normalizeCSymbol(entry.grammar.c_symbol, id);

				ctx.langOut = join(p.nativeGrammarsOut, id);
				ctx.buildDir = join(ctx.langOut, "build");
				await rm(ctx.buildDir, { recursive: true, force: true });
				// Pre-create src/ so grammar.js prelude scripts that emit cwd-relative
				// files (e.g. vim's keywords.js) find the dir ready.
				await mkdir(join(ctx.buildDir, "src"), { recursive: true });

				return task.newListr(stageNpmDeps(entry, ctx.index, ctx.buildDir));
			},
		},
		{
			title: "generating parser.c (sparse-only)",
			async task(ctx, task) {
				const stagedGrammarJs = await stageGrammarSource(
					ctx.defDir,
					ctx.buildDir,
				);
				const nodeModules = join(ctx.buildDir, "node_modules");
				const runEnv = { NODE_PATH: nodeModules };

				await run(
					task.stdout(),
					p.treeSitterBin,
					["generate", stagedGrammarJs],
					{
						cwd: ctx.buildDir,
						env: { ...runEnv, TREE_SITTER_SPARSE_ONLY: "1" },
					},
				);
			},
		},
		{
			async task(ctx) {
				const grammarDir = join(ctx.defDir, "grammar");

				// Copy grammar-shipped headers + aux C/C++ into src/ so scanner #includes
				// resolve. Then snapshot the whole generated src/ (parser.c +
				// tree_sitter/*.h + support files, including any scanner) into the
				// persistent staging dir.
				await copySupportFiles(grammarDir, join(ctx.buildDir, "src"));
				const srcOut = join(ctx.langOut, "src");
				await rm(srcOut, { recursive: true, force: true });
				await cp(join(ctx.buildDir, "src"), srcOut, { recursive: true });

				// Flatten queries into langOut/.
				flattenAllIntoDir(id, ctx.index, ctx.langOut);

				// Drop the scratch build dir; the persistent src/ + .scm are all build.rs needs.
				await rm(ctx.buildDir, { recursive: true, force: true });

				ctx.built.push(await manifestEntryFor(p, id, ctx.cSymbol));
			},
		},
	];
}
