// Stage a grammar's built assets into the runtime package's
// dist/grammars/<lang>/ so the aggregator module at
// dist/grammars/index.js can reach them via
// `new URL('./<lang>/<file>', import.meta.url)`.
//
// Output per grammar: tree-sitter-<lang>.wasm plus the flattened `.scm`
// files. The per-language metadata (languageId, languageExport, asset
// URLs) is emitted in a single module by `writeGrammarsIndexModule` —
// consumers never import a per-grammar subpath.

import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import type { GrammarIndexEntry } from './arborium-yaml.js';
import { detectLicenses, findNoticeFiles } from './grammar-clone.js';
import { QUERY_TYPES, type QueryType } from './flatten.js';
import { Logger, paths } from './util.js';

export interface BuildPackageArgs {
    group: string;
    lang: string;
    /** Logger for this package step. Defaults to one tagged with `lang`. */
    log?: Logger;
    /** Pre-built corpus index. Defaults to scanning the filesystem. */
    index?: Map<string, GrammarIndexEntry>;
}

export async function buildPackage(args: BuildPackageArgs): Promise<void> {
    const p = paths();
    const log = args.log ?? new Logger(args.lang);
    const grammarDir = join(p.grammarsOut, args.lang);
    const outDir = join(p.packagesOut, args.lang);
    const wasmName = `tree-sitter-${args.lang}.wasm`;
    const wasmSrc = join(grammarDir, wasmName);

    if (!existsSync(wasmSrc)) {
        throw new Error(
            `${wasmSrc} not found. run \`arborium-rt build-grammar ${args.group} ${args.lang}\` first.`,
        );
    }

    const detectedLicenses = await detectLicenses(log, grammarDir);
    const noticeFiles = findNoticeFiles(grammarDir);
    const attributionFiles = [
        ...new Set([
            ...detectedLicenses.map((l) => l.file),
            ...noticeFiles.map((n) => n.file),
        ]),
    ].sort();
    if (attributionFiles.length === 0) {
        throw new Error(
            `no LICENSE/NOTICE files in ${grammarDir}. run \`arborium-rt build-grammar ${args.group} ${args.lang}\` first to fetch the upstream attribution.`,
        );
    }

    const queries: Partial<Record<QueryType, string>> = {};
    for (const qtype of QUERY_TYPES) {
        const src = join(grammarDir, `${qtype}.scm`);
        if (existsSync(src)) {
            queries[qtype] = readFileSync(src, 'utf8');
        }
    }

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    copyFileSync(wasmSrc, join(outDir, wasmName));
    for (const fname of attributionFiles) {
        copyFileSync(join(grammarDir, fname), join(outDir, fname));
    }
    for (const [qtype, content] of Object.entries(queries)) {
        writeFileSync(join(outDir, `${qtype}.scm`), content);
    }

    log.step(`wrote grammars/${args.lang} to ${relative(p.repoRoot, outDir)}`);
    const files = [
        wasmName,
        ...attributionFiles,
        ...QUERY_TYPES.filter((q) => queries[q] !== undefined).map((q) => `${q}.scm`),
    ];
    for (const name of files) {
        const size = statSync(join(outDir, name)).size;
        log.info(`    ${size.toString().padStart(9)}  ${name}`);
    }
}
