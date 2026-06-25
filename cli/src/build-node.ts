// Build the statically-linked Node native addon.
//
// Stages the grammars (unless --skip-grammars), then drives `cargo build` for
// the HOST triple via CARGO_BUILD_TARGET (which also lands the artifact under
// the triple-prefixed target dir). No build-std: the host build links the
// prebuilt std, and `.cargo/config.toml` no longer pins build-std, so nothing
// needs clearing — setting CARGO_UNSTABLE_BUILD_STD here would instead *enable*
// build-std with an empty crate set and rebuild `core` (duplicate-lang-item
// link error). The manifest path is handed to build.rs via
// ARBORIUM_RT_NODE_GRAMMARS. Finally copies the produced cdylib to the npm
// package as `arborium-rt-node.node`.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
	type BuildNodeGrammarsArgs,
	buildNodeGrammars,
} from "./build-node-grammars.js";
import { hostTriple, Logger, paths, run } from "./util.js";

export interface BuildNodeArgs extends BuildNodeGrammarsArgs {
	/** Reuse an existing manifest instead of re-staging the grammars. */
	skipGrammars?: boolean;
}

export async function buildNode(args: BuildNodeArgs = {}): Promise<void> {
	const p = paths();
	const log = new Logger("node");

	if (!args.skipGrammars) {
		const res = await buildNodeGrammars(args);
		log.step(
			`staged ${res.built.length} grammar(s)` +
				(res.failed.length ? `, ${res.failed.length} failed` : ""),
		);
		if (res.built.length === 0) {
			throw new Error("no grammars staged; cannot build the addon");
		}
	}

	const manifest = join(p.nodeGrammarsOut, "manifest.json");
	if (!existsSync(manifest)) {
		throw new Error(
			`grammar manifest not found at ${manifest}; run without --skip-grammars`,
		);
	}

	const triple = hostTriple();
	log.step(`building arborium-rt-node for ${triple}`);
	await run(log, "cargo", ["build", "--release", "-p", "arborium-rt-node"], {
		cwd: p.repoRoot,
		env: {
			CARGO_BUILD_TARGET: triple,
			ARBORIUM_RT_NODE_GRAMMARS: manifest,
		},
	});

	const ext = process.platform === "darwin" ? "dylib" : "so";
	const builtLib = join(
		p.repoRoot,
		"target",
		triple,
		"release",
		`libarborium_rt_node.${ext}`,
	);
	if (!existsSync(builtLib)) {
		throw new Error(`expected addon at ${builtLib}, not found`);
	}
	mkdirSync(p.nodePackageDir, { recursive: true });
	const dest = join(p.nodePackageDir, "arborium-rt-node.node");
	copyFileSync(builtLib, dest);
	log.step(`copied addon -> ${dest}`);
}
