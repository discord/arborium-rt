// Publish the runtime + CLI + every built grammar package to a registry.
//
// Runtime goes first so the grammars' peerDependency constraint
// (`@appellation/arborium-rt: ^<version>`) is satisfiable the moment a
// grammar tarball is installed. The CLI package is independent — it can
// publish in any order.
//
// Auth is NOT handled here — rely on the user's `.npmrc` (or
// `NODE_AUTH_TOKEN` env for GitHub Actions). For GitHub Packages, the
// standard form is:
//
//     //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
//
// in either ~/.npmrc or the repo-local .npmrc.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { paths, run, step, warn } from './util.js';

export interface PublishArgs {
    /** If set, skip the runtime package (@appellation/arborium-rt). */
    skipRuntime?: boolean;
    /** If set, skip the CLI package (@appellation/arborium-rt-cli). */
    skipCli?: boolean;
    /** If set, skip all grammar packages (target/packages/*). */
    skipGrammars?: boolean;
    /** If set, only publish grammars matching these ids. */
    only?: string[];
    /**
     * Registry URL. If omitted, each package.json's `publishConfig.registry`
     * wins — which is the preferred path, since it's repo-committed.
     */
    registry?: string;
    /** npm dist-tag (default `latest`). */
    tag?: string;
    /** Don't actually publish — run `pnpm publish --dry-run`. */
    dryRun?: boolean;
    /**
     * Access level (`public` / `restricted`). GitHub Packages honors the
     * repo's visibility and ignores this; npmjs requires `public` on first
     * publish of a scoped package. Defaults to unset.
     */
    access?: 'public' | 'restricted';
}

export interface PublishResult {
    readonly ok: string[];
    readonly failed: Array<{ id: string; reason: string }>;
    readonly skipped: string[];
}

interface PublishJob {
    readonly id: string;
    readonly dir: string;
    readonly packageName: string;
}

