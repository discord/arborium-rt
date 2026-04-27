// Compile a tree-sitter grammar as SIDE_MODULE=2 + materialize its flattened
// queries. Port of `scripts/build-grammar.sh`.

import {
    copyFileSync,
    cpSync,
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
import { Logger, hasCommand, paths, run } from './util.js';

export interface BuildGrammarArgs {
    group: string;
    lang: string;
    /** Logger for this build. Defaults to one tagged with `lang`. */
    log?: Logger;
    /** Pre-built corpus index. Defaults to scanning the filesystem. */
    index?: Map<string, GrammarIndexEntry>;
}

export async function buildGrammar(args: BuildGrammarArgs): Promise<void> {
    const p = paths();
    const log = args.log ?? new Logger(args.lang);
    const defDir = join(p.langsRoot, args.group, args.lang, 'def');
    const grammarDir = join(defDir, 'grammar');
    const grammarJs = join(grammarDir, 'grammar.js');
    if (!existsSync(grammarJs)) {
        throw new Error(`grammar.js not found at ${grammarJs}`);
    }

    if (!await hasCommand('emcc')) {
        throw new Error(`emcc not found on PATH`);
    }
    if (!existsSync(p.treeSitterBin)) {
        throw new Error(
            `patched tree-sitter binary not found at ${p.treeSitterBin}; run \`./scripts/arborium-rt bootstrap\` first`,
        );
    }

    const outDir = join(p.grammarsOut, args.lang);
    const buildDir = join(outDir, 'build');
    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });

    const index = args.index ?? buildGrammarIndex(p.langsRoot);
    const currentEntry = index.get(args.lang);
    // tree-sitter's codegen replaces non-alphanumerics in the grammar name
    // with `_` when emitting `tree_sitter_<symbol>`, so a lang id like
    // `c-sharp` produces the symbol `c_sharp`. Mirror that here for the
    // fallback, otherwise `EXPORTED_FUNCTIONS=_tree_sitter_c-sharp` is an
    // invalid C identifier and the link fails.
    const cSymbol = currentEntry?.grammar.c_symbol ?? args.lang.replace(/-/g, '_');

    // --- stage npm deps -------------------------------------------------------
    //
    // Some grammars' grammar.js `require()`s upstream tree-sitter packages
    // (TSX pulls in tree-sitter-javascript, HLSL pulls in tree-sitter-cpp
    // which transitively needs tree-sitter-c, etc.). Populate a local
    // `node_modules/` with symlinks to the vendored dep grammars' def/grammar/
    // dirs, and expose it via NODE_PATH so Node's resolution finds them even
    // though the grammar.js lives at a different path.
    if (currentEntry) {
        stageNpmDeps(currentEntry, index, buildDir, log);
    }
    const nodeModules = join(buildDir, 'node_modules');
    const runEnv = existsSync(nodeModules)
        ? { NODE_PATH: nodeModules }
        : undefined;

    // --- generate parser.c ----------------------------------------------------
    //
    // Pre-create buildDir/src/ so grammar.js prelude scripts that emit files
    // cwd-relative (e.g., vim's keywords.js does `writeFileSync('src/keywords.h')`)
    // find the directory ready. tree-sitter generate itself doesn't need it.
    mkdirSync(join(buildDir, 'src'), { recursive: true });

    // Stage grammar source into a nested layout so `require('../<subdir>/...')`
    // from grammar.js resolves. Some upstream grammars (markdown, several
    // multi-language ones) expect shared helper dirs to be siblings of the
    // grammar dir. arborium vendors them in one of two ways:
    //   - upstream layout: `def/common/` alongside `def/grammar/` (asciidoc)
    //   - flattened layout: `def/grammar/common/` tucked inside (markdown)
    // Stage both views so either pattern resolves.
    const stagedGrammarJs = stageGrammarSource(defDir, buildDir);

    log.step(`generating parser.c from ${relative(p.repoRoot, grammarJs)} (sparse-only)`);
    // TREE_SITTER_SPARSE_ONLY tells our patched tree-sitter render.rs to skip
    // the dense `ts_parse_table[LARGE_STATE_COUNT][SYMBOL_COUNT]` array and
    // route every state through `ts_small_parse_table`. Cuts parser.c output
    // by ~30% and the linked SIDE_MODULE wasm by 50–75%, with a small parse-
    // time cost the highlighting workload can absorb.
    await run(log, p.treeSitterBin, ['generate', stagedGrammarJs], {
        cwd: buildDir,
        env: {
            ...runEnv,
            TREE_SITTER_SPARSE_ONLY: '1',
        },
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

    // Copy grammar-shipped headers + auxiliary C/C++ sources into src/ so
    // scanner.c's `#include`s resolve during compile.
    copySupportFiles(grammarDir, join(buildDir, 'src'));

    // --- compile --------------------------------------------------------------
    const commonCflags = ['-O2', '-fPIC', '-I', 'src'];
    const objs: string[] = [];

    log.step('compiling src/parser.c (C)');
    await run(
        log,
        'emcc',
        [...commonCflags, '-std=c11', '-c', 'src/parser.c', '-o', 'parser.o'],
        { cwd: buildDir },
    );
    objs.push('parser.o');

    if (scannerC) {
        copyFileSync(scannerC, join(buildDir, 'src', 'scanner.c'));
        log.step('compiling src/scanner.c (C)');
        await run(
            log,
            'emcc',
            [...commonCflags, '-std=c11', '-c', 'src/scanner.c', '-o', 'scanner.o'],
            { cwd: buildDir },
        );
        objs.push('scanner.o');
    } else if (scannerCxx) {
        const scannerBase = basename(scannerCxx);
        copyFileSync(scannerCxx, join(buildDir, 'src', scannerBase));
        log.step(`compiling src/${scannerBase} (C++)`);
        await run(
            log,
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
    log.step(`linking tree-sitter-${args.lang}.wasm (${linker}, tree_sitter_${cSymbol})`);
    await run(
        log,
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
    log.step('flattening queries');
    flattenAllIntoDir(args.lang, index, outDir);

    log.step(`built ${relative(p.repoRoot, outDir)}`);
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
    log: Logger,
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
                log.warn(`dep ${dep.npm} -> grammar id ${depId} not found in corpus; skipping`);
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
            log.step(`staged node_modules/${dep.npm} -> ${relative(buildDir, target)}`);

            // Recurse so transitive deps (HLSL -> CPP -> C) are also staged.
            walk(depEntry);
        }
    }

    walk(start);
}

/**
 * Stage a copy of the grammar directory under `<buildDir>/grammar-stage/`
 * in a nested layout that satisfies both `./<x>` and `../<x>` relative
 * requires from grammar.js. Returns the absolute path to the staged
 * grammar.js.
 *
 *   <buildDir>/grammar-stage/
 *     grammar/       <- full copy of def/grammar/
 *       grammar.js   <- run tree-sitter generate against this copy
 *       ...
 *     <sibling>/     <- each non-`grammar` subdir of def/ copied here
 *                       (upstream-style layout: e.g., asciidoc's
 *                       `def/common/common.js`)
 *     <nested>/      <- each subdir of def/grammar/ ALSO copied here
 *                       (flattened vendoring: e.g., markdown's
 *                       `def/grammar/common/common.js` read as
 *                       `../common/common.js` from grammar.js)
 *
 * If both passes contribute a dir with the same name, the second pass
 * (nested → sibling) merges into the first via cpSync's default force.
 */
function stageGrammarSource(defDir: string, buildDir: string): string {
    const stageRoot = join(buildDir, 'grammar-stage');
    const stageGrammar = join(stageRoot, 'grammar');
    const grammarDir = join(defDir, 'grammar');

    // Full copy of the grammar dir into stage/grammar/.
    cpSync(grammarDir, stageGrammar, { recursive: true });

    // Pass 1: def/'s non-grammar subdirs become siblings of stage/grammar/.
    for (const entry of readdirSync(defDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'grammar') continue;
        cpSync(join(defDir, entry.name), join(stageRoot, entry.name), { recursive: true });
    }

    // Pass 2: def/grammar/'s own subdirs also become siblings, merging with
    // whatever pass 1 already wrote under the same name.
    for (const entry of readdirSync(grammarDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        cpSync(join(grammarDir, entry.name), join(stageRoot, entry.name), { recursive: true });
    }

    return join(stageGrammar, 'grammar.js');
}

/**
 * Recursively copy grammar-shipped C/C++ support files into the build dir's
 * `src/` so scanner.c's `#include`s resolve. Covers headers (.h/.hpp) and
 * auxiliary sources that scanners pull in as textual includes (e.g., yaml's
 * `schema.core.c` / `schema.json.c` / `schema.legacy.c`). parser.c is
 * deliberately excluded — we generate that fresh from grammar.js.
 */
function copySupportFiles(src: string, dst: string): void {
    if (!existsSync(src)) return;
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        const full = join(src, entry.name);
        if (entry.isDirectory()) {
            copySupportFiles(full, join(dst, entry.name));
            continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name === 'parser.c') continue;
        if (!/\.(h|hpp|c|cc|cpp)$/.test(entry.name)) continue;
        mkdirSync(dst, { recursive: true });
        copyFileSync(full, join(dst, entry.name));
    }
}
