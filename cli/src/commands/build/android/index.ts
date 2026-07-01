// Cross-compile the Android JNI shim (`ffi/android`) into one
// `libarborium_rt.so` per ABI and assemble the AAR (`build android`).
//
// This is the Android analogue of `build node`: it links from grammar sources
// already staged by the shared `build native grammars` step (in
// build/native/grammars.ts) — it needs neither the tree-sitter CLI nor emcc,
// just the Android NDK + `cargo-ndk`. The grammar C is statically linked via
// the shared `lib/native` crate (which `ffi/android` depends on).
//
// `cargo-ndk` sets the per-target NDK clang linker/sysroot (via
// `ANDROID_NDK_HOME`), so no `.cargo/config.toml` entry is needed. Its `-o`
// flag copies each built `.so` straight into `<jniLibs>/<abi>/`, which is where
// the AAR's `com.android.library` build picks them up. A single Linux/macOS
// host produces every ABI — no per-ABI runner.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Listr, type ListrTask } from "listr2";
import { rebuildManifestFromStaged } from "../../../lib/native-manifest.ts";
import {
	ANDROID_TARGETS,
	type paths,
	paths as resolvePaths,
	run,
} from "../../../lib/util.ts";

export interface BuildAndroidArgs {
	/** Restrict to these Android ABIs (e.g. `["arm64-v8a", "x86_64"]`). */
	abis?: readonly string[];
}

export function buildAndroid(args: BuildAndroidArgs = {}) {
	const p = resolvePaths();

	const targets = args.abis?.length
		? ANDROID_TARGETS.filter((t) => args.abis?.includes(t.abi))
		: ANDROID_TARGETS;
	if (targets.length === 0) {
		throw new Error(
			`no Android ABIs matched ${JSON.stringify(args.abis)}; valid: ${ANDROID_TARGETS.map((t) => t.abi).join(", ")}`,
		);
	}

	return new Listr([
		{
			title: "regenerating manifest from staged grammars",
			async task() {
				await rebuildManifestFromStaged(p);
			},
		},
		cargoNdkTask(p, targets),
		assembleAarTask(p),
	]);
}

/**
 * `cargo ndk -t <abi>… -o <jniLibs> build --release -p arborium-rt-android`.
 *
 * We prepend `target/tools/bin` to PATH so a pinned `cargo-ndk` there is picked
 * up as a cargo subcommand (matching the repo's "shell out to pinned CLIs"
 * convention); a system `cargo-ndk` on PATH also works. `ARBORIUM_RT_GRAMMARS`
 * points `lib/native/build.rs` at the staged manifest. `ANDROID_NDK_HOME` must
 * be set in the environment — cargo-ndk errors clearly if it isn't.
 */
function cargoNdkTask(
	p: ReturnType<typeof paths>,
	targets: typeof ANDROID_TARGETS,
): ListrTask {
	return {
		title: "cross-compiling ffi/android per ABI (cargo-ndk)",
		async task(_ctx, task) {
			const jniLibs = join(p.androidPackageDir, "src", "main", "jniLibs");
			const toolsBin = join(p.targetDir, "tools", "bin");
			const abiFlags = targets.flatMap((t) => ["-t", t.abi]);
			task.output = `cargo ndk ${targets.map((t) => t.abi).join(", ")} → ${jniLibs}`;
			await run(
				task.stdout(),
				"cargo",
				[
					"ndk",
					...abiFlags,
					"-o",
					jniLibs,
					"build",
					"--release",
					"-p",
					"arborium-rt-android",
				],
				{
					cwd: p.repoRoot,
					env: {
						ARBORIUM_RT_GRAMMARS: join(p.nativeGrammarsOut, "manifest.json"),
						PATH: `${toolsBin}:${process.env.PATH ?? ""}`,
					},
				},
			);
		},
	};
}

/**
 * Assemble the release AAR from the staged `.so`s via the Android Gradle
 * plugin. Prefers a committed `./gradlew` wrapper, falling back to a system
 * `gradle`. Skipped with a note when neither is available (native-only
 * iteration on a machine without the Android SDK/Gradle) — the `.so`s are
 * already staged into `jniLibs/`, so a later `gradle assembleRelease` picks
 * them up.
 */
function assembleAarTask(p: ReturnType<typeof paths>): ListrTask {
	return {
		title: "assembling AAR (gradle assembleRelease)",
		async task(_ctx, task) {
			const wrapper = join(p.androidPackageDir, "gradlew");
			const useWrapper = existsSync(wrapper);
			const cmd = useWrapper ? wrapper : "gradle";
			await run(task.stdout(), cmd, ["assembleRelease"], {
				cwd: p.androidPackageDir,
			});
		},
		// `enabled` is evaluated up front; if there's no way to run gradle, skip.
		enabled: () =>
			existsSync(join(p.androidPackageDir, "gradlew")) || hasSystemGradle(),
	};
}

function hasSystemGradle(): boolean {
	const paths = (process.env.PATH ?? "").split(":");
	return paths.some((dir) => dir && existsSync(join(dir, "gradle")));
}
