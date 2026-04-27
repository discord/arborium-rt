// Stage built wasms into the runtime package's dist/ so `npm pack` /
// `npm publish` include them alongside the compiled TypeScript. Copies the
// runtime wasm + host wasm/mjs into `dist/runtime/` and `dist/host/`
// respectively.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Logger, paths } from './util.js';

export async function stage(): Promise<void> {
    const p = paths();
    const log = new Logger('stage');
    const hostSrcDir = p.hostWasmOut;
    const hostWasm = join(hostSrcDir, 'web-tree-sitter.wasm');
    const hostMjs = join(hostSrcDir, 'web-tree-sitter.mjs');

    if (!existsSync(hostWasm) || !existsSync(hostMjs)) {
        throw new Error(
            `host wasm not found in ${hostSrcDir}. run \`arborium-rt build-host\` first.`,
        );
    }
    if (!existsSync(p.runtimeWasm)) {
        throw new Error(
            `runtime wasm not found at ${p.runtimeWasm}. run \`cargo build --release\` first.`,
        );
    }

    const distDir = join(p.runtimePackageDir, 'dist');
    const hostDest = join(distDir, 'host');
    const runtimeDest = join(distDir, 'runtime');
    mkdirSync(hostDest, { recursive: true });
    mkdirSync(runtimeDest, { recursive: true });

    // Only ship the artifacts we distribute; leave .map files behind to keep
    // the tarball tight. Consumers that want source maps can regenerate from
    // the built runtime.
    copyFileSync(hostWasm, join(hostDest, 'web-tree-sitter.wasm'));
    copyFileSync(hostMjs, join(hostDest, 'web-tree-sitter.mjs'));
    copyFileSync(p.runtimeWasm, join(runtimeDest, 'arborium_emscripten_runtime.wasm'));

    log.step('staged assets:');
    for (const file of [
        join(hostDest, 'web-tree-sitter.wasm'),
        join(hostDest, 'web-tree-sitter.mjs'),
        join(runtimeDest, 'arborium_emscripten_runtime.wasm'),
    ]) {
        const size = statSync(file).size;
        log.info(`    ${size.toString().padStart(10)}  ${relative(p.repoRoot, file)}`);
    }
}
