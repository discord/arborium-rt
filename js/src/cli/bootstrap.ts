// Arborium submodule setup: apply local patches + render Cargo.toml from
// Cargo.stpl.toml templates. Port of `scripts/bootstrap.sh`.
//
// Idempotent: a re-run detects patches that are already present in the
// submodule's history (matched by commit subject) and skips them, so the
// flow works regardless of whether the index's pinned SHA is pre-patch
// (b7a8eb8) or post-patch (6f0927a).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { paths, run, step, warn } from './util.js';

/** Local version string rendered into each `Cargo.toml` from its template. */
const RENDER_VERSION = '0.0.0-arborium-rt';

export async function bootstrap(): Promise<void> {
    const p = paths();

    if (!existsSync(join(p.submoduleRoot, '.git'))) {
        throw new Error(
            `submodule not checked out at ${p.submoduleRoot}; run: git submodule update --init --recursive`,
        );
    }

    // Defensive: if a previous run left a `git am` mid-apply, the next one
    // errors with "previous rebase directory still exists". Clear it before
    // proceeding. `--quit` discards the state without rolling back commits.
    const rebaseApplyDir = join(p.submoduleRoot, '.git', 'rebase-apply');
    if (existsSync(rebaseApplyDir)) {
        warn('found stale rebase-apply state; clearing');
        await run('git', ['-C', p.submoduleRoot, 'am', '--abort'], { quiet: true }).catch(() => {
            // Fall back to manual cleanup if git balks.
            rmSync(rebaseApplyDir, { recursive: true, force: true });
        });
    }

    step('resetting submodule to its pinned commit');
    // `submodule update --init --force` re-reads the pinned SHA from this
    // repo's tree, so re-runs never stack patches on top of prior ones (git
    // am creates commits; without the reset, those would be load-bearing).
    await run('git', [
        '-C', p.repoRoot,
        'submodule', 'update', '--init', '--force', 'third_party/arborium',
    ]);
    await run('git', ['-C', p.submoduleRoot, 'clean', '-fd']);

    const patches = readdirSync(p.patchesDir)
        .filter((name) => name.endsWith('.patch'))
        .sort();
    for (const patch of patches) {
        const patchPath = join(p.patchesDir, patch);
        const subject = extractPatchSubject(patchPath);
        if (subject && commitSubjectInHistory(p.submoduleRoot, subject)) {
            step(`${patch}: already applied, skipping`);
            continue;
        }
        step(`applying ${patch}`);
        // git am consumes mbox-formatted patches on stdin. Leaves working-tree
        // state suitable for Cargo path-dep consumption.
        await run(
            'git',
            ['-C', p.submoduleRoot, 'am', '--keep-cr'],
            { input: readFileSync(patchPath, 'utf8') },
        );
    }

    step(`rendering Cargo.toml from Cargo.stpl.toml (version ${RENDER_VERSION})`);
    const cratesDir = join(p.submoduleRoot, 'crates');
    for (const crate of readdirSync(cratesDir)) {
        const stpl = join(cratesDir, crate, 'Cargo.stpl.toml');
        if (!existsSync(stpl)) continue;
        const template = readFileSync(stpl, 'utf8');
        const rendered = template.replaceAll('<%= version %>', RENDER_VERSION);
        writeFileSync(join(cratesDir, crate, 'Cargo.toml'), rendered);
    }

    step('bootstrap complete. patched submodule HEAD:');
    await run('git', ['-C', p.submoduleRoot, 'log', '--oneline', '-3']);
}

/** Extract the `Subject:` line from an mbox-formatted patch. */
function extractPatchSubject(patchPath: string): string | undefined {
    const text = readFileSync(patchPath, 'utf8');
    // mbox patches have `Subject: [PATCH] <subject>` (or `Subject: <subject>`
    // continued across multiple lines). Grab the first one; strip [PATCH] tag.
    const match = /^Subject:\s*(?:\[PATCH[^\]]*\]\s*)?(.*?)$/m.exec(text);
    if (!match) return undefined;
    // Continuation lines are indented with whitespace and folded together.
    const lines = text.split('\n');
    const startIdx = lines.findIndex((l) => l.startsWith('Subject:'));
    let subject = match[1]?.trim() ?? '';
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.startsWith(' ') && !line.startsWith('\t')) break;
        subject += ' ' + line.trim();
    }
    return subject;
}

/** Return true if any commit in the submodule's history has this subject. */
function commitSubjectInHistory(cwd: string, subject: string): boolean {
    try {
        const out = execFileSync('git', ['-C', cwd, 'log', '--format=%s', '-50'], {
            encoding: 'utf8',
        });
        return out.split('\n').some((line) => line.trim() === subject.trim());
    } catch {
        return false;
    }
}
