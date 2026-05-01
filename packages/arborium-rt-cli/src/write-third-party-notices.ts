// Generate THIRD_PARTY_NOTICES — a plain-text bundle of every upstream
// grammar's LICENSE (and any NOTICE) at its pinned commit. Two copies
// are written: one at the repo root for GitHub browsing, one inside
// `packages/arborium-rt/dist/` so the npm tarball ships it.
//
// Pipeline per grammar:
//   1. Shallow-clone the upstream repo at the pinned commit, cached
//      under `target/notices-cache/<id>/` and reused on rerun.
//   2. Run `askalono --format json crawl <clonedir>` to discover and
//      identify every license file. askalono uses the `ignore` crate's
//      built-in "license" file matcher (LICENSE*, COPYING*, etc.); it
//      does not detect NOTICE files. Filter results to depth-1 paths
//      only — askalono recurses indefinitely and would otherwise pick
//      up `examples/<x>/LICENSE` and similar.
//   3. Reconcile each detected SPDX id against the manifest's
//      `license` field via `spdx-satisfies`. A mismatch is a hard
//      error — that's exactly the failure mode this tool exists to
//      catch.
//   4. Discover NOTICE files separately by filename pattern. Apache
//      2.0 §4(d) requires propagating any upstream NOTICE; bundle
//      unconditionally regardless of declared license.
//   5. Read every LICENSE / NOTICE file verbatim and embed it in the
//      output bundle.
//
// Output is sorted by id and contains no timestamps so successive
// builds are byte-reproducible. askalono is a developer prerequisite
// (see CLAUDE.md); we fail fast with a clear error if it isn't on
// PATH instead of trying to install it.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import spdxSatisfies from "spdx-satisfies";

import { buildGrammarIndex, type GrammarIndexEntry } from "./arborium-yaml.js";
import { Logger, hasCommand, paths, run, runCapture, runPool } from "./util.js";

/** Reject any askalono detection below this score as "not actually known". */
const MIN_SCORE = 0.8;

/** Match upstream NOTICE files we should bundle for attribution. */
const NOTICE_FILE_RE = /^NOTICE($|\.)/i;

/** Bounded clone parallelism. ~100 grammars × network-dominant; 8 is plenty. */
const DEFAULT_CLONE_CONCURRENCY = 8;

/**
 * Per-grammar SPDX overrides for cases where the arborium manifest's
 * `license:` is wrong and askalono's detection is right. Used during
 * reconciliation in place of the manifest's value — askalono's finding
 * still has to match this. Each entry is a deliberate human review.
 */
const LICENSE_OVERRIDES: Record<string, string> = {
  // Manifest claims Unlicense; upstream COPYING.txt is the verbatim
  // CC0-1.0 dedication.
  clojure: "CC0-1.0",
  // Manifest claims MIT; upstream LICENSE is the verbatim BSD-3-Clause text.
  jq: "BSD-3-Clause",
  // Manifest claims MIT; upstream LICENSE is the verbatim BSD-2-Clause text.
  postscript: "BSD-2-Clause",
  // Manifest claims `Apache-2.0 WITH LLVM-exception`; upstream LICENSE is
  // plain Apache-2.0 with no LLVM-exception clause.
  wit: "Apache-2.0",
};

/**
 * Per-grammar commit overrides for upstreams whose manifest-pinned SHA is
 * no longer reachable (force-push, repo cleanup). The manifest itself
 * lives in the arborium submodule and isn't editable from here, so this
 * pins the notices generator to a current default-branch HEAD. Refresh
 * when upstream rotates again.
 */
const COMMIT_OVERRIDES: Record<string, string> = {
  rust: "a2d578348a195fe9fc97bd14a9fc84f314a0c2fe",
  styx: "0655eb2b0f9e1ddbd0e27a0b9063f1317c990f70",
  vim: "3092fcd99eb87bbd0fc434aa03650ba58bd5b43b",
};

/**
 * Sentinels in the arborium manifest that mean "this grammar is vendored
 * locally — there is no public upstream to clone." We attribute those
 * under arborium's own license (`MIT OR Apache-2.0`).
 */
const LOCAL_SENTINELS = new Set(["local", "n/a"]);

