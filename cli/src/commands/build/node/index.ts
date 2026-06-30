// Link the statically-linked Node native addon from already-staged grammar
// sources (`build node`).
//
// This is the linking half of the Node build; the staging half (`build node
// grammars`, in build/node/grammars.ts) produces the per-grammar sources this
// consumes. It assembles the publishable target artifact (`arborium-rt-node.node`)
// from those already-built inputs. The cargo build targets the HOST triple via
// CARGO_BUILD_TARGET (which also lands the artifact under the triple-prefixed
// target dir). No build-std: the host build links the prebuilt std, and
// `.cargo/config.toml` no longer pins build-std, so nothing needs clearing —
// setting CARGO_UNSTABLE_BUILD_STD here would instead *enable* build-std with an
// empty crate set and rebuild `core` (duplicate-lang-item link error). The
// manifest path is handed to build.rs via ARBORIUM_RT_NODE_GRAMMARS. Finally
// copies the produced cdylib to the npm package as `arborium-rt-node.node`.

import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Listr, type ListrTask } from "listr2";
import { rebuildManifestFromStaged } from "../../../lib/node-manifest.ts";
import { hostTriple, paths, run } from "../../../lib/util.ts";

/**
 * Link the statically-linked addon from grammar sources already staged under
 * `nodeGrammarsOut` (e.g. produced by `build node grammars`, or downloaded from
 * the `grammars-node` matrix). Regenerates the manifest by scanning the staged
 * dirs, so it needs neither the tree-sitter CLI nor a manifest artifact.
 */
export function buildNode() {
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
