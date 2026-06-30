// Shared primitives for fetching upstream grammar source and identifying
// its license files. Used by both the per-grammar build (build-grammar
// → fetch-license, populates dist/grammars/<lang>/) and the consolidated
// THIRD_PARTY_NOTICES generator. The cache at target/upstream-cache/<id>/
// is shared between the two so successive runs don't re-clone.

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { GrammarIndexEntry } from "./arborium-yaml.ts";
import { paths, run, runCapture } from "./util.ts";

/** Reject any askalono detection below this score as "not actually known". */
export const MIN_SCORE = 0.8;

/**
 * NOTICE-file filename pattern (Apache §4(d)). License-shaped filenames
 * are identified by askalono's own matcher; NOTICE files aren't licenses
 * and aren't in askalono's database, so we still recognize them by name.
 */
export const NOTICE_FILE_RE = /^NOTICE($|\.)/i;

/**
 * Sentinels in the arborium manifest meaning "this grammar is vendored
 * locally — there is no public upstream to clone." Tooling that hits one
 * of these should attribute under arborium's own license.
 */
export const LOCAL_SENTINELS = new Set(["local", "n/a"]);

/** SPDX expression arborium itself ships under; used for local grammars. */
export const ARBORIUM_LICENSE_EXPR = "MIT OR Apache-2.0";

export interface DetectedLicense {
	/** Filename relative to the source dir (depth-1, e.g. `LICENSE-MIT`). */
	file: string;
	/** SPDX identifier reported by askalono (e.g. `MIT`, `Apache-2.0`). */
	spdx: string;
	/** Confidence score in [0, 1]. */
	score: number;
	/** Verbatim file contents. */
	text: string;
}

export interface NoticeFile {
	file: string;
	text: string;
}

/** True if the grammar has no public upstream (local-only sentinel). */
export function isLocalGrammar(entry: GrammarIndexEntry): boolean {
	if (entry.repo && LOCAL_SENTINELS.has(entry.repo)) return true;
	if (entry.commit && LOCAL_SENTINELS.has(entry.commit)) return true;
	return false;
}

/** Cache directory for a grammar's upstream clone. */
export function cloneDirFor(id: string): string {
	return join(paths().targetDir, "upstream-cache", id);
}

interface AskalonoFileResult {
	path: string;
	result?: {
		score: number;
		license: { name: string; kind: string; aliases: string[] } | null;
		containing: unknown[];
	};
	error?: string;
}

/**
 * Post-detect SPDX upgrades. askalono returns a single best-match license
 * body and doesn't model SPDX exceptions (`License WITH Exception` is a
 * compound expression, not a single template). For files where the body
 * matches a known license but a recognized exception preamble is appended,
 * upgrade the SPDX id to the compound form.
 */
const SPDX_UPGRADES: ReadonlyArray<{
	base: string;
	suffix: string;
	pattern: RegExp;
}> = [
	{
		base: "Apache-2.0",
		suffix: "WITH LLVM-exception",
		pattern: /LLVM Exceptions to the Apache 2\.0 License/i,
	},
];

function upgradeSpdx(spdx: string, text: string): string {
	for (const u of SPDX_UPGRADES) {
		if (spdx === u.base && u.pattern.test(text)) {
			return `${u.base} ${u.suffix}`;
		}
	}
	return spdx;
}

async function isDir(path: string): Promise<boolean> {
	return stat(path)
		.then((s) => s.isDirectory())
		.catch(() => false);
}

/**
 * Ensure `cloneDir` contains a checkout of `repo` at `commit`. Idempotent:
 * if the directory already has the right commit checked out, returns
 * without touching the network.
 *
 * Strategy:
 *   `git init` + `git fetch --depth 1 origin <sha>` + `git checkout`,
 *   with a blobless full-clone fallback for forges that reject fetching
 *   arbitrary SHAs.
 */
export async function ensureClone(
	output: Writable,
	cloneDir: string,
	repo: string,
	commit: string | undefined,
): Promise<void> {
	if (commit && (await isDir(join(cloneDir, ".git")))) {
		try {
			const head = (
				await runCapture(output, "git", ["-C", cloneDir, "rev-parse", "HEAD"])
			).trim();
			if (head === commit) return;
		} catch {
			// fall through and re-clone
		}
	}

	await rm(cloneDir, { recursive: true, force: true });
	await mkdir(cloneDir, { recursive: true });

	if (commit) {
		try {
			await run(output, "git", ["init", "--quiet", cloneDir]);
			await run(output, "git", [
				"-C",
				cloneDir,
				"remote",
				"add",
				"origin",
				repo,
			]);
			await run(output, "git", [
				"-C",
				cloneDir,
				"fetch",
				"--depth",
				"1",
				"--no-tags",
				"origin",
				commit,
			]);
			await run(output, "git", [
				"-C",
				cloneDir,
				"-c",
				"advice.detachedHead=false",
				"checkout",
				"FETCH_HEAD",
			]);
			return;
		} catch {
			await rm(cloneDir, { recursive: true, force: true });
			await mkdir(cloneDir, { recursive: true });
		}

		await run(output, "git", [
			"clone",
			"--filter=blob:none",
			"--no-tags",
			repo,
			cloneDir,
		]);
		await run(output, "git", [
			"-C",
			cloneDir,
			"-c",
			"advice.detachedHead=false",
			"checkout",
			commit,
		]);
	} else {
		await run(output, "git", [
			"clone",
			"--depth",
			"1",
			"--no-tags",
			repo,
			cloneDir,
		]);
	}
}

/**
 * Run askalono crawl on `dir`, parse its line-delimited JSON output, and
 * filter to depth-1 hits only. askalono's `ignore`-crate walker recurses
 * indefinitely and also flags files it can't identify as errors; both
 * are dropped silently here so neither fails the caller.
 */
export async function detectLicenses(
	output: Writable,
	dir: string,
): Promise<DetectedLicense[]> {
	const stdout = await runCapture(output, "askalono", [
		"--format",
		"json",
		"crawl",
		dir,
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

		const rel = relativeFromDir(dir, obj.path);
		if (rel === undefined || rel.includes("/")) continue;

		if (obj.error || !obj.result?.license) continue;

		const text = await readFile(obj.path, "utf8");
		out.push({
			file: rel,
			spdx: upgradeSpdx(obj.result.license.name, text),
			score: obj.result.score,
			text,
		});
	}
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Depth-1 walk for upstream NOTICE files (Apache §4(d) attribution). */
export async function findNoticeFiles(dir: string): Promise<NoticeFile[]> {
	return (
		await Promise.all(
			(
				await readdir(dir, { withFileTypes: true })
			)
				.filter((e) => e.isFile() && NOTICE_FILE_RE.test(e.name))
				.map(async (e) => ({
					file: e.name,
					text: await readFile(join(dir, e.name), "utf8"),
				})),
		)
	).sort((a, b) => a.file.localeCompare(b.file));
}

function relativeFromDir(dir: string, abs: string): string | undefined {
	const norm = (s: string) => s.replace(/\/+$/, "");
	const root = norm(dir);
	const candidate = norm(abs);
	if (!candidate.startsWith(`${root}/`)) return undefined;
	return candidate.slice(root.length + 1);
}