/** SPDX expression arborium itself ships under; used for local grammars. */
const ARBORIUM_LICENSE_EXPR = "MIT OR Apache-2.0";

interface AskalonoFileResult {
  path: string;
  result?: {
    score: number;
    license: { name: string; kind: string; aliases: string[] } | null;
    containing: unknown[];
  };
  error?: string;
}

interface DetectedLicense {
  /** Filename relative to the clone root, e.g. `LICENSE` or `LICENSE-MIT`. */
  file: string;
  /** SPDX identifier as reported by askalono (e.g. `MIT`, `Apache-2.0`). */
  spdx: string;
  /** Confidence score in [0, 1]. */
  score: number;
  /** Verbatim file contents. */
  text: string;
}

interface NoticeBlock {
  file: string;
  text: string;
}

interface NoticeEntry {
  id: string;
  name: string | undefined;
  repo: string | undefined;
  commit: string | undefined;
  licenses: DetectedLicense[];
  notices: NoticeBlock[];
}

export async function writeThirdPartyNotices(): Promise<void> {
  const p = paths();
  const log = new Logger("notices");

  if (!(await hasCommand("askalono"))) {
    throw new Error(
      "askalono not on PATH — install via `cargo install --locked askalono-cli` or download from https://github.com/jpeddicord/askalono/releases (see CLAUDE.md prereqs)",
    );
  }

  const index = buildGrammarIndex(p.langsRoots);
  const targets = [...index.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (targets.length === 0) {
    log.warn("grammar index is empty; skipping notices generation");
    return;
  }

  const cacheRoot = join(p.targetDir, "notices-cache");
  mkdirSync(cacheRoot, { recursive: true });

  const entries: NoticeEntry[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  const concurrency = Math.max(
    1,
    Math.min(DEFAULT_CLONE_CONCURRENCY, availableParallelism()),
  );

  await runPool(targets, concurrency, async ([id, entry]) => {
    try {
      entries.push(await processGrammar(id, entry, cacheRoot, p.submoduleRoot));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failed.push({ id, reason });
    }
  });

  if (failed.length > 0) {
    for (const { id, reason } of failed) {
      log.warn(`${id}: ${reason.split("\n")[0]}`);
    }
    throw new Error(
      `notices generation failed for ${failed.length}/${targets.length} grammar(s); first failure: ${failed[0]!.id}: ${failed[0]!.reason.split("\n")[0]}`,
    );
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  const text = renderBundle(entries);

  const distPath = join(p.runtimePackageDir, "dist", "THIRD_PARTY_NOTICES");
  mkdirSync(join(p.runtimePackageDir, "dist"), { recursive: true });
  writeFileSync(distPath, text);
  writeFileSync(join(p.repoRoot, "THIRD_PARTY_NOTICES"), text);

  log.step(
    `wrote THIRD_PARTY_NOTICES (${entries.length} grammars, ${entries.reduce((n, e) => n + e.licenses.length, 0)} license file(s), ${entries.reduce((n, e) => n + e.notices.length, 0)} notice file(s))`,
  );
}

async function processGrammar(
  id: string,
  entry: GrammarIndexEntry,
  cacheRoot: string,
  arboriumRoot: string,
): Promise<NoticeEntry> {
  if (isLocalGrammar(entry)) {
    return processLocalGrammar(id, entry, arboriumRoot);
  }

  const log = new Logger(id);
  if (!entry.repo) {
    throw new Error(`grammar ${id} has no upstream repo URL`);
  }

  const commit = COMMIT_OVERRIDES[id] ?? entry.commit;
  const cloneDir = join(cacheRoot, id);
  await ensureClone(log, cloneDir, entry.repo, commit);

  const detections = await crawlLicenses(log, cloneDir);
  if (detections.length === 0) {
    throw new Error(`askalono found no license files in ${cloneDir}`);
  }

  const expected = LICENSE_OVERRIDES[id] ?? entry.license;
  if (!expected) {
    throw new Error(`grammar ${id} has no manifest license to reconcile against`);
  }
  reconcile(id, detections, expected, entry.license);

  const notices = readNoticeFiles(cloneDir);

  return {
    id,
    name: entry.grammar.name,
    repo: entry.repo,
    commit,
    licenses: detections.sort((a, b) => a.file.localeCompare(b.file)),
    notices: notices.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

function isLocalGrammar(entry: GrammarIndexEntry): boolean {
  if (entry.repo && LOCAL_SENTINELS.has(entry.repo)) return true;
  if (entry.commit && LOCAL_SENTINELS.has(entry.commit)) return true;
  return false;
}

/**
 * Attribute a locally-vendored grammar (one with no public upstream to
 * clone) under arborium's own LICENSE-MIT and LICENSE-APACHE. Reads
 * those files directly from the arborium submodule root.
 */
async function processLocalGrammar(
  id: string,
  entry: GrammarIndexEntry,
  arboriumRoot: string,
): Promise<NoticeEntry> {
  const log = new Logger(id);
  const detections = await crawlLicenses(log, arboriumRoot);
  if (detections.length === 0) {
    throw new Error(
      `askalono found no license files at the arborium submodule root (${arboriumRoot})`,
    );
  }
  reconcile(id, detections, ARBORIUM_LICENSE_EXPR, entry.license);
  return {
    id,
    name: entry.grammar.name,
    repo: "(local — vendored in arborium; attributed under arborium's license)",
    commit: undefined,
    licenses: detections.sort((a, b) => a.file.localeCompare(b.file)),
    notices: [],
  };
}

/**
 * Verify each detection satisfies `expected`. `expected` may be a
 * compound `A OR B` expression — split and accept any branch, since
 * `spdx-satisfies` doesn't accept OR/AND on the right-hand side.
 */
function reconcile(
  id: string,
  detections: readonly DetectedLicense[],
  expected: string,
  manifestLicense: string | undefined,
): void {
  const branches = expected.split(/\s+OR\s+/i).map((s) => s.trim()).filter(Boolean);
  for (const det of detections) {
    if (det.score < MIN_SCORE) {
      throw new Error(
        `askalono confidence ${det.score.toFixed(3)} below threshold ${MIN_SCORE} for ${id}/${det.file} (detected ${det.spdx}); manual review required`,
      );
    }
    const ok = branches.some((b) => spdxSatisfies(det.spdx, [b]));
    if (!ok) {
      throw new Error(
        `license mismatch for ${id}: manifest says ${manifestLicense ?? "(none)"}, expected ${expected}, askalono detected ${det.spdx} at confidence ${det.score.toFixed(3)} in ${det.file}`,
      );
    }
  }
}

/**
 * Ensure `cloneDir` contains a checkout of `repo` at `commit`. Idempotent:
 * if the directory already has the right commit checked out, returns
 * without touching the network.
 *
 * Strategy:
 *   `git init` + `git fetch --depth 1 origin <sha>` + `git checkout`.
 *   Falls back to a blobless clone if the forge rejects fetching arbitrary
 *   SHAs (rare; not seen on any current grammar source, but cheap insurance).
 */
async function ensureClone(
  log: Logger,
  cloneDir: string,
  repo: string,
  commit: string | undefined,
): Promise<void> {
  if (commit && existsSync(join(cloneDir, ".git"))) {
    try {
      const head = (
        await runCapture(log, "git", ["-C", cloneDir, "rev-parse", "HEAD"])
      ).trim();
      if (head === commit) return;
    } catch {
      // fall through and re-clone
    }
  }

  if (existsSync(cloneDir)) {
    rmSync(cloneDir, { recursive: true, force: true });
  }
  mkdirSync(cloneDir, { recursive: true });

  if (commit) {
    try {
      await run(log, "git", ["init", "--quiet", cloneDir]);
      await run(log, "git", ["-C", cloneDir, "remote", "add", "origin", repo]);
      await run(log, "git", [
        "-C",
        cloneDir,
        "fetch",
        "--depth",
        "1",
        "--no-tags",
        "origin",
        commit,
      ]);
      await run(log, "git", [
        "-C",
        cloneDir,
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "FETCH_HEAD",
      ]);
      return;
    } catch {
      log.warn(`fetch-by-SHA failed for ${repo}; falling back to blobless clone`);
      rmSync(cloneDir, { recursive: true, force: true });
      mkdirSync(cloneDir, { recursive: true });
    }
  }

  if (commit) {
    await run(log, "git", [
      "clone",
      "--filter=blob:none",
      "--no-tags",
      repo,
      cloneDir,
    ]);
    await run(log, "git", [
      "-C",
      cloneDir,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      commit,
    ]);
  } else {
    await run(log, "git", ["clone", "--depth", "1", "--no-tags", repo, cloneDir]);
  }
}

/**
 * Run `askalono crawl`, parse its line-delimited JSON output, and filter
 * to depth-1 hits only (askalono recurses without bound). Each hit is
 * returned with the file's verbatim text inlined.
 */
async function crawlLicenses(
  log: Logger,
  cloneDir: string,
): Promise<DetectedLicense[]> {
  const stdout = await runCapture(log, "askalono", [
    "--format",
    "json",
    "crawl",
    cloneDir,
  ]);

  const out: DetectedLicense[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: AskalonoFileResult;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(
        `failed to parse askalono JSON line: ${trimmed.slice(0, 200)}`,
        { cause: e instanceof Error ? e : undefined },
      );
    }
    if (!obj.path) continue;

    // Depth-1 only. askalono recurses without bound and also flags
    // files it can't identify as errors; both classes of result get
    // dropped here before we treat anything as fatal.
    const rel = relativeFromClone(cloneDir, obj.path);
    if (rel === undefined || rel.includes("/")) continue;

    if (obj.error || !obj.result?.license) continue;

    out.push({
      file: rel,
      spdx: obj.result.license.name,
      score: obj.result.score,
      text: readFileSync(obj.path, "utf8"),
    });
  }
  return out;
}

function relativeFromClone(cloneDir: string, abs: string): string | undefined {
  const norm = (s: string) => s.replace(/\/+$/, "");
  const root = norm(cloneDir);
  const candidate = norm(abs);
  if (!candidate.startsWith(`${root}/`)) return undefined;
  return candidate.slice(root.length + 1);
}

function readNoticeFiles(cloneDir: string): NoticeBlock[] {
  return readdirSync(cloneDir, { withFileTypes: true })
    .filter((e) => e.isFile() && NOTICE_FILE_RE.test(e.name))
    .map((e) => ({
      file: e.name,
      text: readFileSync(join(cloneDir, e.name), "utf8"),
    }));
}

const RULE = "=".repeat(80);
const SUBRULE = "-".repeat(80);
const NOTICE_BANNER = "--------------------------------- NOTICE ---------------------------------------";

function renderBundle(entries: readonly NoticeEntry[]): string {
  const head = [
    "THIRD-PARTY NOTICES — @discord/arborium-rt",
    "==========================================",
    "",
    "This package bundles tree-sitter grammars from upstream sources, each",
    "licensed under its own terms shown verbatim below. Generated by",
    "`arborium-rt notices` from each grammar's pinned commit; license",
    "identification is performed by askalono (https://github.com/jpeddicord/askalono).",
    "",
  ].join("\n");

  const sections = entries.map((e, i) => renderEntry(i + 1, e));
  return `${head}\n${sections.join("\n\n")}\n`;
}

function renderEntry(idx: number, e: NoticeEntry): string {
  const numbered = String(idx).padStart(3, "0");
  const header = [
    RULE,
    `[${numbered}] tree-sitter-${e.id} (id: ${e.id}${e.name ? `, name: ${e.name}` : ""})`,
    `Source:  ${e.repo ?? "(no repo URL)"}`,
    `Commit:  ${e.commit ?? "(unpinned, default branch)"}`,
  ].join("\n");

  const blocks: string[] = [];
  for (const lic of e.licenses) {
    blocks.push(
      [
        `License: ${lic.spdx}  (askalono confidence: ${lic.score.toFixed(3)})`,
        `File:    ${lic.file}`,
        SUBRULE,
        "",
        lic.text.replace(/\s+$/g, ""),
      ].join("\n"),
    );
  }
  for (const nb of e.notices) {
    blocks.push(
      [
        NOTICE_BANNER,
        `File:    ${nb.file}`,
        "",
        nb.text.replace(/\s+$/g, ""),
      ].join("\n"),
    );
  }

  return [header, ...blocks].join("\n\n");
}
