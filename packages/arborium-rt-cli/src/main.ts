#!/usr/bin/env node
// Unified developer CLI for this repo. The CLI is a private, unpublished
// workspace package; it's invoked directly from source via tsx through the
// `./scripts/arborium-rt` wrapper (or `pnpm cli <subcommand>` at the root).

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bootstrap } from './bootstrap.js';
import { buildAll } from './build-all.js';
import { buildGrammar } from './build-grammar.js';
import { buildHost } from './build-host.js';
import { buildPackage } from './build-package.js';
import { buildGrammarIndex } from './arborium-yaml.js';
import { QUERY_TYPES, flattenAllIntoDir } from './flatten.js';
import { packageAll } from './package-all.js';
import { stage } from './stage.js';
import { Logger, paths } from './util.js';
import { writeGrammarsIndexModule } from './write-grammars-index.js';

const USAGE = `\
arborium-rt <subcommand> [options]

Subcommands:
  bootstrap [--skip-tree-sitter-cli] apply local patches + render submodule Cargo.toml
                                     (and build the patched tree-sitter CLI unless
                                     --skip-tree-sitter-cli is passed; pass it when an
                                     externally-built binary is already on disk, e.g. CI
                                     downloaded the prep-job artifact)
  build-host                         build web-tree-sitter.{wasm,mjs} (MAIN_MODULE)
  build-grammar <group> <lang>       build tree-sitter-<lang>.wasm + flatten queries
  package <group> <lang>             generate dist/grammars/<lang>/ inside the runtime package
  build <group> <lang>               shorthand: build-grammar then package
  build-all [--only a,b,c] [--group group-X] [-j N]
                                     build + package every grammar in the corpus
  package-all [--only a,b,c] [-j N]  regenerate dist/grammars/* from already-built grammars
  flatten-queries <group> <lang>     (re)flatten queries into target/grammars/<lang>/
  list-groups [--json]               print arborium groups with at least one buildable grammar
  stage                              stage built host + runtime wasms into dist/ for publish/testing
  --help, -h                         this help text
  --version                          print the CLI version

Environment:
  ARBORIUM_RT_ROOT                   override the repo-root discovery heuristic

Examples:
  arborium-rt bootstrap
  arborium-rt build-host
  arborium-rt build group-acorn json

Publishing the runtime package is not a CLI subcommand — run
\`pnpm publish\` directly from packages/arborium-rt/ once build-all +
stage have populated its dist/ directory.
`;

async function main(argv: readonly string[]): Promise<number> {
    const [cmd, ...rest] = argv;
    switch (cmd) {
        case 'bootstrap': return cmdBootstrap(rest);
        case 'build-host': await buildHost(); return 0;
        case 'build-grammar': return cmdBuildGrammar(rest);
        case 'package': return cmdBuildPackage(rest);
        case 'build': return cmdBuild(rest);
        case 'build-all': return cmdBuildAll(rest);
        case 'package-all': return cmdPackageAll(rest);
        case 'flatten-queries': return cmdFlatten(rest);
        case 'list-groups': return cmdListGroups(rest);
        case 'stage': await stage(); return 0;
        case '--help':
        case '-h':
        case undefined:
            process.stdout.write(USAGE);
            return 0;
        case '--version':
            process.stdout.write(`${readCliPackageVersion()}\n`);
            return 0;
        default:
            process.stderr.write(`unknown subcommand: ${cmd}\n\n${USAGE}`);
            return 1;
    }
}

async function cmdBootstrap(args: readonly string[]): Promise<number> {
    const { values } = parseArgs({
        args: [...args],
        options: {
            'skip-tree-sitter-cli': { type: 'boolean', default: false },
        },
    });
    await bootstrap({ skipTreeSitterCli: values['skip-tree-sitter-cli'] });
    return 0;
}

async function cmdBuildGrammar(args: readonly string[]): Promise<number> {
    const { positionals } = parseArgs({ args: [...args], allowPositionals: true });
    const [group, lang] = positionals;
    if (!group || !lang) {
        process.stderr.write('usage: arborium-rt build-grammar <group> <lang>\n');
        return 1;
    }
    await buildGrammar({ group, lang });
    return 0;
}

async function cmdBuildPackage(args: readonly string[]): Promise<number> {
    const { positionals } = parseArgs({ args: [...args], allowPositionals: true });
    const [group, lang] = positionals;
    if (!group || !lang) {
        process.stderr.write('usage: arborium-rt package <group> <lang>\n');
        return 1;
    }
    await buildPackage({ group, lang });
    writeGrammarsIndexModule();
    return 0;
}

async function cmdBuild(args: readonly string[]): Promise<number> {
    const rc = await cmdBuildGrammar(args);
    if (rc !== 0) return rc;
    return cmdBuildPackage(args);
}

async function cmdBuildAll(args: readonly string[]): Promise<number> {
    const { values } = parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
            only: { type: 'string' },
            group: { type: 'string' },
            'skip-package': { type: 'boolean', default: false },
            jobs: { type: 'string', short: 'j' },
        },
    });
    const only = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const jobs = parseJobs(values.jobs);
    const result = await buildAll({
        ...(only && only.length > 0 ? { only } : {}),
        ...(values.group ? { group: values.group } : {}),
        skipPackage: values['skip-package'] === true,
        ...(jobs !== undefined ? { jobs } : {}),
    });
    return result.failed.length === 0 ? 0 : 1;
}

async function cmdPackageAll(args: readonly string[]): Promise<number> {
    const { values } = parseArgs({
        args: [...args],
        allowPositionals: false,
        options: {
            only: { type: 'string' },
            jobs: { type: 'string', short: 'j' },
        },
    });
    const only = values.only
        ? values.only.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
    const jobs = parseJobs(values.jobs);
    const result = await packageAll({
        ...(only && only.length > 0 ? { only } : {}),
        ...(jobs !== undefined ? { jobs } : {}),
    });
    return result.failed.length === 0 ? 0 : 1;
}

function parseJobs(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--jobs expects a positive integer, got ${JSON.stringify(raw)}`);
    }
    return n;
}

async function cmdListGroups(args: readonly string[]): Promise<number> {
    const { values } = parseArgs({
        args: [...args],
        allowPositionals: false,
        options: { json: { type: 'boolean', default: false } },
    });
    const p = paths();
    const index = buildGrammarIndex(p.langsRoots);
    const groups = [...new Set([...index.values()].map((e) => e.group))].sort();
    if (values.json) {
        process.stdout.write(`${JSON.stringify(groups)}\n`);
    } else {
        for (const g of groups) process.stdout.write(`${g}\n`);
    }
    return 0;
}

async function cmdFlatten(args: readonly string[]): Promise<number> {
    const { positionals } = parseArgs({ args: [...args], allowPositionals: true });
    const [, lang] = positionals;
    if (!positionals[0] || !lang) {
        process.stderr.write('usage: arborium-rt flatten-queries <group> <lang>\n');
        return 1;
    }
    const p = paths();
    const log = new Logger(lang);
    const outDir = join(p.grammarsOut, lang);
    const index = buildGrammarIndex(p.langsRoots);
    flattenAllIntoDir(lang, index, outDir);
    log.step(`wrote flattened queries to ${outDir} (${QUERY_TYPES.join(', ')})`);
    return 0;
}

/** CLI's own version, shown by `--version`. */
function readCliPackageVersion(): string {
    const pkgPath = join(paths().cliPackageDir, 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
        process.exit(1);
    });
