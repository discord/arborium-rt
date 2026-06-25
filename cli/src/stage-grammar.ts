// Target-agnostic grammar staging helpers, shared by the wasm SIDE_MODULE
// build (`build-grammar.ts`) and the statically-linked Node addon build
// (`build-node-grammars.ts`). None of these touch emcc or the linker — they
// only stage source so `tree-sitter generate` can run and a scanner's
// `#include`s resolve.

import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	symlinkSync,
} from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ListrTask } from "listr2";
import type { GrammarIndexEntry } from "./arborium-yaml.js";

/**
 * Symlink each transitively-required dep's def/grammar/ dir into
 * `<buildDir>/node_modules/<tree-sitter-X>/`. Node's require() walks up
 * looking for node_modules, so transitive resolution works as long as
 * every dep is at the top level of the build dir's node_modules.
 */
export function stageNpmDeps(
	start: GrammarIndexEntry,
	index: Map<string, GrammarIndexEntry>,
	buildDir: string,
): ListrTask[] {
	const staged = new Set<string>();

	function walk(entry: GrammarIndexEntry): ListrTask[] {
		const tasks: ListrTask[] = [];

		for (const dep of entry.grammar.dependencies ?? []) {
			tasks.push({
				async task(_ctx, task) {
					if (!dep.npm) return;
					if (staged.has(dep.npm)) return;

					// Convention: npm dep "tree-sitter-<X>" corresponds to arborium
					// grammar id <X>. If the dep doesn't resolve, skip with a warning
					// — some upstream deps (e.g. `tree-sitter-clojure` for commonlisp)
					// are vendored under different group dirs, but the id-based
					// lookup still finds them.
					const depId = dep.npm.replace(/^tree-sitter-/, "");
					const depEntry = index.get(depId);
					if (!depEntry) {
						task.skip(
							`dep ${dep.npm} -> grammar id ${depId} not found in corpus`,
						);
						return;
					}
					staged.add(dep.npm);

					const target = join(depEntry.defPath, "grammar");
					task.output = `staging node_modules/${dep.npm} -> ${relative(buildDir, target)}`;

					const linkPath = join(buildDir, "node_modules", dep.npm);
					await mkdir(join(buildDir, "node_modules"), { recursive: true });
					try {
						await symlink(target, linkPath, "dir");
					} catch (e) {
						const err = e as NodeJS.ErrnoException;
						if (err.code !== "EEXIST") throw e;
					}

					// Recurse so transitive deps (HLSL -> CPP -> C) are also staged.
					return walk(depEntry);
				},
			});
		}

		return tasks;
	}

	return walk(start);
}

/**
 * Stage a copy of the grammar directory under `<buildDir>/grammar-stage/`
 * in a nested layout that satisfies both `./<x>` and `../<x>` relative
 * requires from grammar.js. Returns the absolute path to the staged
 * grammar.js.
 *
 *   <buildDir>/grammar-stage/
 *     grammar/       <- full copy of def/grammar/
 *       grammar.js   <- run tree-sitter generate against this copy
 *       ...
 *     <sibling>/     <- each non-`grammar` subdir of def/ copied here
 *                       (upstream-style layout: e.g., asciidoc's
 *                       `def/common/common.js`)
 *     <nested>/      <- each subdir of def/grammar/ ALSO copied here
 *                       (flattened vendoring: e.g., markdown's
 *                       `def/grammar/common/common.js` read as
 *                       `../common/common.js` from grammar.js)
 *
 * If both passes contribute a dir with the same name, the second pass
 * (nested → sibling) merges into the first via cpSync's default force.
 */
export function stageGrammarSource(defDir: string, buildDir: string): string {
	const stageRoot = join(buildDir, "grammar-stage");
	const stageGrammar = join(stageRoot, "grammar");
	const grammarDir = join(defDir, "grammar");

	// Full copy of the grammar dir into stage/grammar/.
	cpSync(grammarDir, stageGrammar, { recursive: true });

	// Pass 1: def/'s non-grammar subdirs become siblings of stage/grammar/.
	for (const entry of readdirSync(defDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "grammar") continue;
		cpSync(join(defDir, entry.name), join(stageRoot, entry.name), {
			recursive: true,
		});
	}

	// Pass 2: def/grammar/'s own subdirs also become siblings, merging with
	// whatever pass 1 already wrote under the same name.
	for (const entry of readdirSync(grammarDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		cpSync(join(grammarDir, entry.name), join(stageRoot, entry.name), {
			recursive: true,
		});
	}

	return join(stageGrammar, "grammar.js");
}

/**
 * Recursively copy grammar-shipped C/C++ support files into the build dir's
 * `src/` so scanner.c's `#include`s resolve. Covers headers (.h/.hpp) and
 * auxiliary sources that scanners pull in as textual includes (e.g., yaml's
 * `schema.core.c` / `schema.json.c` / `schema.legacy.c`). parser.c is
 * deliberately excluded — we generate that fresh from grammar.js.
 */
export async function copySupportFiles(
	src: string,
	dst: string,
): Promise<void> {
	if (!existsSync(src)) return;
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const full = join(src, entry.name);
		if (entry.isDirectory()) {
			copySupportFiles(full, join(dst, entry.name));
			continue;
		}
		if (!entry.isFile()) continue;
		if (entry.name === "parser.c") continue;
		if (!/\.(h|hpp|c|cc|cpp)$/.test(entry.name)) continue;
		mkdirSync(dst, { recursive: true });
		copyFileSync(full, join(dst, entry.name));
	}
}
