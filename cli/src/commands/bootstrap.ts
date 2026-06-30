// Submodule setup: apply local patches to each submodule's working tree,
// render arborium's Cargo.toml templates, write a stub
// `arborium-theme/src/builtin_generated.rs` (the upstream build pipeline
// requires the file to exist for `theme.rs`'s `include!`), and build the
// patched tree-sitter CLI used by `build-grammar`.
//
// Patches are applied via `git apply` (working-tree only — no commits, no
// committer identity required). Each run resets the submodules to their
// pinned upstream SHAs first, so patches never stack.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Listr, type ListrTask } from "listr2";
import { hostTriple, paths, run } from "../lib/util.ts";

/** Local version string rendered into each `Cargo.toml` from its template. */
const RENDER_VERSION = "0.0.0-arborium-rt";

export function bootstrap(): Listr {
	const p = paths();
	const tasks = applyPatches();

	tasks.add([
		{
			title: `building patched tree-sitter CLI -> ${p.treeSitterBin}`,
			async task(_ctx, task) {
				// The repo root's `.cargo/config.toml` pins target=wasm32-unknown-emscripten
				// for the runtime crate; we need the host triple here, so override
				// CARGO_BUILD_TARGET. Same hostTriple() helper that paths() uses, so the
				// produced binary lands exactly where p.treeSitterBin expects.
				await run(
					task.stdout(),
					"cargo",
					[
						"build",
						"--release",
						"-p",
						"tree-sitter-cli",
						"--bin",
						"tree-sitter",
					],
					{
						cwd: p.treeSitterRoot,
						env: { CARGO_BUILD_TARGET: hostTriple() },
					},
				);

				await stat(p.treeSitterBin);
			},
		},
	]);

	return tasks;
}

/**
 * Working-tree-only setup: reset each submodule to its pinned commit, apply
 * local patches, render `Cargo.toml` from templates, and write the stub
 * `builtin_generated.rs`. Does not build the tree-sitter CLI — see
 * {@link bootstrap} for the full setup. CI's per-group grammars job uses
 * this directly so it can reuse the CLI artifact built once in `prep`,
 * instead of rebuilding it on every matrix shard.
 */
export function applyPatches() {
	const p = paths();

	return new Listr([
		{
			title: "updating submodules",
			async task(_ctx, task) {
				await run(task.stdout(), "git", [
					"submodule",
					"update",
					"--init",
					"--recursive",
				]);
			},
		},
		{
			title: "resetting arborium submodule to its pinned commit",
			async task(_ctx, task) {
				await run(task.stdout(), "git", [
					"-C",
					p.repoRoot,
					"submodule",
					"update",
					"--init",
					"--force",
					"third_party/arborium",
				]);
				await run(task.stdout(), "git", [
					"-C",
					p.submoduleRoot,
					"clean",
					"-fd",
				]);

				return task.newListr(
					await applyPatchDir(p.submoduleRoot, p.arboriumPatchesDir),
				);
			},
		},
		{
			title: `rendering Cargo.toml from Cargo.stpl.toml (version ${RENDER_VERSION})`,
			async task() {
				const cratesDir = join(p.submoduleRoot, "crates");
				for (const crate of await readdir(cratesDir)) {
					const stpl = join(cratesDir, crate, "Cargo.stpl.toml");
					try {
						const template = await readFile(stpl, "utf8");
						const rendered = template.replaceAll(
							"<%= version %>",
							RENDER_VERSION,
						);
						await writeFile(join(cratesDir, crate, "Cargo.toml"), rendered);
					} catch {}
				}
			},
		},
		{
			title: "writing arborium-theme/src/builtin_generated.rs stub",
			async task() {
				const cratesDir = join(p.submoduleRoot, "crates");
				const content = `// Generated during arborium-rt bootstrap — do not edit.
//
// arborium-theme's src/theme.rs includes this file inside \`pub mod builtin\`.
// arborium-rt does not bundle themes, so this is an empty stub.

use super::Theme;

pub fn all() -> Vec<Theme> {
    Vec::new()
}
`;

				await writeFile(
					join(cratesDir, "arborium-theme", "src", "builtin_generated.rs"),
					content,
				);
			},
		},
		{
			title: "resetting tree-sitter submodule to its pinned commit",
			async task(_ctx, task) {
				await run(task.stdout(), "git", [
					"-C",
					p.repoRoot,
					"submodule",
					"update",
					"--init",
					"--force",
					"third_party/tree-sitter",
				]);
				// Don't `-x`: tree-sitter's gitignored target/ holds incremental build
				// state we want to keep across bootstraps. Patches only touch tracked
				// files, so `clean -fd` is enough to undo a prior patch.
				await run(task.stdout(), "git", [
					"-C",
					p.treeSitterRoot,
					"clean",
					"-fd",
				]);

				return task.newListr(
					await applyPatchDir(p.treeSitterRoot, p.treeSitterPatchesDir),
				);
			},
		},
	]);
}

/**
 * Apply every `*.patch` file in `patchesDir` (sorted by name) to the working
 * tree of `submoduleRoot`. Patches are mbox-format `git format-patch` output;
 * `git apply` tolerates the preamble and reads the unified diff body, so no
 * committer identity is needed and nothing gets committed in the submodule.
 */
async function applyPatchDir(
	submoduleRoot: string,
	patchesDir: string,
): Promise<ListrTask[]> {
	try {
		const patches = (await readdir(patchesDir))
			.filter((name) => name.endsWith(".patch"))
			.sort();
		const dirLabel = basename(patchesDir);

		return patches.map((patch) => ({
			title: `applying ${dirLabel}/${patch}`,
			async task(_ctx, task) {
				await run(task.stdout(), "git", [
					"-C",
					submoduleRoot,
					"apply",
					"--whitespace=nowarn",
					join(patchesDir, patch),
				]);
			},
		}));
	} catch {
		return [];
	}
}
