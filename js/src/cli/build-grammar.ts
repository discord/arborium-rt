// Compile a tree-sitter grammar as SIDE_MODULE=2 + materialize its flattened
// queries. Port of `scripts/build-grammar.sh`.

import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    symlinkSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';

import {
    buildGrammarIndex,
    type GrammarIndexEntry,
} from './arborium-yaml.js';
import { flattenAllIntoDir } from './flatten.js';
import { hasCommand, paths, run, step, warn } from './util.js';

export interface BuildGrammarArgs {
    group: string;
    lang: string;
}

export async function buildGrammar(args: BuildGrammarArgs): Promise<void> {
    const p = paths();
    const defDir = join(p.langsRoot, args.group, args.lang, 'def');
    const grammarDir = join(defDir, 'grammar');
    const grammarJs = join(grammarDir, 'grammar.js');
    if (!existsSync(grammarJs)) {
        throw new Error(`grammar.js not found at ${grammarJs}`);
    }

    for (const cmd of ['emcc', 'tree-sitter']) {
        if (!await hasCommand(cmd)) {
            throw new Error(`${cmd} not found on PATH`);
        }
    }

    const outDir = join(p.grammarsOut, args.lang);
    const buildDir = join(outDir, 'build');
    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });

    const index = buildGrammarIndex(p.langsRoot);
    const currentEntry = index.get(args.lang);
    const cSymbol = currentEntry?.grammar.c_symbol ?? args.lang;

    // --- stage npm deps -------------------------------------------------------
    //
    // Some grammars' grammar.js `require()`s upstream tree-sitter packages
    // (TSX pulls in tree-sitter-javascript, HLSL pulls in tree-sitter-cpp
    // which transitively needs tree-sitter-c, etc.). Populate a local
    // `node_modules/` with symlinks to the vendored dep grammars' def/grammar/
    // dirs, and expose it via NODE_PATH so Node's resolution finds them even
    // though the grammar.js lives at a different path.
    if (currentEntry) {
        stageNpmDeps(currentEntry, index, buildDir);
    }
    const nodeModules = join(buildDir, 'node_modules');
    const runEnv = existsSync(nodeModules)
        ? { NODE_PATH: nodeModules }
        : undefined;

    // --- generate parser.c ----------------------------------------------------
    step(`generating parser.c from ${relative(p.repoRoot, grammarJs)}`);
    await run('tree-sitter', ['generate', grammarJs], {
        cwd: buildDir,
        ...(runEnv ? { env: runEnv } : {}),
    });

    // --- scanner detection ----------------------------------------------------
    //
    // Grammars may ship a scanner in C (scanner.c) or C++ (scanner.cc/.cpp).
    // The arborium corpus is C-only today, but the C++ path is scaffolded so
    // we don't get stuck when upstream adds one. Linking in C++ mode brings
    // libc++ into the SIDE_MODULE statically.
    let scannerC: string | undefined;
    let scannerCxx: string | undefined;
    if (existsSync(join(grammarDir, 'scanner.c'))) {
        scannerC = join(grammarDir, 'scanner.c');
    } else if (existsSync(join(grammarDir, 'scanner.cc'))) {
        scannerCxx = join(grammarDir, 'scanner.cc');
    } else if (existsSync(join(grammarDir, 'scanner.cpp'))) {
        scannerCxx = join(grammarDir, 'scanner.cpp');
    }

    // Copy grammar-shipped headers (e.g., TSX/TS's common/scanner.h) into
    // src/ so `#include "common/scanner.h"` resolves during compile.
    copyHeaders(grammarDir, join(buildDir, 'src'));

    // --- compile --------------------------------------------------------------
    const commonCflags = ['-O2', '-fPIC', '-I', 'src'];
    const objs: string[] = [];

    step('compiling src/parser.c (C)');
    await run(
        'emcc',
        [...commonCflags, '-std=c11', '-c', 'src/parser.c', '-o', 'parser.o'],
        { cwd: buildDir },
    );
    objs.push('parser.o');

    if (scannerC) {
        copyFileSync(scannerC, join(buildDir, 'src', 'scanner.c'));
        step('compiling src/scanner.c (C)');
        await run(
            'emcc',
            [...commonCflags, '-std=c11', '-c', 'src/scanner.c', '-o', 'scanner.o'],
            { cwd: buildDir },
        );
        objs.push('scanner.o');
    } else if (scannerCxx) {
        const scannerBase = basename(scannerCxx);
        copyFileSync(scannerCxx, join(buildDir, 'src', scannerBase));
        step(`compiling src/${scannerBase} (C++)`);
        await run(
            'em++',
            [
                ...commonCflags, '-std=c++17', '-fno-exceptions', '-fno-rtti',
                '-c', `src/${scannerBase}`, '-o', 'scanner.o',
            ],
            { cwd: buildDir },
        );
        objs.push('scanner.o');
    }

    // --- link -----------------------------------------------------------------
    const linker = scannerCxx ? 'em++' : 'emcc';
    const wasmOut = join(outDir, `tree-sitter-${args.lang}.wasm`);
    step(`linking tree-sitter-${args.lang}.wasm (${linker}, tree_sitter_${cSymbol})`);
    await run(
        linker,
        [
            '-O2', '-fPIC',
            '-s', 'SIDE_MODULE=2',
            '-s', `EXPORTED_FUNCTIONS=_tree_sitter_${cSymbol}`,
            '-o', wasmOut,
            ...objs,
        ],
        { cwd: buildDir },
    );

    // --- flatten queries ------------------------------------------------------
    step('flattening queries');
    flattenAllIntoDir(args.lang, index, outDir);

    step(`built ${relative(p.repoRoot, outDir)}`);
}

