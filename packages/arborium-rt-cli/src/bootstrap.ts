// Submodule setup: apply local patches to each submodule's working tree,
// render arborium's Cargo.toml templates, and build the patched tree-sitter
// CLI used by `build-grammar`.
//
// Patches are applied via `git apply` (working-tree only — no commits, no
// committer identity required). Each run resets the submodules to their
// pinned upstream SHAs first, so patches never stack.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Logger, hostTriple, paths, run } from './util.js';

/** Local version string rendered into each `Cargo.toml` from its template. */
const RENDER_VERSION = '0.0.0-arborium-rt';

export async function bootstrap(): Promise<void> {
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
    // `-x` also removes gitignored files — our patches produce some (e.g.,
    // arborium-theme/src/builtin_generated.rs) that the submodule's own
    // .gitignore covers, so a plain `clean -fd` leaves them behind and the
    // next bootstrap's `git apply` fails with "already exists".
    await run(log, 'git', ['-C', p.submoduleRoot, 'clean', '-fdx']);
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

    log.step('writing arborium-theme/src/builtin_generated.rs');
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
 * `arborium-theme` includes `builtin_generated.rs` unconditionally inside
 * `pub mod builtin`. Upstream produces that file with `cargo xtask gen`
 * (which also regenerates crate scaffolding we already handle here). Rather
 * than run xtask, write a thin macro-based equivalent that exposes every
 * bundled theme via `include_str!` + `Theme::from_toml`, gated on the
 * `toml` feature so the emscripten SIDE_MODULE runtime (built with
 * `default-features = false`) still collapses to empty vectors.
 *
 * Exposes one extra helper beyond upstream — `all_with_ids()` returns each
 * `Theme` paired with its TOML filename stem, which is what arborium-rt
 * uses as the stable id in the published `THEMES` map.
 */
function writeArboriumThemeBuiltin(cratesDir: string): void {
    const themesDir = join(cratesDir, 'arborium-theme', 'themes');
    const themeIds = readdirSync(themesDir)
        .filter((name) => name.endsWith('.toml'))
        .map((name) => name.slice(0, -'.toml'.length))
        .sort();

    const entries = themeIds
        .map((id) => `    ${JSON.stringify(id)} => ${id.replaceAll('-', '_')},`)
        .join('\n');

    const content = `// Generated during arborium-rt bootstrap — do not edit.
//
// arborium-theme's src/theme.rs includes this file inside \`pub mod builtin\`.
// Upstream produces it via \`cargo xtask gen\` from the Helix-style TOMLs
// under ../themes/. arborium-rt's bootstrap writes an equivalent here so we
// don't have to run xtask. Each theme is parsed from its embedded TOML on
// first call, gated on the crate's \`toml\` feature; the emscripten runtime
// builds arborium-theme with default features off, so the builtin surface
// collapses to empty vectors and nothing ships in the runtime wasm.
//
// \`all_with_ids()\` pairs each Theme with its filename stem and is an
// arborium-rt addition — upstream's \`all()\` discards the stem.

use super::Theme;

#[cfg(feature = "toml")]
macro_rules! bundled_themes {
    ($($id:literal => $fn_name:ident),+ $(,)?) => {
        $(
            pub fn $fn_name() -> Theme {
                Theme::from_toml(include_str!(concat!("../themes/", $id, ".toml")))
                    .expect(concat!("bundled theme parse failed: ", $id))
            }
        )+

        pub fn all() -> Vec<Theme> {
            vec![$( $fn_name() ),+]
        }

        pub fn all_with_ids() -> Vec<(&'static str, Theme)> {
            vec![$( ($id, $fn_name()) ),+]
        }
    };
}

#[cfg(feature = "toml")]
bundled_themes! {
${entries}
}

#[cfg(not(feature = "toml"))]
pub fn all() -> Vec<Theme> {
    Vec::new()
}

#[cfg(not(feature = "toml"))]
pub fn all_with_ids() -> Vec<(&'static str, Theme)> {
    Vec::new()
}
`;

    writeFileSync(join(cratesDir, 'arborium-theme', 'src', 'builtin_generated.rs'), content);
}
