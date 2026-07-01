// Link the statically-linked Node native addon from already-staged grammar
// sources (`build node`), driving napi-rs's `NapiCli().build()`.
//
// This is the linking half of the Node build; the staging half (`build node
// grammars`, in build/node/grammars.ts) produces the per-grammar sources this
// consumes. It assembles the publishable native addon for the host platform.
//
// We drive napi-rs's `NapiCli.build()` programmatic API (not the `napi` bin) —
// no subprocess/shell, so nothing platform-specific about launching it (the bin
// is a `.cmd` shim on Windows that Node can't spawn without a shell). `build`
// itself wraps `cargo build` and then post-processes: it copies the produced
// cdylib into the npm package as `arborium-rt-node.<platformArchABI>.node`
// (basename from the config's `napi.binaryName`), and regenerates the loader
// `binding.cjs` + types `binding.d.cts` that `src/index.ts` imports. We then
// move that `.node` into its per-platform sub-package dir, `npm/<platformArchABI>/`
// — those dirs are pnpm workspace members the main package depends on via
// `workspace:*` optionalDependencies, so the loader resolves the right binary
// through normal node resolution (locally via the workspace symlink, in a
// consumer install via the published per-platform package).
//
// We don't set CARGO_UNSTABLE_BUILD_STD: the host build links the prebuilt std,
// and `.cargo/config.toml` no longer pins build-std, so nothing needs clearing —
// setting it here would instead *enable* build-std with an empty crate set and
// rebuild `core` (duplicate-lang-item link error). The grammar manifest path is
// handed to lib/node/build.rs via ARBORIUM_RT_NODE_GRAMMARS.

import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { NapiCli } from "@napi-rs/cli";
import { Listr, type ListrTask } from "listr2";
import { rebuildManifestFromStaged } from "../../../lib/node-manifest.ts";
import { type paths, paths as resolvePaths } from "../../../lib/util.ts";

/** `arborium-rt-node.<platformArchABI>.node` → capture the platformArchABI. */
const ADDON_RE = /^arborium-rt-node\.(.+)\.node$/;

/**
 * Link the statically-linked addon from grammar sources already staged under
 * `nodeGrammarsOut` (e.g. produced by `build node grammars`, or downloaded from
 * the `grammars-node` matrix). Regenerates the manifest by scanning the staged
 * dirs, so it needs neither the tree-sitter CLI nor a manifest artifact.
 *
 * `target` cross-compiles for an explicit Rust target triple instead of the
 * host platform — used to build the darwin-x64 addon on an Apple Silicon
 * runner (`x86_64-apple-darwin`), since GitHub's Intel macOS runners queue for
 * a long time. The target's Rust std must already be installed (`rustup target
 * add <triple>`); Apple's clang cross-compiles the cc-built parser sources
 * with no extra toolchain.
 */
export function buildNode(target?: string) {
	const p = resolvePaths();

	return new Listr([
		{
			title: "regenerating manifest from staged grammars",
			async task() {
				await rebuildManifestFromStaged(p);
			},
		},
		napiBuildTask(p, target),
		stageAddonTask(p),
	]);
}

/**
 * `NapiCli.build()` from the npm package dir. `platform: true` names the
 * artifact after the target's platformArchABI (e.g. `darwin-x64`), so the
 * staged sub-package dir is the same whether native or cross. Without `target`,
 * that's the runner's own platform; with `target`, it cross-compiles for that
 * Rust triple (its std must already be installed). `platform` must stay even
 * when a `target` is set, or the platformArchABI suffix drops from the filename.
 *
 * v3 defaults `outputDir` to the *crate* folder (lib/node); we pin it to the
 * npm package dir so `binding.cjs`/`binding.d.cts` + the `.node` land there
 * (where `src/index.ts` and `stageAddonTask` expect them). `package` is cargo's
 * `-p` (the crate to build); `manifestPath` points cargo at lib/node/Cargo.toml.
 * build.rs reads the grammar manifest from `ARBORIUM_RT_NODE_GRAMMARS`, which
 * cargo inherits from this process's env (the programmatic API takes no `env`),
 * so we set it here — this process's only job is the build.
 */
function napiBuildTask(
	p: ReturnType<typeof paths>,
	target?: string,
): ListrTask {
	return {
		title: "building arborium-rt-node",
		async task(_ctx, task) {
			process.env.ARBORIUM_RT_NODE_GRAMMARS = join(
				p.nodeGrammarsOut,
				"manifest.json",
			);
			task.output = `napi build --platform${target ? ` --target ${target}` : ""}`;
			const { task: build } = await new NapiCli().build({
				cwd: p.nodePackageDir,
				outputDir: p.nodePackageDir,
				manifestPath: join(p.repoRoot, "lib", "node", "Cargo.toml"),
				package: "arborium-rt-node",
				platform: true,
				release: true,
				...(target ? { target } : {}),
				jsBinding: "binding.cjs",
				dts: "binding.d.cts",
			});
			await build;
		},
	};
}

/**
 * Move the freshly built `arborium-rt-node.<platformArchABI>.node` out of the
 * main package dir and into its `npm/<platformArchABI>/` sub-package, whose
 * `package.json` (committed, generated by `napi create-npm-dirs`) declares the
 * matching `main` + `os`/`cpu`/`libc`.
 */
function stageAddonTask(p: ReturnType<typeof paths>): ListrTask {
	return {
		title: "staging addon into its npm/<platform> sub-package",
		async task(_ctx, task) {
			const entries = await readdir(p.nodePackageDir);
			const addons = entries.filter((f) => ADDON_RE.test(f));
			if (addons.length === 0) {
				throw new Error(
					`napi build produced no arborium-rt-node.*.node in ${p.nodePackageDir}`,
				);
			}
			for (const file of addons) {
				const platform = ADDON_RE.exec(file)?.[1];
				if (!platform) continue;
				const destDir = join(p.nodePackageDir, "npm", platform);
				await mkdir(destDir, { recursive: true });
				await rename(join(p.nodePackageDir, file), join(destDir, file));
				task.output = `staged ${file} → npm/${platform}/`;
			}
		},
	};
}