/**
 * Symlink each transitively-required dep's def/grammar/ dir into
 * `<buildDir>/node_modules/<tree-sitter-X>/`. Node's require() walks up
 * looking for node_modules, so transitive resolution works as long as
 * every dep is at the top level of the build dir's node_modules.
 */
function stageNpmDeps(
    start: GrammarIndexEntry,
    index: Map<string, GrammarIndexEntry>,
    buildDir: string,
): void {
    const staged = new Set<string>();

    function walk(entry: GrammarIndexEntry): void {
        for (const dep of entry.grammar.dependencies ?? []) {
            if (!dep.npm) continue;
            if (staged.has(dep.npm)) continue;

            // Convention: npm dep "tree-sitter-<X>" corresponds to arborium
            // grammar id <X>. If the dep doesn't resolve, skip with a warning
            // — some upstream deps (e.g. `tree-sitter-clojure` for commonlisp)
            // are vendored under different group dirs, but the id-based
            // lookup still finds them.
            const depId = dep.npm.replace(/^tree-sitter-/, '');
            const depEntry = index.get(depId);
            if (!depEntry) {
                warn(`dep ${dep.npm} -> grammar id ${depId} not found in corpus; skipping`);
                continue;
            }
            staged.add(dep.npm);

            const linkPath = join(buildDir, 'node_modules', dep.npm);
            mkdirSync(join(buildDir, 'node_modules'), { recursive: true });
            const target = join(depEntry.defPath, 'grammar');
            try {
                symlinkSync(target, linkPath, 'dir');
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code !== 'EEXIST') throw e;
            }
            step(`staged node_modules/${dep.npm} -> ${relative(buildDir, target)}`);

            // Recurse so transitive deps (HLSL -> CPP -> C) are also staged.
            walk(depEntry);
        }
    }

    walk(start);
}

/** Recursively copy `*.h` files from `src` into `dst`, preserving structure. */
function copyHeaders(src: string, dst: string): void {
    if (!existsSync(src)) return;
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        const full = join(src, entry.name);
        if (entry.isDirectory()) {
            copyHeaders(full, join(dst, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('.h')) {
            mkdirSync(dst, { recursive: true });
            copyFileSync(full, join(dst, entry.name));
        }
    }
}
