// Submodule setup: apply local patches to each submodule's working tree,
// render arborium's Cargo.toml templates, write a stub
// `arborium-theme/src/builtin_generated.rs` (the upstream build pipeline
// requires the file to exist for `theme.rs`'s `include!`), and build the
// patched tree-sitter CLI used by `build-grammar`.
//
// Patches are applied via `git apply` (working-tree only — no commits, no
// committer identity required). Each run resets the submodules to their
// pinned upstream SHAs first, so patches never stack.
//
// The patched-tree-sitter-CLI build (~30 s in a cold cargo cache) is the
// only expensive step. CI's per-group `grammars` matrix calls
// `bootstrap --skip-tree-sitter-cli` so each shard reuses the CLI
// artifact uploaded by `prep` instead of rebuilding it N times. The
// rest of bootstrap is sub-second.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Logger, hostTriple, paths, run } from './util.js';

/** Local version string rendered into each `Cargo.toml` from its template. */
const RENDER_VERSION = '0.0.0-arborium-rt';

export interface BootstrapOptions {
    /**
     * Skip the cargo build of the patched tree-sitter CLI. Patches still
     * get applied to `third_party/tree-sitter/`. Use when an externally
     * provided binary already lives at `paths().treeSitterBin` (e.g. CI
     * downloads the artifact uploaded by an earlier job).
     */
    skipTreeSitterCli?: boolean;
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
    const p = paths();
    const log = new Logger('bootstrap');

    if (!existsSync(join(p.submoduleRoot, '.git'))) {
        throw new Error(
            `arborium submodule not checked out at ${p.submoduleRoot}; run: git submodule update --init --recursive`,
        );
    }
    if (!existsSync(join(p.treeSitterRoot, '.git'))) {
        throw new Error(
            `tree-sitter submodule not checked out at ${p.treeSitterRoot}; run: git submodule update --init --recursive`,
        );
    }

    // --- arborium submodule ---------------------------------------------------
    log.step('resetting arborium submodule to its pinned commit');
    await run(log, 'git', [
        '-C', p.repoRoot,
        'submodule', 'update', '--init', '--force', 'third_party/arborium',
    ]);
    await run(log, 'git', ['-C', p.submoduleRoot, 'clean', '-fd']);
    await applyPatches(log, p.submoduleRoot, p.arboriumPatchesDir);

    log.step(`rendering Cargo.toml from Cargo.stpl.toml (version ${RENDER_VERSION})`);
    const cratesDir = join(p.submoduleRoot, 'crates');
    for (const crate of readdirSync(cratesDir)) {
        const stpl = join(cratesDir, crate, 'Cargo.stpl.toml');
        if (!existsSync(stpl)) continue;
        const template = readFileSync(stpl, 'utf8');
        const rendered = template.replaceAll('<%= version %>', RENDER_VERSION);
        writeFileSync(join(cratesDir, crate, 'Cargo.toml'), rendered);
    }

    log.step('writing arborium-theme/src/builtin_generated.rs stub');
    writeArboriumThemeBuiltin(cratesDir);

    // --- tree-sitter submodule + CLI build ------------------------------------
    log.step('resetting tree-sitter submodule to its pinned commit');
    await run(log, 'git', [
        '-C', p.repoRoot,
        'submodule', 'update', '--init', '--force', 'third_party/tree-sitter',
    ]);
    // Don't `-x`: tree-sitter's gitignored target/ holds incremental build
    // state we want to keep across bootstraps. Patches only touch tracked
    // files, so `clean -fd` is enough to undo a prior patch.
    await run(log, 'git', ['-C', p.treeSitterRoot, 'clean', '-fd']);
    await applyPatches(log, p.treeSitterRoot, p.treeSitterPatchesDir);

    if (options.skipTreeSitterCli) {
        log.step(`skipping patched tree-sitter CLI build (--skip-tree-sitter-cli)`);
    } else {
        log.step(`building patched tree-sitter CLI -> ${p.treeSitterBin}`);
        // The repo root's `.cargo/config.toml` pins target=wasm32-unknown-emscripten
        // for the runtime crate; we need the host triple here, so override
        // CARGO_BUILD_TARGET. Same hostTriple() helper that paths() uses, so the
        // produced binary lands exactly where p.treeSitterBin expects.
        await run(log, 'cargo', [
            'build', '--release', '-p', 'tree-sitter-cli', '--bin', 'tree-sitter',
        ], {
            cwd: p.treeSitterRoot,
            env: { CARGO_BUILD_TARGET: hostTriple() },
        });
        if (!existsSync(p.treeSitterBin)) {
            throw new Error(
                `expected tree-sitter binary at ${p.treeSitterBin} after build; cargo placed it elsewhere`,
            );
        }
    }

    log.step('bootstrap complete.');
}

/**
 * Apply every `*.patch` file in `patchesDir` (sorted by name) to the working
 * tree of `submoduleRoot`. Patches are mbox-format `git format-patch` output;
 * `git apply` tolerates the preamble and reads the unified diff body, so no
 * committer identity is needed and nothing gets committed in the submodule.
 */
async function applyPatches(
    log: Logger,
    submoduleRoot: string,
    patchesDir: string,
): Promise<void> {
    if (!existsSync(patchesDir)) return;
    const patches = readdirSync(patchesDir)
        .filter((name) => name.endsWith('.patch'))
        .sort();
    const dirLabel = basename(patchesDir);
    for (const patch of patches) {
        log.step(`applying ${dirLabel}/${patch}`);
        await run(log, 'git', [
            '-C', submoduleRoot,
            'apply', '--whitespace=nowarn',
            join(patchesDir, patch),
        ]);
    }
}

/**
 * `arborium-theme/src/theme.rs` includes `builtin_generated.rs` inside
 * `pub mod builtin` via a bare `include!`, so the file must exist or the
 * crate fails to compile. Upstream produces it with `cargo xtask gen` from
 * the Helix-style TOMLs under `../themes/`. arborium-rt does not bundle
 * any themes, so we write an empty stub: `pub mod builtin` exposes a
 * no-op `all()` returning `Vec::new()`. The runtime only consumes
 * `tag_for_capture` from arborium-theme; nothing depends on `builtin::*`.
 */
function writeArboriumThemeBuiltin(cratesDir: string): void {
    const content = `// Generated during arborium-rt bootstrap — do not edit.
//
// arborium-theme's src/theme.rs includes this file inside \`pub mod builtin\`.
// arborium-rt does not bundle themes, so this is an empty stub.

use super::Theme;

pub fn all() -> Vec<Theme> {
    Vec::new()
}
`;

    writeFileSync(join(cratesDir, 'arborium-theme', 'src', 'builtin_generated.rs'), content);
}
