// The `package wasm grammars` command for the browser runtime
// (`@discord/arborium-rt-wasm`):
//
//   packageGrammar   stage one built grammar's assets into dist/grammars/<lang>/
//   packageGrammars  repackage every already-built grammar, then regenerate
//                    the grammars.ts index
//
// `packageGrammar` is the per-grammar primitive — it copies a grammar's
// tree-sitter-<lang>.wasm + flattened `.scm` + attribution files into the
// runtime package's dist/, and nothing else. The whole-corpus index
// regeneration is deliberately kept out of it so `package wasm grammars` can
// run it exactly once at the end instead of racing it per grammar.
//
// THIRD_PARTY_NOTICES generation is intentionally NOT part of this command —
// it clones every upstream over the network, which is slow and unrelated to
// staging the already-built assets. Run `arborium-rt notices` separately
// (e.g. as its own CI step) when the published tarball needs it.

import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Listr, type ListrTask } from "listr2";
import {
	buildGrammarIndex,
	type GrammarIndexEntry,
} from "../../../lib/arborium-yaml.ts";
import { QUERY_TYPES, type QueryType } from "../../../lib/flatten.ts";
import { detectLicenses, findNoticeFiles } from "../../../lib/grammar-clone.ts";
import { paths } from "../../../lib/util.ts";
import { writeGrammarsIndexModule } from "../../../lib/write-grammars-index.ts";

export interface PackageGrammarArgs {
	group: string;
	lang: string;
	/** Pre-built corpus index. Defaults to scanning the filesystem. */
	index?: Map<string, GrammarIndexEntry>;
}

// Stage a grammar's built assets into the runtime package's
// dist/grammars/<lang>/ so the aggregator module reaches them via
// `new URL('./grammars/<lang>/<file>', import.meta.url)`. Output per grammar:
// tree-sitter-<lang>.wasm plus the flattened `.scm` files and attribution.
export function packageGrammar(args: PackageGrammarArgs): ListrTask[] {
	return [
		{
			async task(_ctx, task) {
				const p = paths();
				const grammarDir = join(p.grammarsOut, args.lang);
				const outDir = join(p.packagesOut, args.lang);
				const wasmName = `tree-sitter-${args.lang}.wasm`;
				const wasmSrc = join(grammarDir, wasmName);

				const detectedLicenses = await detectLicenses(
					task.stdout(),
					grammarDir,
				);
				const noticeFiles = await findNoticeFiles(grammarDir);
				const attributionFiles = [
					...new Set([
						...detectedLicenses.map((l) => l.file),
						...noticeFiles.map((n) => n.file),
					]),
				].sort();
				if (attributionFiles.length === 0) {
					throw new Error(
						`no LICENSE/NOTICE files in ${grammarDir}. run \`arborium-rt build wasm grammar ${args.group} ${args.lang}\` first to fetch the upstream attribution.`,
					);
				}

				const queries: Partial<Record<QueryType, string>> = {};
				for (const qtype of QUERY_TYPES) {
					const src = join(grammarDir, `${qtype}.scm`);
					const isFile = await stat(src)
						.then((s) => s.isFile())
						.catch(() => false);
					if (isFile) {
						queries[qtype] = src;
					}
				}

				await rm(outDir, { recursive: true, force: true });
				await mkdir(outDir, { recursive: true });

				await copyFile(wasmSrc, join(outDir, wasmName));
				for (const fname of attributionFiles) {
					await copyFile(join(grammarDir, fname), join(outDir, fname));
				}
				for (const [qtype, src] of Object.entries(queries)) {
					await copyFile(src, join(outDir, `${qtype}.scm`));
				}
			},
		},
	];
}

export interface PackageGrammarsArgs {
	/** If set, only repackage these grammar ids. */
	only?: readonly string[];
}

interface PackageGrammarsContext {
	index: Map<string, GrammarIndexEntry>;
	targets: string[];
}

// Re-run `packageGrammar` for every grammar whose wasm already exists under
// target/grammars/<lang>/. Skips the (slow) grammar build step — just
// regenerates packages/arborium-rt-wasm/dist/grammars/<lang>/ from the current
// renderers, then regenerates the grammars.ts index and THIRD_PARTY_NOTICES
// once. Useful after changing the packaging boilerplate.
export function packageGrammars(args: PackageGrammarsArgs = {}) {
	const p = paths();

	return new Listr<PackageGrammarsContext>(
		[
			{
				async task(ctx) {
					let dirents: Dirent[];
					try {
						dirents = await readdir(p.grammarsOut, { withFileTypes: true });
					} catch {
						throw new Error(
							`no grammar build artifacts at ${p.grammarsOut}. run \`arborium-rt build wasm grammars\` first.`,
						);
					}
					ctx.index = await buildGrammarIndex(p.langsRoots);

					const wanted =
						args.only && args.only.length > 0 ? new Set(args.only) : undefined;
					const checked = await Promise.all(
						dirents
							.filter((d) => d.isDirectory())
							.map(async (d) => {
								const hasWasm = await stat(
									join(p.grammarsOut, d.name, `tree-sitter-${d.name}.wasm`),
								).then(
									(s) => s.isFile(),
									() => false,
								);
								return hasWasm ? d.name : null;
							}),
					);
					const candidates = checked
						.filter((name): name is string => name !== null)
						.sort();

					ctx.targets = (
						wanted ? candidates.filter((id) => wanted.has(id)) : candidates
					).filter((id) => ctx.index.has(id));
				},
			},
			{
				title: "packaging grammars",
				async task(ctx, task) {
					return task.newListr(
						ctx.targets.map((id) => ({
							title: `packaging ${id}`,
							async task(_ctx, task) {
								const entry = ctx.index.get(id);
								if (!entry) throw new Error("grammar not in index");
								return task.newListr(
									packageGrammar({
										group: entry.group,
										lang: id,
										index: ctx.index,
									}),
								);
							},
						})),
						{
							concurrent: availableParallelism(),
							exitOnError: false,
						},
					);
				},
			},
			{
				// Rewrite the generated `grammars.ts` index from whatever per-grammar
				// subdirs now exist under the runtime package's dist/. Run once, after
				// every subdir is written — never per-grammar (the scan is whole-corpus
				// and would race under parallel packaging).
				title: "regenerating grammars.ts index",
				async task() {
					await writeGrammarsIndexModule();
				},
			},
		],
		{ concurrent: false },
	);
}