export async function publishAll(args: PublishArgs = {}): Promise<PublishResult> {
    const p = paths();
    const ok: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    const skipped: string[] = [];
    const jobs: PublishJob[] = [];

    if (!args.skipRuntime) {
        const runtimePkgJson = join(p.runtimePackageDir, 'package.json');
        if (!existsSync(runtimePkgJson)) {
            throw new Error(`runtime package.json not found at ${runtimePkgJson}`);
        }
        const runtimeDist = join(p.runtimePackageDir, 'dist');
        if (!existsSync(runtimeDist)) {
            throw new Error(
                `runtime not built: ${runtimeDist} missing. run \`pnpm --filter @appellation/arborium-rt build\` first.`,
            );
        }
        for (const asset of [
            join(runtimeDist, 'host', 'web-tree-sitter.wasm'),
            join(runtimeDist, 'host', 'web-tree-sitter.mjs'),
            join(runtimeDist, 'runtime', 'arborium_emscripten_runtime.wasm'),
        ]) {
            if (!existsSync(asset)) {
                throw new Error(
                    `runtime asset missing: ${asset}. run \`arborium-rt stage-dist\` first.`,
                );
            }
        }
        jobs.push({
            id: '<runtime>',
            dir: p.runtimePackageDir,
            packageName: readPackageName(runtimePkgJson),
        });
    }

    if (!args.skipCli) {
        const cliPkgJson = join(p.cliPackageDir, 'package.json');
        if (!existsSync(cliPkgJson)) {
            throw new Error(`CLI package.json not found at ${cliPkgJson}`);
        }
        const cliMain = join(p.cliPackageDir, 'dist', 'main.js');
        if (!existsSync(cliMain)) {
            throw new Error(
                `CLI not built: ${cliMain} missing. run \`pnpm --filter @appellation/arborium-rt-cli build\` first.`,
            );
        }
        jobs.push({
            id: '<cli>',
            dir: p.cliPackageDir,
            packageName: readPackageName(cliPkgJson),
        });
    }

    if (!args.skipGrammars) {
        if (!existsSync(p.packagesOut)) {
            warn(
                `no grammar packages at ${p.packagesOut} — skipping grammars. run \`arborium-rt build-all\` first.`,
            );
        } else {
            const allGrammarIds = readdirSync(p.packagesOut)
                .filter((name) => statSync(join(p.packagesOut, name)).isDirectory())
                .sort();
            const wanted = (args.only && args.only.length > 0)
                ? new Set(args.only)
                : undefined;
            for (const id of allGrammarIds) {
                if (wanted && !wanted.has(id)) {
                    skipped.push(id);
                    continue;
                }
                const dir = join(p.packagesOut, id);
                const pkgJson = join(dir, 'package.json');
                if (!existsSync(pkgJson)) {
                    failed.push({ id, reason: `${pkgJson} not found` });
                    continue;
                }
                jobs.push({ id, dir, packageName: readPackageName(pkgJson) });
            }
            if (wanted) {
                const missing = [...wanted].filter(
                    (id) => !jobs.some((j) => j.id === id),
                );
                for (const id of missing) {
                    failed.push({ id, reason: 'not found in target/packages/' });
                }
            }
        }
    }

    step(
        `publishing ${jobs.length} package(s)${args.dryRun ? ' (dry-run)' : ''}` +
            (args.registry ? ` to ${args.registry}` : ''),
    );

    for (const [i, job] of jobs.entries()) {
        const progress = `[${i + 1}/${jobs.length}]`;
        process.stderr.write(
            `\n===== ${progress} ${job.packageName} (${relative(p.repoRoot, job.dir) || '.'}) =====\n`,
        );
        try {
            // Refuse to publish without a publishConfig.registry so a stale
            // package.json can't silently leak to the public npmjs registry.
            assertPublishConfig(job.dir);
            await pnpmPublish(job.dir, args);
            ok.push(job.id);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            failed.push({ id: job.id, reason });
            process.stderr.write(`FAIL ${job.id}: ${reason}\n`);
        }
    }

    process.stderr.write(`\n===== summary =====\n`);
    process.stderr.write(`ok:      ${ok.length}/${jobs.length}\n`);
    process.stderr.write(`failed:  ${failed.length}/${jobs.length}\n`);
    if (skipped.length > 0) {
        process.stderr.write(`skipped: ${skipped.length} (not matched by --only)\n`);
    }
    if (failed.length > 0) {
        process.stderr.write(`\nfailures:\n`);
        for (const { id, reason } of failed) {
            process.stderr.write(`  ${id}: ${reason.split('\n')[0]}\n`);
        }
    }

    return { ok, failed, skipped };
}

async function pnpmPublish(dir: string, args: PublishArgs): Promise<void> {
    const cliArgs: string[] = ['publish'];
    if (args.registry) cliArgs.push('--registry', args.registry);
    if (args.tag) cliArgs.push('--tag', args.tag);
    if (args.access) cliArgs.push('--access', args.access);
    if (args.dryRun) cliArgs.push('--dry-run');
    // pnpm refuses to publish with uncommitted changes by default; the caller
    // controls when a release is ready, so opt out of that guard.
    cliArgs.push('--no-git-checks');
    await run('pnpm', cliArgs, { cwd: dir });
}

function readPackageName(pkgJsonPath: string): string {
    const raw = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
    if (!raw.name) throw new Error(`${pkgJsonPath} has no "name" field`);
    return raw.name;
}

/**
 * Refuse to publish a package that lacks `publishConfig.registry`. Without
 * it, `pnpm publish` falls back to the consumer's ambient registry — usually
 * the public npmjs registry — which would leak a private package. If this
 * fires, the package was generated before build-package.ts learned to emit
 * publishConfig; run `arborium-rt package-all` to regenerate it.
 */
function assertPublishConfig(dir: string): void {
    const pkgJsonPath = join(dir, 'package.json');
    const raw = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    const config = raw['publishConfig'];
    const registry = (typeof config === 'object' && config !== null)
        ? (config as Record<string, unknown>)['registry']
        : undefined;
    if (typeof registry !== 'string' || registry.length === 0) {
        throw new Error(
            `${pkgJsonPath} has no publishConfig.registry — regenerate with \`arborium-rt package-all\``,
        );
    }
}
