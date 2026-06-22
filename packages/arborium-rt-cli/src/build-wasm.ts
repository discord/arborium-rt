// Build the wasm SIDE_MODULE runtime (the `arborium-rt-wasm` cdylib).
//
// The workspace no longer pins emscripten as the default target, so this
// drives `cargo build` for wasm32-unknown-emscripten explicitly — supplying
// the target via CARGO_BUILD_TARGET and `-Zbuild-std` via
// CARGO_UNSTABLE_BUILD_STD (std is rebuilt for emscripten; `panic_abort`
// matches the release profile). The SIDE_MODULE link args live in
// `.cargo/config.toml` under `[target.wasm32-unknown-emscripten]`, so they
// apply automatically once the target is selected. Needs emcc on PATH (it's
// the linker for the emscripten target) and a nightly toolchain with rust-src.

import { existsSync } from "node:fs";
import { relative } from "node:path";

import { hasCommand, Logger, paths, run } from "./util.js";

export async function buildWasm(): Promise<void> {
	const p = paths();
	const log = new Logger("wasm");

	if (!(await hasCommand("emcc"))) {
		throw new Error(
			"emcc not found on PATH; source emsdk_env.sh (emsdk 5.x) before building the runtime",
		);
	}

	log.step("building arborium-rt-wasm SIDE_MODULE (wasm32-unknown-emscripten)");
	await run(log, "cargo", ["build", "--release", "-p", "arborium-rt-wasm"], {
		cwd: p.repoRoot,
		env: {
			CARGO_BUILD_TARGET: "wasm32-unknown-emscripten",
			CARGO_UNSTABLE_BUILD_STD: "std,panic_abort",
		},
	});

	if (!existsSync(p.runtimeWasm)) {
		throw new Error(`expected runtime wasm at ${p.runtimeWasm}, not found`);
	}
	log.step(`built ${relative(p.repoRoot, p.runtimeWasm)}`);
}
