// Build the statically-linked Node native addon.
//
// Split into a staging half (`build node` → tree-sitter generate per
// grammar) and a packaging half (`package node` → `cargo build` + copy). The
// cargo build targets the HOST triple via CARGO_BUILD_TARGET (which also lands
// the artifact under the triple-prefixed target dir). No build-std: the host
// build links the
// prebuilt std, and `.cargo/config.toml` no longer pins build-std, so nothing
// needs clearing — setting CARGO_UNSTABLE_BUILD_STD here would instead *enable*
// build-std with an empty crate set and rebuild `core` (duplicate-lang-item
// link error). The manifest path is handed to build.rs via
// ARBORIUM_RT_NODE_GRAMMARS. Finally copies the produced cdylib to the npm
// package as `arborium-rt-node.node`.

import type { Dirent } from "node:fs";
import {
	copyFile,
	cp,
	mkdir,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { Listr, type ListrTask } from "listr2";
import {
	buildGrammarIndex,
	type GrammarIndexEntry,
} from "../../lib/arborium-yaml.ts";
import { flattenAllIntoDir } from "../../lib/flatten.ts";
import {
	copySupportFiles,
	stageGrammarSource,
	stageNpmDeps,
} from "../../lib/stage-grammar.ts";
import { hostTriple, normalizeCSymbol, paths, run } from "../../lib/util.ts";

/**
 * Link the statically-linked addon from grammar sources already staged under
 * `nodeGrammarsOut` (e.g. downloaded from the `grammars-node` matrix). Mirrors
 * the wasm `package` subcommands: it assembles the publishable target artifact
 * (here, `arborium-rt-node.node`) from already-built inputs. Regenerates the
 * manifest by scanning the staged dirs, so it needs neither the tree-sitter CLI
 * nor a manifest artifact.
 */
export function packageNode() {
	const p = paths();

	return new Listr([
		{
			title: "regenerating manifest from staged grammars",
			async task() {
				await rebuildManifestFromStaged(p);
			},
		},
		...linkAddonTasks(p),
	]);
}

/** cargo build for the host triple + copy the cdylib into the npm package. */
function linkAddonTasks(p: ReturnType<typeof paths>): ListrTask[] {
	return [
		{
			title: "building arborium-rt-node",
			async task(_ctx, task) {
				const manifest = join(p.nodeGrammarsOut, "manifest.json");
				const triple = hostTriple();
				task.output = `building arborium-rt-node for ${triple}`;
				await run(
					task.stdout(),
					"cargo",
					["build", "--release", "-p", "arborium-rt-node"],
					{
						cwd: p.repoRoot,
						env: {
							CARGO_BUILD_TARGET: triple,
							ARBORIUM_RT_NODE_GRAMMARS: manifest,
						},
					},
				);
			},
		},
		{
			title: "copying addon into the npm package",
			async task() {
				const triple = hostTriple();
				const ext = process.platform === "darwin" ? "dylib" : "so";
				const builtLib = join(
					p.repoRoot,
					"target",
					triple,
					"release",
					`libarborium_rt_node.${ext}`,
				);

				await mkdir(p.nodePackageDir, { recursive: true });
				const dest = join(p.nodePackageDir, "arborium-rt-node.node");
				await copyFile(builtLib, dest);
			},
		},
	];
}

type ScannerKind = "none" | "c";

async function isFile(path: string): Promise<boolean> {
	return stat(path)
		.then((s) => s.isFile())
		.catch(() => false);
}

/**
 * Concurrency for grammar staging, bounded by BOTH cpu and memory.
 *
 * `tree-sitter generate` for the largest grammars (verilog, typescript, lean,
 * cobol, …) can each spike to several GB while it builds the full parse table.
 * Unlike the wasm build — which is sharded one arborium group per runner, so big
 * grammars rarely coincide — the node addon stages the whole corpus on a single
 * runner, so a cluster of big grammars generating at once will OOM-kill the
 * runner (it dies with SIGTERM / exit 143 mid-staging). Reserve ~6 GiB of
 * headroom per concurrent generate so memory, not just cpu count, caps the pool.
 */
function stagingConcurrency(): number {
	const perJobBytes = 6 * 1024 ** 3;
	const byMemory = Math.max(1, Math.floor(totalmem() / perJobBytes));
	return Math.max(1, Math.min(availableParallelism(), byMemory));
}

/** One grammar's entry in the manifest `lib/node/build.rs` reads. */
interface ManifestGrammar {
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
	/** Restrict to one arborium group (drives the per-group staging matrix). */
	group?: string;
}

interface BuildNodeGrammarsContext {
	index: Map<string, GrammarIndexEntry>;
	built: ManifestGrammar[];
}

interface BuildSingleGrammarContext extends BuildNodeGrammarsContext {
	defDir: string;
	langOut: string;
	buildDir: string;
	cSymbol: string;
}

export function buildNodeGrammars(
	args: BuildNodeGrammarsArgs = {},
): ListrTask<BuildNodeGrammarsContext>[] {
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

				await mkdir(p.nodeGrammarsOut, { recursive: true });

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
					join(p.nodeGrammarsOut, "manifest.json"),
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

				ctx.langOut = join(p.nodeGrammarsOut, id);
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

/**
 * Build one grammar's manifest entry purely from its staged dir on disk
 * (`<nodeGrammarsOut>/<id>/`) — no generate, no access to the original def dir.
 * Shared by {@link stageOne} (right after staging) and
 * {@link rebuildManifestFromStaged} (link-only, from downloaded sources), so the
 * manifest is always derived from the same source of truth: the staged files.
 */
async function manifestEntryFor(
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
 * the link-only build (`package node`) so a runner that merely
 * downloaded the staging matrix's sources can produce a complete, accurate
 * manifest without the tree-sitter CLI or a manifest artifact.
 */
async function rebuildManifestFromStaged(
	p: ReturnType<typeof paths>,
): Promise<void> {
	const index = await buildGrammarIndex(p.langsRoots);

	let dirents: Dirent[];
	try {
		dirents = await readdir(p.nodeGrammarsOut, { withFileTypes: true });
	} catch {
		throw new Error(
			`no staged grammars at ${p.nodeGrammarsOut}. run \`arborium-rt build node\` first (or download the grammars-node artifacts).`,
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
