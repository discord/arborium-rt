// Shared CLI helpers: repo-root discovery, child-process execution, logging.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";

/**
 * Walk up from `start` until a directory contains a marker file identifying
 * the arborium-rt repo (the root Cargo.toml with the crate name). Falls back
 * to `$ARBORIUM_RT_ROOT` if set.
 *
 * The marker approach avoids fragile `import.meta.url`-based path math that
 * breaks when the CLI is installed as a published npm dep outside the repo.
 */
export function findRepoRoot(start: string = process.cwd()): string {
	if (process.env["ARBORIUM_RT_ROOT"]) return process.env["ARBORIUM_RT_ROOT"];
	let dir = resolve(start);
	while (true) {
		const cargo = join(dir, "Cargo.toml");
		if (existsSync(cargo)) {
			const content = readFileSync(cargo, "utf8");
			// Match the root package manifest specifically. A bare
			// "arborium-rt" substring also matches lib/wasm's manifest
			// (`name = "arborium-rt-wasm"` and its path dep on the root),
			// which would resolve the repo root to lib/wasm/ when invoked
			// from there. The closing quote pins this to the root crate.
			if (content.includes('name = "arborium-rt"')) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(
				`not inside an arborium-rt checkout (no Cargo.toml declaring arborium-rt in ${start} or any ancestor)`,
			);
		}
		dir = parent;
	}
}

/** Common paths derived from the repo root. */
export interface Paths {
	readonly repoRoot: string;
	readonly submoduleRoot: string;
	readonly langsRoot: string;
	/**
	 * Repo-local langs root. Holds grammar definitions vendored directly
	 * into arborium-rt rather than the arborium submodule — used when we
	 * need a grammar (e.g. `markdown_inline`) that arborium itself doesn't
	 * package. Scanned alongside `langsRoot`; ids defined here shadow
	 * upstream ones on collision.
	 */
	readonly localLangsRoot: string;
	/**
	 * Both langs roots in scan order. Pass to `buildGrammarIndex`.
	 */
	readonly langsRoots: readonly string[];
	/** Patches applied to the arborium submodule by `bootstrap`. */
	readonly arboriumPatchesDir: string;
	/**
	 * `third_party/tree-sitter/` — the upstream tree-sitter submodule. We
	 * vendor + patch it so we can build a `tree-sitter` CLI that emits
	 * sparse-only parser tables (see TREE_SITTER_SPARSE_ONLY in render.rs).
	 */
	readonly treeSitterRoot: string;
	/** Patches applied to the tree-sitter submodule by `bootstrap`. */
	readonly treeSitterPatchesDir: string;
	/**
	 * Path to the locally-built, patched tree-sitter CLI. `build-grammar`
	 * invokes this instead of any system-installed `tree-sitter` so the
	 * sparse-only env var actually has an effect.
	 */
	readonly treeSitterBin: string;
	readonly targetDir: string;
	readonly grammarsOut: string;
	/**
	 * `target/node-grammars/` — staging root for the statically-linked Node
	 * addon. Holds per-grammar generated `parser.c` + scanner + flattened
	 * `.scm` files plus a top-level `manifest.json` that `lib/node/build.rs`
	 * consumes to compile the C in and bake the queries as `&'static str`.
	 */
	readonly nodeGrammarsOut: string;
	/** `packages/arborium-rt-node/` — the native-addon npm package. */
	readonly nodePackageDir: string;
	/**
	 * Directory where per-grammar subdirs (index.js / index.d.ts / wasm /
	 * .scm) are emitted. Lives inside the runtime package's `dist/` so the
	 * subpath exports (`@discord/arborium-rt/grammars/<lang>`) resolve
	 * to a sibling of the compiled TS.
	 */
	readonly packagesOut: string;
	readonly hostWasmOut: string;
	readonly runtimeWasm: string;
	/** `packages/arborium-rt-wasm/` — the browser runtime library package. */
	readonly runtimePackageDir: string;
	/** `cli/` — this CLI's own package. */
	readonly cliPackageDir: string;
	readonly bindingRoot: string;
}

