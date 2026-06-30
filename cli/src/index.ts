#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Listr } from "listr2";
import sade from "sade";
import { applyPatches, bootstrap } from "./commands/bootstrap.ts";
import { buildGrammar } from "./commands/build/grammar.ts";
import { buildHost } from "./commands/build/host.ts";
import { buildNode } from "./commands/build/node.ts";
import { buildWasm } from "./commands/build/wasm.ts";
import { buildAll } from "./commands/build.ts";
import { packageGrammars } from "./commands/package/grammars.ts";
import { packageHost } from "./commands/package/host.ts";
import { buildGrammarIndex } from "./lib/arborium-yaml.ts";
import { paths } from "./lib/util.ts";
import { writeThirdPartyNotices } from "./lib/write-third-party-notices.ts";

function cliVersion(): string {
	const pkgPath = join(paths().cliPackageDir, "package.json");
	return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string })
		.version;
}

const prog = sade("arborium-rt").version(cliVersion());

prog.command("bootstrap").action(async () => {
	await bootstrap().run();
});

prog
	.command("apply-patches")
	.describe(
		"reset submodules + apply patches + render Cargo.toml (no tree-sitter CLI build)",
	)
	.action(async () => {
		await applyPatches().run();
	});

prog
	.command("build")
	.describe("build + package every grammar in the corpus (default: all)")
	.option("--group", "only build grammars in this arborium group")
	.option("--only", "comma-separated grammar ids to build")
	.option("-j, --jobs", "max concurrent grammar builds")
	.action(async (opts) => {
		const only =
			typeof opts.only === "string"
				? opts.only
						.split(",")
						.map((s: string) => s.trim())
						.filter(Boolean)
				: undefined;
		const jobs =
			opts.jobs !== undefined ? Number.parseInt(String(opts.jobs), 10) : undefined;
		await buildAll({
			...(only && only.length > 0 ? { only } : {}),
			...(opts.group ? { group: String(opts.group) } : {}),
			...(jobs !== undefined && Number.isFinite(jobs) ? { jobs } : {}),
		}).run();
	});

prog
	.command("list-groups")
	.describe("print arborium groups with at least one buildable grammar")
	.option("--json", "emit the group list as a JSON array")
	.action(async (opts) => {
		const index = await buildGrammarIndex(paths().langsRoots);
		const groups = [
			...new Set([...index.values()].map((e) => e.group)),
		].sort();
		if (opts.json) {
			process.stdout.write(`${JSON.stringify(groups)}\n`);
		} else {
			for (const g of groups) process.stdout.write(`${g}\n`);
		}
	});

prog.command("build wasm").action(async () => {
	await buildWasm().run();
});

prog.command("build host").action(async () => {
	await buildHost().run();
});

prog.command("build grammar <group> <lang>").action(async (group, lang) => {
	await new Listr(buildGrammar({ group, lang })).run();
});

prog
	.command("build node")
	.option("skip-grammars")
	.action(async (options) => {
		await buildNode(options).run();
	});

prog
	.command("package grammars")
	.describe("package built grammars into dist/, then regenerate (default: all)")
	.example("package grammars          # package every built grammar")
	.example("package grammars json css # package only these grammars")
	.action(async (opts) => {
		const only = opts._.length > 0 ? (opts._ as string[]) : undefined;
		await packageGrammars(only ? { only } : {}).run();
	});

prog
	.command("package host")
	.describe("package built host + runtime wasms into dist/ for publish/testing")
	.action(async () => {
		await packageHost().run();
	});

prog
	.command("notices")
	.describe(
		"regenerate THIRD_PARTY_NOTICES from each grammar's upstream license",
	)
	.action(async () => {
		await new Listr(writeThirdPartyNotices()).run();
	});

prog.parse(process.argv);
