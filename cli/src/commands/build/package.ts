// Stage a grammar's built assets into the runtime package's
// dist/grammars/<lang>/ so the aggregator module at
// dist/grammars/index.js can reach them via
// `new URL('./<lang>/<file>', import.meta.url)`.
//
// Output per grammar: tree-sitter-<lang>.wasm plus the flattened `.scm`
// files. The per-language metadata (languageId, languageExport, asset
// URLs) is emitted in a single module by `writeGrammarsIndexModule` —
// consumers never import a per-grammar subpath.

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ListrTask } from "listr2";
import type { GrammarIndexEntry } from "../../arborium-yaml.ts";
import { QUERY_TYPES, type QueryType } from "../../flatten.ts";
import { detectLicenses, findNoticeFiles } from "../../grammar-clone.ts";
import { paths } from "../../util.ts";

export interface BuildPackageArgs {
	group: string;
	lang: string;
	/** Pre-built corpus index. Defaults to scanning the filesystem. */
	index?: Map<string, GrammarIndexEntry>;
}

export function buildPackage(args: BuildPackageArgs): ListrTask[] {
	return [
		{
			async task(_ctx, task) {
				const p = paths();
				const grammarDir = join(p.grammarsOut, args.lang);
				const outDir = join(p.packagesOut, args.lang);
				const wasmName = `tree-sitter-${args.lang}.wasm`;
				const wasmSrc = join(grammarDir, wasmName);

				const detectedLicenses = await detectLicenses(
					task.stdout(),
					grammarDir,
				);
				const noticeFiles = await findNoticeFiles(grammarDir);
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
					const isFile = await stat(src)
						.then((s) => s.isFile())
						.catch(() => false);
					if (isFile) {
						queries[qtype] = src;
					}
				}

				await rm(outDir, { recursive: true, force: true });
				await mkdir(outDir, { recursive: true });

				await copyFile(wasmSrc, join(outDir, wasmName));
				for (const fname of attributionFiles) {
					await copyFile(join(grammarDir, fname), join(outDir, fname));
				}
				for (const [qtype, src] of Object.entries(queries)) {
					await copyFile(src, join(outDir, `${qtype}.scm`));
				}
			},
		},
	];
}