export function paths(repoRoot: string = findRepoRoot()): Paths {
	const treeSitterRoot = join(repoRoot, "third_party", "tree-sitter");
	const langsRoot = join(repoRoot, "third_party", "arborium", "langs");
	const localLangsRoot = join(repoRoot, "langs");
	return {
		repoRoot,
		submoduleRoot: join(repoRoot, "third_party", "arborium"),
		langsRoot,
		localLangsRoot,
		langsRoots: [langsRoot, localLangsRoot],
		bindingRoot: join(
			repoRoot,
			"third_party",
			"arborium",
			"crates",
			"arborium-tree-sitter",
		),
		arboriumPatchesDir: join(repoRoot, "patches", "arborium"),
		treeSitterRoot,
		treeSitterPatchesDir: join(repoRoot, "patches", "tree-sitter"),
		treeSitterBin: join(
			treeSitterRoot,
			"target",
			hostTriple(),
			"release",
			"tree-sitter",
		),
		targetDir: join(repoRoot, "target"),
		grammarsOut: join(repoRoot, "target", "grammars"),
		nodeGrammarsOut: join(repoRoot, "target", "node-grammars"),
		nodePackageDir: join(repoRoot, "packages", "arborium-rt-node"),
		packagesOut: join(
			repoRoot,
			"packages",
			"arborium-rt-wasm",
			"dist",
			"grammars",
		),
		hostWasmOut: join(repoRoot, "target", "host-wasm"),
		runtimeWasm: join(
			repoRoot,
			"target",
			"wasm32-unknown-emscripten",
			"release",
			"arborium_rt_wasm.wasm",
		),
		runtimePackageDir: join(repoRoot, "packages", "arborium-rt-wasm"),
		cliPackageDir: join(repoRoot, "cli"),
	};
}

/**
 * Cargo's host triple, used to find the patched tree-sitter binary under
 * `third_party/tree-sitter/target/<triple>/release/`. We always build with
 * `CARGO_BUILD_TARGET=<host>` to override the repo's emscripten-pinned
 * default in `.cargo/config.toml`, which means the binary lands under the
 * triple-prefixed dir, not the bare `target/release/`.
 */
export function hostTriple(): string {
	if (process.env["ARBORIUM_RT_HOST_TRIPLE"])
		return process.env["ARBORIUM_RT_HOST_TRIPLE"];
	const arch =
		process.arch === "x64"
			? "x86_64"
			: process.arch === "arm64"
				? "aarch64"
				: process.arch;
	if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
	if (process.platform === "darwin") return `${arch}-apple-darwin`;
	// Windows only runs `build node` (+ apply-patches), which never touches the
	// tree-sitter CLI — so this value isn't used to locate a binary there; it
	// just has to be a valid triple so `paths()` construction doesn't throw.
	if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
	throw new Error(
		`unsupported host platform ${process.platform}/${process.arch}; set ARBORIUM_RT_HOST_TRIPLE`,
	);
}

export interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Pipe a string as stdin. Useful for `git am <patch`. */
	input?: string;
}

/**
 * Run a command with its stdout/stderr piped to `output` (typically a listr
 * task's stream). Rejects on non-zero exit; the Error message includes the
 * command for grep-ability.
 */
export async function run(
	output: Writable,
	cmd: string,
	args: readonly string[],
	options: RunOptions = {},
): Promise<void> {
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const wantsInput = options.input !== undefined;

		const child = spawn(cmd, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: [wantsInput ? "pipe" : "ignore", "pipe", "pipe"],
		});
		if (wantsInput) {
			child.stdin?.end(options.input);
		}
		child.stdout?.pipe(output);
		child.stderr?.pipe(output);

		child.once("error", rejectPromise);
		child.once("close", (code) => {
			if (code === 0) resolvePromise();
			else
				rejectPromise(
					new Error(`${cmd} ${args.join(" ")} exited with code ${code}`),
				);
		});
	});
}

/**
 * Like `run`, but buffers the child's stdout and returns it as a string
 * instead of forwarding it to `output`. Stderr is still piped to `output`.
 * Use for tools whose stdout is data the caller needs to parse (e.g.
 * `askalono crawl`'s JSON stream).
 */
export async function runCapture(
	output: Writable,
	cmd: string,
	args: readonly string[],
	options: RunOptions = {},
): Promise<string> {
	return await new Promise<string>((resolvePromise, rejectPromise) => {
		const wantsInput = options.input !== undefined;
		const child = spawn(cmd, args as string[], {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: [wantsInput ? "pipe" : "ignore", "pipe", "pipe"],
		});
		if (wantsInput) {
			child.stdin?.end(options.input);
		}
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.pipe(output);
		child.once("error", rejectPromise);
		child.once("close", (code) => {
			if (code === 0) resolvePromise(stdout);
			else
				rejectPromise(
					new Error(`${cmd} ${args.join(" ")} exited with code ${code}`),
				);
		});
	});
}

export function normalizeCSymbol(cSymbol: string | undefined, lang: string) {
	return cSymbol ?? lang.replace(/-/g, "_");
}
