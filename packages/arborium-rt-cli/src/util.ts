// Shared CLI helpers: repo-root discovery, child-process execution, logging.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Tagged logger. Every line written through a logger (including lines
 * emitted by child processes started via `run(logger, ...)`) is prefixed
 * with `[<prefix>] ` so parallel builds stay readable on a shared stderr.
 */
export class Logger {
    constructor(readonly prefix: string) {}

    /** Structured "==>" progress line. */
    step(msg: string): void {
        process.stderr.write(`[${this.prefix}] ==> ${msg}\n`);
    }

    /** Non-fatal warning. */
    warn(msg: string): void {
        process.stderr.write(`[${this.prefix}] warn: ${msg}\n`);
    }

    /** Plain tagged line — no step/warn decoration. */
    info(msg: string): void {
        process.stderr.write(`[${this.prefix}] ${msg}\n`);
    }
}

/**
 * Walk up from `start` until a directory contains a marker file identifying
 * the arborium-rt repo (the root Cargo.toml with the crate name). Falls back
 * to `$ARBORIUM_RT_ROOT` if set.
 *
 * The marker approach avoids fragile `import.meta.url`-based path math that
 * breaks when the CLI is installed as a published npm dep outside the repo.
 */
export function findRepoRoot(start: string = process.cwd()): string {
    if (process.env['ARBORIUM_RT_ROOT']) return process.env['ARBORIUM_RT_ROOT'];
    let dir = resolve(start);
    while (true) {
        const cargo = join(dir, 'Cargo.toml');
        if (existsSync(cargo)) {
            const content = readFileSync(cargo, 'utf8');
            if (content.includes('arborium-emscripten-runtime')) return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error(
                `not inside an arborium-rt checkout (no Cargo.toml declaring arborium-emscripten-runtime in ${start} or any ancestor)`,
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
     * Directory where per-grammar subdirs (index.js / index.d.ts / wasm /
     * .scm) are emitted. Lives inside the runtime package's `dist/` so the
     * subpath exports (`@discord/arborium-rt/grammars/<lang>`) resolve
     * to a sibling of the compiled TS.
     */
    readonly packagesOut: string;
    readonly hostWasmOut: string;
    readonly runtimeWasm: string;
    /** `packages/arborium-rt/` — the runtime library package. */
    readonly runtimePackageDir: string;
    /** `packages/arborium-rt-cli/` — this CLI's own package. */
    readonly cliPackageDir: string;
    readonly bindingRoot: string;
    /**
     * Output dir for per-theme `.css` files staged into the runtime package's
     * `dist/themes/`. Referenced by the generated `dist/themes.js` via
     * `new URL('./themes/<id>.css', import.meta.url)`.
     */
    readonly themesOut: string;
    /** `crates/theme-codegen/` — host-native binary that emits theme CSS. */
    readonly themeCodegenDir: string;
}

export function paths(repoRoot: string = findRepoRoot()): Paths {
    const treeSitterRoot = join(repoRoot, 'third_party', 'tree-sitter');
    return {
        repoRoot,
        submoduleRoot: join(repoRoot, 'third_party', 'arborium'),
        langsRoot: join(repoRoot, 'third_party', 'arborium', 'langs'),
        bindingRoot: join(repoRoot, 'third_party', 'arborium', 'crates', 'arborium-tree-sitter'),
        arboriumPatchesDir: join(repoRoot, 'patches', 'arborium'),
        treeSitterRoot,
        treeSitterPatchesDir: join(repoRoot, 'patches', 'tree-sitter'),
        treeSitterBin: join(treeSitterRoot, 'target', hostTriple(), 'release', 'tree-sitter'),
        targetDir: join(repoRoot, 'target'),
        grammarsOut: join(repoRoot, 'target', 'grammars'),
        packagesOut: join(repoRoot, 'packages', 'arborium-rt', 'dist', 'grammars'),
        hostWasmOut: join(repoRoot, 'target', 'host-wasm'),
        runtimeWasm: join(
            repoRoot,
            'target',
            'wasm32-unknown-emscripten',
            'release',
            'arborium_emscripten_runtime.wasm',
        ),
        runtimePackageDir: join(repoRoot, 'packages', 'arborium-rt'),
        cliPackageDir: join(repoRoot, 'packages', 'arborium-rt-cli'),
        themesOut: join(repoRoot, 'packages', 'arborium-rt', 'dist', 'themes'),
        themeCodegenDir: join(repoRoot, 'crates', 'theme-codegen'),
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
    if (process.env['ARBORIUM_RT_HOST_TRIPLE']) return process.env['ARBORIUM_RT_HOST_TRIPLE'];
    const arch = process.arch === 'x64' ? 'x86_64'
        : process.arch === 'arm64' ? 'aarch64'
        : process.arch;
    if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`;
    if (process.platform === 'darwin') return `${arch}-apple-darwin`;
    throw new Error(`unsupported host platform ${process.platform}/${process.arch}; set ARBORIUM_RT_HOST_TRIPLE`);
}

export interface RunOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Pipe a string as stdin. Useful for `git am <patch`. */
    input?: string;
}

/**
 * Run a command with its stdout/stderr line-buffered and tagged with the
 * logger's prefix before being forwarded to our stderr. Rejects on non-zero
 * exit; the Error message includes the command for grep-ability.
 *
 * Always pipes — callers that don't care about output should use
 * `runSilent` instead.
 */
export async function run(
    logger: Logger,
    cmd: string,
    args: readonly string[],
    options: RunOptions = {},
): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const wantsInput = options.input !== undefined;
        const child = spawn(cmd, args as string[], {
            cwd: options.cwd,
            env: options.env ? { ...process.env, ...options.env } : process.env,
            stdio: [wantsInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
        if (wantsInput) {
            child.stdin?.end(options.input);
        }
        const tag = `[${logger.prefix}] `;
        pipePrefixed(child.stdout, tag);
        pipePrefixed(child.stderr, tag);
        child.once('error', rejectPromise);
        child.once('close', (code) => {
            if (code === 0) resolvePromise();
            else rejectPromise(
                new Error(`${cmd} ${args.join(' ')} exited with code ${code}`),
            );
        });
    });
}

/**
 * Line-buffer a piped child stream and write each line to our stderr with a
 * tag prefix. Any trailing non-newline-terminated output is flushed on `end`.
 */
function pipePrefixed(stream: NodeJS.ReadableStream | null, tag: string): void {
    if (!stream) return;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) !== -1) {
            process.stderr.write(`${tag}${buf.slice(0, i)}\n`);
            buf = buf.slice(i + 1);
        }
    });
    stream.on('end', () => {
        if (buf.length > 0) process.stderr.write(`${tag}${buf}\n`);
    });
}

/** Equivalent of `command -v` — returns true if the tool is on PATH. */
export async function hasCommand(cmd: string): Promise<boolean> {
    return await new Promise<boolean>((resolvePromise) => {
        const child = spawn('which', [cmd], { stdio: 'ignore' });
        child.once('error', () => resolvePromise(false));
        child.once('close', (code) => resolvePromise(code === 0));
    });
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight. Items start in
 * order but may complete out of order. An exception in one item does not
 * abort the pool; callers are responsible for catching and collecting
 * per-item results inside `fn`.
 */
export async function runPool<T>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    const n = Math.min(Math.max(1, concurrency), items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: n }, async () => {
            while (true) {
                const i = next++;
                if (i >= items.length) return;
                await fn(items[i]!, i);
            }
        }),
    );
}
