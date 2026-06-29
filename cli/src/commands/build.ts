// Iterate every grammar in the arborium submodule, attempt
// build-grammar + package, collect per-grammar results.
//
// Grammars fail for a variety of reasons (tree-sitter-generate ABI mismatches,
// missing upstream node_modules that aren't declared in arborium.yaml,
// structurally-odd vendored layouts). Each failure is logged but doesn't
// abort the run; the closing summary names winners and losers.
//
// Per-grammar work runs in parallel (bounded by `jobs`) — each grammar's
// stderr is line-prefixed with its id so interleaved tool output stays
// readable on a shared terminal.

import { availableParallelism } from "node:os";
import { Listr, type ListrTask } from "listr2";
import { buildGrammarIndex, type GrammarIndexEntry } from "../arborium-yaml.ts";
import { buildGrammar } from "../commands/build/grammar.ts";
import { paths } from "../util.ts";
import { buildPackage } from "./build/package.ts";

export interface BuildAllArgs {
	/** If set, only try these grammar ids (for debugging). */
	only?: string[];
	/** If set, only build grammars in this arborium group (e.g. `group-acorn`). */
	group?: string;
	/** If set, don't run `package` after `build-grammar` (wasm + queries only). */
	skipPackage?: boolean;
	/** Max concurrent grammar builds. Defaults to `os.availableParallelism()`. */
	jobs?: number;
}

export interface BuildAllResult {
	readonly ok: string[];
	readonly failed: Array<{ id: string; reason: string }>;
}

interface BuildAllContext {
	index: Map<string, GrammarIndexEntry>;
	targets: string[];
}

export function buildAll(args: BuildAllArgs = {}) {
	return new Listr<BuildAllContext>([
		{
			async task(ctx) {
				const p = paths();
				const index = await buildGrammarIndex(p.langsRoots);
				ctx.index = index;

				let targets =
					args.only && args.only.length > 0
						? args.only.filter((id) => index.has(id))
						: [...index.keys()].sort();
				if (args.group) {
					targets = targets.filter((id) => index.get(id)?.group === args.group);
				}

				ctx.targets = targets;
			},
		},
		{
			async task(ctx, task) {
				return task.newListr(
					ctx.targets.map((id) => ({
						async task(_ctx, task) {
							// `concurrent: false` is load-bearing: listr2 merges the parent
							// list's options into every nested list (see Listr's
							// `result.options = { ...this.options, ...result.options }`), so
							// without an explicit override this sub-list would inherit the
							// outer `concurrent: availableParallelism()` and run a grammar's
							// build + package steps in parallel. The per-grammar steps are
							// strictly ordered (rm/stage → generate → compile → link →
							// package), so they must stay sequential.
							return task.newListr(buildLang(args, id), {
								ctx,
								concurrent: false,
							});
						},
					})),
					{
						concurrent: availableParallelism(),
						collectErrors: "minimal",
						exitOnError: false,
					},
				);
			},
		},
	]);
}

function buildLang(
	args: BuildAllArgs,
	id: string,
): ListrTask<BuildAllContext>[] {
	return [
		{
			title: `building ${id}`,
			async task(ctx, task) {
				const entry = ctx.index.get(id);
				if (!entry) {
					throw new Error("grammar not in index");
				}

				return task.newListr(
					buildGrammar({
						group: entry.group,
						lang: id,
						index: ctx.index,
					}),
					{ ctx: { index: ctx.index } as any },
				);
			},
		},
		{
			title: `packaging ${id}`,
			skip: args.skipPackage === true,
			async task(ctx, task) {
				const entry = ctx.index.get(id);
				if (!entry) {
					throw new Error("grammar not in index");
				}

				return task.newListr(
					buildPackage({ group: entry.group, lang: id, index: ctx.index }),
				);
			},
		},
	];
}
