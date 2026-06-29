#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Listr } from "listr2";
import sade from "sade";
import { bootstrap } from "./commands/bootstrap.ts";
import { buildGrammar } from "./commands/build/grammar.ts";
import { buildHost } from "./commands/build/host.ts";
import { buildNode } from "./commands/build/node.ts";
import { buildWasm } from "./commands/build/wasm.ts";
import { buildAll } from "./commands/build.ts";
import { packageGrammars } from "./commands/package/grammars.ts";
import { packageHost } from "./commands/package/host.ts";
import { paths } from "./util.ts";
import { writeThirdPartyNotices } from "./write-third-party-notices.ts";

function cliVersion(): string {
	const pkgPath = join(paths().cliPackageDir, "package.json");
	return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string })
		.version;
}

const prog = sade("arborium-rt").version(cliVersion());

prog.command("bootstrap").action(async () => {
	await bootstrap().run();
});

prog.command("build").action(async () => {
	await buildAll().run();
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
	.describe("regenerate THIRD_PARTY_NOTICES from each grammar's upstream license")
	.action(async () => {
		await writeThirdPartyNotices();
	});

prog.parse(process.argv);
