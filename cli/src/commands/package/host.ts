// The `package host` command: stage the built host + runtime wasms into the
// runtime package's dist/ so `npm pack` / `npm publish` include them alongside
// the compiled TypeScript. Copies the runtime wasm + host wasm/mjs into
// `dist/runtime/` and `dist/host/` respectively. Source maps are left behind
// to keep the tarball tight.

import { copyFile, mkdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Listr } from "listr2";
import { paths } from "../../lib/util.ts";

const exists = (file: string): Promise<boolean> =>
	stat(file).then(
		() => true,
		() => false,
	);

export function packageHost() {
	return new Listr([
		{
			title: "staging host + runtime wasms into dist/",
			async task(_ctx, task) {
				const p = paths();
				const hostSrcDir = p.hostWasmOut;
				const hostWasm = join(hostSrcDir, "web-tree-sitter.wasm");
				const hostMjs = join(hostSrcDir, "web-tree-sitter.mjs");

				if (!(await exists(hostWasm)) || !(await exists(hostMjs))) {
					throw new Error(
						`host wasm not found in ${hostSrcDir}. run \`arborium-rt build-host\` first.`,
					);
				}
				if (!(await exists(p.runtimeWasm))) {
					throw new Error(
						`runtime wasm not found at ${p.runtimeWasm}. run \`arborium-rt build-wasm\` first.`,
					);
				}

				const distDir = join(p.runtimePackageDir, "dist");
				const hostDest = join(distDir, "host");
				const runtimeDest = join(distDir, "runtime");
				await mkdir(hostDest, { recursive: true });
				await mkdir(runtimeDest, { recursive: true });

				const staged: string[] = [
					join(hostDest, "web-tree-sitter.wasm"),
					join(hostDest, "web-tree-sitter.mjs"),
					join(runtimeDest, "arborium_emscripten_runtime.wasm"),
				];
				await copyFile(hostWasm, staged[0]!);
				await copyFile(hostMjs, staged[1]!);
				await copyFile(p.runtimeWasm, staged[2]!);

				const lines = await Promise.all(
					staged.map(async (file) => {
						const { size } = await stat(file);
						return `${size.toString().padStart(10)}  ${relative(p.repoRoot, file)}`;
					}),
				);
				task.output = `staged assets:\n${lines.join("\n")}`;
			},
		},
	]);
}
