// Generate THIRD_PARTY_NOTICES — a plain-text bundle of every upstream
// grammar's LICENSE (and any NOTICE) at its pinned commit. Two copies
// are written: one at the repo root for GitHub browsing, one inside
// `packages/arborium-rt-wasm/dist/` so the npm tarball ships it.
//
// Pipeline per grammar:
//   1. Shallow-clone the upstream repo (or pick up the local arborium
//      checkout for vendored grammars). The clone cache at
//      `target/upstream-cache/<id>/` is shared with `fetch-license.ts`,
//      so building grammars and regenerating notices don't re-clone.
//   2. Detect license files via `askalono crawl` (depth-1 only —
//      askalono recurses indefinitely otherwise).
//   3. Reconcile each detected SPDX id against the manifest's `license`
//      field via `spdx-satisfies`. Mismatches are a hard error; per-
//      grammar overrides handle the cases where the manifest itself
//      is wrong.
//   4. Discover NOTICE files separately by filename pattern. Apache
//      2.0 §4(d) requires propagating any upstream NOTICE; bundle
//      unconditionally regardless of declared license.
//   5. Embed every LICENSE / NOTICE file verbatim in the output.
//
// Output is sorted by id and contains no timestamps so successive
// runs are byte-reproducible. askalono is a developer prerequisite
// (see CLAUDE.md).

import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";

import type { ListrTask } from "listr2";
import spdxSatisfies from "spdx-satisfies";
import {
	buildGrammarIndex,
	type GrammarIndexEntry,
	resolveCommit,
} from "./arborium-yaml.ts";
import {
	ARBORIUM_LICENSE_EXPR,
	cloneDirFor,
	type DetectedLicense,
	detectLicenses,
	ensureClone,
	findNoticeFiles,
	isLocalGrammar,
	MIN_SCORE,
	type NoticeFile,
} from "./grammar-clone.ts";
import { paths } from "./util.ts";

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
};

interface NoticeEntry {
	id: string;
	name: string | undefined;
	repo: string | undefined;
	commit: string | undefined;
	licenses: DetectedLicense[];
	notices: NoticeFile[];
}

export function writeThirdPartyNotices(): ListrTask[] {
	const p = paths();
	const concurrency = Math.max(
		1,
		Math.min(DEFAULT_CLONE_CONCURRENCY, availableParallelism()),
	);

	// Closure state threaded across the three tasks below — fresh per call, so
	// standalone (`notices`) and nested (`package grammars`) runs never collide.
	let targets: Array<[string, GrammarIndexEntry]> = [];
	const entries: NoticeEntry[] = [];
	const failed: Array<{ id: string; reason: string }> = [];

	return [
		{
			title: "scanning grammar index",
			async task() {
				const index = await buildGrammarIndex(p.langsRoots);
				targets = [...index.entries()].sort(([a], [b]) => a.localeCompare(b));
			},
		},
		{
			title: "collecting upstream licenses",
			skip: () => targets.length === 0 && "grammar index is empty",
			// One task per grammar — each clones (or reuses the cache), runs
			// askalono, and reconciles. Failures are collected (exitOnError: false)
			// so a single bad grammar doesn't abort the rest; the write task below
			// hard-fails on any collected failure.
			task(_ctx, task) {
				return task.newListr(
					targets.map(([id, entry]) => ({
						title: id,
						async task(_ctx, task) {
							try {
								entries.push(await processGrammar(id, entry, task.stdout()));
							} catch (e) {
								const reason = e instanceof Error ? e.message : String(e);
								failed.push({ id, reason });
								throw e;
							}
						},
					})),
					{ concurrent: concurrency, exitOnError: false },
				);
			},
		},
		{
			title: "writing THIRD_PARTY_NOTICES",
			skip: () => targets.length === 0,
			async task() {
				if (failed.length > 0) {
					throw new Error(
						`notices generation failed for ${failed.length}/${targets.length} grammar(s); first failure: ${failed[0]!.id}: ${failed[0]!.reason.split("\n")[0]}`,
					);
				}

				entries.sort((a, b) => a.id.localeCompare(b.id));
				const text = renderBundle(entries);

				await mkdir(join(p.runtimePackageDir, "dist"), { recursive: true });
				await writeFile(
					join(p.runtimePackageDir, "dist", "THIRD_PARTY_NOTICES"),
					text,
				);
				await writeFile(join(p.repoRoot, "THIRD_PARTY_NOTICES"), text);
			},
		},
	];
}

async function processGrammar(
	id: string,
	entry: GrammarIndexEntry,
	output: Writable,
): Promise<NoticeEntry> {
	if (isLocalGrammar(entry)) {
		const arboriumRoot = paths().submoduleRoot;
		const detections = await detectLicenses(output, arboriumRoot);
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
			licenses: detections,
			notices: [],
		};
	}

	if (!entry.repo) {
		throw new Error(`grammar ${id} has no upstream repo URL`);
	}
	const commit = resolveCommit(id, entry);
	const cloneDir = cloneDirFor(id);
	await ensureClone(output, cloneDir, entry.repo, commit);

	const detections = await detectLicenses(output, cloneDir);
	if (detections.length === 0) {
		throw new Error(`askalono found no license files in ${cloneDir}`);
	}

	const expected = LICENSE_OVERRIDES[id] ?? entry.license;
	if (!expected) {
		throw new Error(
			`grammar ${id} has no manifest license to reconcile against`,
		);
	}
	reconcile(id, detections, expected, entry.license);

	const notices = await findNoticeFiles(cloneDir);

	return {
		id,
		name: entry.grammar.name,
		repo: entry.repo,
		commit,
		licenses: detections,
		notices,
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
	const branches = expected
		.split(/\s+OR\s+/i)
		.map((s) => s.trim())
		.filter(Boolean);
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

const RULE = "=".repeat(80);
const SUBRULE = "-".repeat(80);
const NOTICE_BANNER =
	"--------------------------------- NOTICE ---------------------------------------";

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
