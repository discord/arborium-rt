// Stage built wasms + rendered themes into the runtime package's dist/ so
// `npm pack` / `npm publish` include them alongside the compiled TypeScript.
//
// This unified command performs two operations:
// 1. Renders every bundled theme to `dist/themes/<id>.css` and regenerates
//    the `src/themes.ts` index module via the host-native theme-codegen binary.
// 2. Copies the runtime wasm + host wasm/mjs into `dist/runtime/` and
//    `dist/host/` respectively.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Logger, paths, run, type Paths } from './util.js';
import { writeThemesIndexModule, type ThemeIndexEntry } from './write-themes-index.js';

interface CodegenEntry {
    readonly themeId: string;
    readonly name: string;
    readonly variant: 'dark' | 'light';
    readonly background: string | null;
    readonly foreground: string | null;
}

export async function stage(): Promise<void> {
    await stageThemes();
    await stageDist();
}

/**
 * Render every bundled theme to `dist/themes/<id>.css` and regenerate the
 * `src/themes.ts` index module. Returns the metadata entries written into
 * the index so callers can log or cross-check counts.
 */
async function stageThemes(): Promise<readonly ThemeIndexEntry[]> {
    const p = paths();
    const log = new Logger('stage-themes');

    const host = await detectHostTriple();
    const binary = await buildCodegen(p, host, log);

    mkdirSync(p.themesOut, { recursive: true });
    log.step(`rendering themes → ${p.themesOut}`);

    const json = await invokeCodegen(binary, p.themesOut);
    const rawEntries = JSON.parse(json) as readonly CodegenEntry[];
    const entries: ThemeIndexEntry[] = rawEntries.map((e) => ({
        themeId: e.themeId,
        name: e.name,
        variant: e.variant,
        ...(e.background !== null ? { background: e.background } : {}),
        ...(e.foreground !== null ? { foreground: e.foreground } : {}),
    }));

    writeThemesIndexModule(entries);
    log.step(`wrote ${entries.length} theme(s) + regenerated src/themes.ts`);
    return entries;
}

async function detectHostTriple(): Promise<string> {
    const output = await captureStdout('rustc', ['-vV']);
    const m = /^host:\s*(\S+)/m.exec(output);
    if (!m) {
        throw new Error(`could not parse host triple from \`rustc -vV\`:\n${output}`);
    }
    return m[1]!;
}

async function buildCodegen(p: Paths, host: string, log: Logger): Promise<string> {
    log.step(`building theme-codegen (target=${host})`);
    await run(log, 'cargo', [
        'build',
        '--release',
        '--manifest-path', join(p.themeCodegenDir, 'Cargo.toml'),
    ], {
        // Override the repo-root .cargo/config.toml which pins emscripten.
        env: { CARGO_BUILD_TARGET: host },
    });
    const binary = join(p.themeCodegenDir, 'target', host, 'release', 'arborium-rt-theme-codegen');
    if (!existsSync(binary)) {
        throw new Error(`expected theme-codegen binary not found at ${binary}`);
    }
    return binary;
}

function captureStdout(cmd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { out += chunk; });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { err += chunk; });
        child.once('error', rejectPromise);
        child.once('close', (code) => {
            if (code === 0) resolvePromise(out);
            else rejectPromise(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${err}`));
        });
    });
}

function invokeCodegen(binary: string, outDir: string): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(binary, [outDir], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { out += chunk; });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { err += chunk; });
        child.once('error', rejectPromise);
        child.once('close', (code) => {
            if (code === 0) resolvePromise(out);
            else rejectPromise(new Error(`theme-codegen exited ${code}\n${err}`));
        });
    });
}

async function stageDist(): Promise<void> {
    const p = paths();
    const log = new Logger('stage-dist');
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
