import { Listr } from "listr2";
import { paths, run } from "../../../lib/util.ts";

export function buildWasmRuntime() {
	const p = paths();

	return new Listr([
		{
			title:
				"building arborium-rt-wasm SIDE_MODULE (wasm32-unknown-emscripten)",
			async task(_ctx, task) {
				await run(
					task.stdout(),
					"cargo",
					["build", "--release", "-p", "arborium-rt-wasm"],
					{
						cwd: p.repoRoot,
						env: {
							CARGO_BUILD_TARGET: "wasm32-unknown-emscripten",
							CARGO_UNSTABLE_BUILD_STD: "std,panic_abort",
						},
					},
				);
			},
		},
	]);
}
