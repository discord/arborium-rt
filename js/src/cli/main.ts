#!/usr/bin/env node
// Unified developer CLI for this repo. Invoked via `npm run cli -- <subcommand>`
// during dev, or `arborium-rt <subcommand>` once the package is installed.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrap } from './bootstrap.js';
import { buildAll } from './build-all.js';
import { buildGrammar } from './build-grammar.js';
import { buildHost } from './build-host.js';
import { buildPackage } from './build-package.js';
import { buildGrammarIndex } from './arborium-yaml.js';
import { QUERY_TYPES, flattenAllIntoDir } from './flatten.js';
import { packageAll } from './package-all.js';
import { publishAll } from './publish.js';
import { stageDist } from './stage-dist.js';
import { paths, step } from './util.js';

const USAGE = `\
arborium-rt <subcommand> [options]

Subcommands:
  bootstrap                          apply local patches + render submodule Cargo.toml
  build-host                         build web-tree-sitter.{wasm,mjs} (MAIN_MODULE)
  build-grammar <group> <lang>       build tree-sitter-<lang>.wasm + flatten queries
  package <group> <lang>             generate @appellation/arborium-rt-<lang> npm package
  build <group> <lang>               shorthand: build-grammar then package
  build-all [--only a,b,c]           build + package every grammar in the corpus
  package-all [--only a,b,c]         regenerate target/packages/* from already-built grammars
  flatten-queries <group> <lang>     (re)flatten queries into target/grammars/<lang>/
  stage-dist                         stage built wasms into js/dist/ for publish
  publish [options]                  npm publish the runtime + every built grammar
  --help, -h                         this help text
  --version                          print the CLI version

Environment:
  ARBORIUM_RT_ROOT                   override the repo-root discovery heuristic

Examples:
  arborium-rt bootstrap
  arborium-rt build-host
  arborium-rt build group-acorn json
  arborium-rt publish --dry-run
  arborium-rt publish --skip-runtime --only json,css

Publish flags:
  --dry-run                          run \`npm publish --dry-run\` only
  --skip-runtime                     don't publish @appellation/arborium-rt
  --skip-grammars                    don't publish any @appellation/arborium-rt-<lang>
  --only a,b,c                       restrict grammars to this list
  --registry <url>                   override npm registry (default: honors
                                     each package.json's publishConfig.registry,
                                     which points at https://npm.pkg.github.com)
  --tag <name>                       npm dist-tag (default "latest")
  --access public|restricted         pass through to \`npm publish --access\`
`;

async function main(argv: readonly string[]): Promise<number> {
    const [cmd, ...rest] = argv;
    switch (cmd) {
        case 'bootstrap':        await bootstrap(); return 0;
        case 'build-host':       await buildHost(); return 0;
        case 'build-grammar':    return cmdBuildGrammar(rest);
        case 'package':          return cmdBuildPackage(rest);
        case 'build':            return cmdBuild(rest);
        case 'build-all':        return cmdBuildAll(rest);
        case 'package-all':      return cmdPackageAll(rest);
        case 'flatten-queries':  return cmdFlatten(rest);
        case 'stage-dist':       await stageDist(); return 0;
        case 'publish':          return cmdPublish(rest);
        case '--help':
        case '-h':
        case undefined:
            process.stdout.write(USAGE);
            return 0;
        case '--version':
            process.stdout.write(`${readPackageVersion()}\n`);
            return 0;
        default:
            process.stderr.write(`unknown subcommand: ${cmd}\n\n${USAGE}`);
            return 1;
    }
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
    const { positionals, values } = parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
            version: { type: 'string', default: readPackageVersion() },
        },
    });
    const [group, lang] = positionals;
    if (!group || !lang) {
        process.stderr.write('usage: arborium-rt package <group> <lang> [--version X.Y.Z]\n');
        return 1;
    }
    await buildPackage({ group, lang, version: values.version ?? readPackageVersion() });
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
            version: { type: 'string', default: readPackageVersion() },
            'skip-package': { type: 'boolean', default: false },
        },
    });
    const only = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const result = await buildAll({
        version: values.version ?? readPackageVersion(),
        ...(only && only.length > 0 ? { only } : {}),
        skipPackage: values['skip-package'] === true,
    });
    return result.failed.length === 0 ? 0 : 1;
}

async function cmdPackageAll(args: readonly string[]): Promise<number> {
    const { values } = parseArgs({
        args: [...args],
        allowPositionals: false,
        options: {
            only:    { type: 'string' },
            version: { type: 'string', default: readPackageVersion() },
        },
    });
    const only = values.only
        ? values.only.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
    const result = await packageAll({
        version: values.version ?? readPackageVersion(),
        ...(only && only.length > 0 ? { only } : {}),
    });
    return result.failed.length === 0 ? 0 : 1;
}

async function cmdPublish(args: readonly string[]): Promise<number> {
    const { values } = parseArgs({
        args: [...args],
        allowPositionals: false,
        options: {
            'dry-run':       { type: 'boolean', default: false },
            'skip-runtime':  { type: 'boolean', default: false },
            'skip-grammars': { type: 'boolean', default: false },
            only:            { type: 'string' },
            registry:        { type: 'string' },
            tag:             { type: 'string' },
            access:          { type: 'string' },
        },
    });
    const only = values.only
        ? values.only.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
    const access = values.access as 'public' | 'restricted' | undefined;
    if (access !== undefined && access !== 'public' && access !== 'restricted') {
        process.stderr.write(`--access must be "public" or "restricted"\n`);
        return 1;
    }
    const result = await publishAll({
        dryRun: values['dry-run'] === true,
        skipRuntime: values['skip-runtime'] === true,
        skipGrammars: values['skip-grammars'] === true,
        ...(only && only.length > 0 ? { only } : {}),
        ...(values.registry ? { registry: values.registry } : {}),
        ...(values.tag ? { tag: values.tag } : {}),
        ...(access ? { access } : {}),
    });
    return result.failed.length === 0 ? 0 : 1;
}

async function cmdFlatten(args: readonly string[]): Promise<number> {
    const { positionals } = parseArgs({ args: [...args], allowPositionals: true });
    const [, lang] = positionals;
    if (!positionals[0] || !lang) {
        process.stderr.write('usage: arborium-rt flatten-queries <group> <lang>\n');
        return 1;
    }
    const p = paths();
    const outDir = join(p.grammarsOut, lang);
    const index = buildGrammarIndex(p.langsRoot);
    flattenAllIntoDir(lang, index, outDir);
    step(`wrote flattened queries for ${lang} to ${outDir} (${QUERY_TYPES.join(', ')})`);
    return 0;
}

function readPackageVersion(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli/main.js -> dist/cli -> dist -> <package>
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version as string;
}

main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
        process.exit(1);
    });
