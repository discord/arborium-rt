// Iterate every grammar in the arborium submodule, attempt
// build-grammar + package, collect per-grammar results. Drives the browser
// (wasm) grammar corpus: `build wasm grammars`.
//
// Grammars fail for a variety of reasons (tree-sitter-generate ABI mismatches,
// missing upstream node_modules that aren't declared in arborium.yaml,
// structurally-odd vendored layouts). A failing step aborts that grammar's
// remaining steps but not the other grammars; once every grammar has been
// attempted, the run fails (non-zero exit) naming the grammars that broke.
//
// Per-grammar work runs in parallel (bounded by `os.availableParallelism()`)
// — each grammar's stderr is line-prefixed with its id so interleaved tool
// output stays readable on a shared terminal.

import { availableParallelism } from "node:os";
import { Listr, type ListrTask } from "listr2";
import {
	buildGrammarIndex,
	type GrammarIndexEntry,
} from "../../../lib/arborium-yaml.ts";
import { paths } from "../../../lib/util.ts";
import { packageGrammar } from "../../package/wasm/grammars.ts";
import { buildGrammar } from "./grammar.ts";

export interface BuildAllArgs {
	/** If set, only try these grammar ids (for debugging). */
	only?: string[];
	/** If set, only build grammars in this arborium group (e.g. `group-acorn`). */
	group?: string;
	/** If set, don't run `package` after `build-grammar` (wasm + queries only). */
	skipPackage?: boolean;
}

export interface BuildAllResult {
	readonly ok: string[];
	readonly failed: Array<{ id: string; reason: string }>;
}

interface BuildAllContext {
	index: Map<string, GrammarIndexEntry>;
	targets: string[];
	/** The per-grammar list; `tasks[i]` builds `targets[i]`. */
	perGrammar: Listr<BuildAllContext>;
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
				ctx.perGrammar = task.newListr(
					ctx.targets.map((id) => ({
						async task(_ctx, task) {
							// `concurrent: false` is load-bearing: listr2 merges the parent
							// list's options into every nested list (see Listr's
							// `result.options = { ...this.options, ...result.options }`), so
							// without an explicit override this sub-list would inherit the
							// outer `concurrent: availableParallelism()` and run a grammar's
							// build + package steps in parallel. The per-grammar steps are
							// strictly ordered (rm/stage → generate → compile → link →
							// package), so they must stay sequential. `exitOnError: true`
							// likewise overrides the outer `false`, so a failed step (e.g.
							// `tree-sitter generate`) stops this grammar instead of running
							// the compile/link/package steps against missing outputs.
							return task.newListr(buildLang(args, id), {
								ctx,
								concurrent: false,
								exitOnError: true,
							});
						},
					})),
					{
						concurrent: availableParallelism(),
						collectErrors: true,
						exitOnError: false,
					},
				);
				return ctx.perGrammar;
			},
		},
		{
			// The per-grammar list swallows failures so every grammar gets
			// attempted; surface them here so the command (and CI) fails.
			async task(ctx) {
				const failed = ctx.targets.filter((_, i) =>
					ctx.perGrammar.tasks[i]?.hasFailed(),
				);
				if (failed.length > 0) {
					throw new Error(
						`${failed.length} of ${ctx.targets.length} grammar(s) failed: ${failed.join(", ")}`,
					);
				}
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
					packageGrammar({ group: entry.group, lang: id, index: ctx.index }),
				);
			},
		},
	];
}
