// Shared CLI helpers: repo-root discovery, child-process execution, logging.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
    readonly patchesDir: string;
    readonly targetDir: string;
    readonly grammarsOut: string;
    readonly packagesOut: string;
    readonly hostWasmOut: string;
    readonly runtimeWasm: string;
    readonly jsDir: string;
    readonly bindingRoot: string;
}

export function paths(repoRoot: string = findRepoRoot()): Paths {
    return {
        repoRoot,
        submoduleRoot: join(repoRoot, 'third_party', 'arborium'),
        langsRoot: join(repoRoot, 'third_party', 'arborium', 'langs'),
        bindingRoot: join(repoRoot, 'third_party', 'arborium', 'crates', 'arborium-tree-sitter'),
        patchesDir: join(repoRoot, 'patches'),
        targetDir: join(repoRoot, 'target'),
        grammarsOut: join(repoRoot, 'target', 'grammars'),
        packagesOut: join(repoRoot, 'target', 'packages'),
        hostWasmOut: join(repoRoot, 'target', 'host-wasm'),
        runtimeWasm: join(
            repoRoot,
            'target',
            'wasm32-unknown-emscripten',
            'release',
            'arborium_emscripten_runtime.wasm',
        ),
        jsDir: join(repoRoot, 'js'),
    };
}

export interface RunOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Pipe a string as stdin. Useful for `git am <patch`. */
    input?: string;
    /** Suppress stdout/stderr forwarding to this process. Defaults to false. */
    quiet?: boolean;
}

/**
 * Run a command, streaming its stdio to ours by default. Rejects on non-zero
 * exit; the Error message includes the command for grep-ability.
 */
export async function run(
    cmd: string,
    args: readonly string[],
    options: RunOptions = {},
): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(cmd, args as string[], {
            cwd: options.cwd,
            env: options.env ? { ...process.env, ...options.env } : process.env,
            stdio: options.input !== undefined
                ? ['pipe', options.quiet ? 'ignore' : 'inherit', options.quiet ? 'ignore' : 'inherit']
                : options.quiet ? 'ignore' : 'inherit',
        });
        if (options.input !== undefined) {
            child.stdin?.end(options.input);
        }
        child.once('error', rejectPromise);
        child.once('close', (code) => {
            if (code === 0) resolvePromise();
            else rejectPromise(
                new Error(`${cmd} ${args.join(' ')} exited with code ${code}`),
            );
        });
    });
}

/** Equivalent of `command -v` — returns true if the tool is on PATH. */
export async function hasCommand(cmd: string): Promise<boolean> {
    try {
        await run('which', [cmd], { quiet: true });
        return true;
    } catch {
        return false;
    }
}

/** Print a "==> step" heading to stderr, matching the old shell scripts' style. */
export function step(message: string): void {
    console.error(`==> ${message}`);
}

/** Print a non-fatal warning. */
export function warn(message: string): void {
    console.error(`warn: ${message}`);
}
