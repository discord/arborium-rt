#!/usr/bin/env node

import { Listr } from "listr2";
import sade from "sade";
import { bootstrap } from "./commands/bootstrap.ts";
import { buildGrammar } from "./commands/build/grammar.ts";
import { buildHost } from "./commands/build/host.ts";
import { buildNode } from "./commands/build/node.ts";
import { buildPackage } from "./commands/build/package.ts";
import { buildWasm } from "./commands/build/wasm.ts";
import { buildAll } from "./commands/build.ts";

const prog = sade("arborium-rt");

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

prog.command("build package <group> <lang>").action(async (group, lang) => {
	await new Listr(buildPackage({ group, lang })).run();
});

prog.parse(process.argv);
