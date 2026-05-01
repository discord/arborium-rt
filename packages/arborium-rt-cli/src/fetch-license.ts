// Stage upstream LICENSE / COPYING / NOTICE files for a single grammar
// into `target/grammars/<lang>/`, ready for build-package to copy into
// `dist/grammars/<lang>/`. We shallow-clone the upstream at its pinned
// commit (or arborium's local copy for vendored grammars) and copy the
// depth-1 attribution files; askalono confirms each LICENSE file's SPDX
// id but the per-grammar bundle ships them verbatim regardless of
// detection score (there's no consolidation step here — that lives in
// `write-third-party-notices.ts` and reuses the same shared cache).
//
// Distributing the parser wasm without the upstream attribution would
// violate every common OSS license we ship under (MIT, Apache-2.0, ISC,
// CC0-1.0, BSD-2/3-Clause), so this is a hard build step — failure to
// locate any license aborts the build.
//
// Cache semantics: idempotent — if `outDir` already contains any
// LICENSE-ish file, no clone happens. To re-fetch after bumping a
// pinned commit, delete the affected files in `target/grammars/<lang>/`.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  type GrammarIndexEntry,
  resolveCommit,
} from "./arborium-yaml.js";
import {
  cloneDirFor,
  detectLicenses,
  ensureClone,
  findNoticeFiles,
  isLocalGrammar,
} from "./grammar-clone.js";
import { Logger, paths } from "./util.js";

export interface FetchLicenseArgs {
  /** Grammar id (matches the index key). Used as the clone-cache key. */
  id: string;
  /** Resolved manifest entry. Source of `repo`, `commit`, and local-sentinel detection. */
  entry: GrammarIndexEntry;
  /** Where the LICENSE file(s) should be written. */
  outDir: string;
  /** Logger to surface progress + warnings on. */
  log: Logger;
}

/**
 * Fetch every upstream license file we can find and write them to `outDir`,
 * each preserving its original filename. Idempotent: if `outDir` already
 * contains any LICENSE-ish file, returns immediately without cloning.
 */
export async function fetchLicense(args: FetchLicenseArgs): Promise<void> {
  if (existsSync(args.outDir)) {
    const cachedLicenses = await detectLicenses(args.log, args.outDir);
    const cachedNotices = findNoticeFiles(args.outDir);
    if (cachedLicenses.length > 0 || cachedNotices.length > 0) {
      args.log.info(`license already cached at ${args.outDir}`);
      return;
    }
  }

  const sourceDir = await sourceDirFor(args);
  const licenses = await detectLicenses(args.log, sourceDir);
  const notices = findNoticeFiles(sourceDir);
  const allFiles = [
    ...licenses.map((l) => l.file),
    ...notices
      .filter((n) => !licenses.some((l) => l.file === n.file))
      .map((n) => n.file),
  ];

  if (allFiles.length === 0) {
    throw new Error(
      `no LICENSE or NOTICE files found at ${sourceDir} for ${args.id}`,
    );
  }

  mkdirSync(args.outDir, { recursive: true });
  for (const fname of allFiles) {
    copyFileSync(join(sourceDir, fname), join(args.outDir, fname));
  }

  // Tag dual-licensed grammars (multi-LICENSE) and Apache projects
  // (NOTICE) so `--license already cached` runs are still informative.
  const detected = licenses
    .map((l) => `${l.file}=${l.spdx}@${l.score.toFixed(3)}`)
    .join(", ");
  args.log.step(
    `staged ${allFiles.length} attribution file(s) from ${sourceDir}: ${detected}${notices.length > 0 ? ` (+${notices.length} NOTICE)` : ""}`,
  );
}

/**
 * Resolve the directory we'll copy LICENSE/NOTICE files from. For a
 * locally-vendored grammar (yuri, x86asm) that's the arborium submodule
 * root (carries `LICENSE-MIT` + `LICENSE-APACHE`). For everything else,
 * a shallow clone of the upstream at its (override-resolved) commit.
 */
async function sourceDirFor(args: FetchLicenseArgs): Promise<string> {
  if (isLocalGrammar(args.entry)) {
    return paths().submoduleRoot;
  }
  if (!args.entry.repo) {
    throw new Error(
      `${args.id}: arborium.yaml is missing a top-level \`repo:\` field`,
    );
  }
  const cloneDir = cloneDirFor(args.id);
  const commit = resolveCommit(args.id, args.entry);
  await ensureClone(args.log, cloneDir, args.entry.repo, commit);
  return cloneDir;
}
