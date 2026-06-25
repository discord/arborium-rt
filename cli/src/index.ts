#!/usr/bin/env node

import sade from "sade";
import { bootstrap } from "./commands/bootstrap.ts";
import { buildGrammar } from "./commands/build/grammar.ts";
import { buildHost } from "./commands/build/host.ts";
import { buildWasm } from "./commands/build/wasm.ts";

const prog = sade("arborium-rt");

prog.command("bootstrap").action(async () => {
	await bootstrap().run();
});

prog.command("build wasm").action(async () => {
	await buildWasm().run();
});

prog.command("build host").action(async () => {
	await buildHost().run();
});

prog.command("build grammar <group> <lang>").action(async (group, lang) => {
	await buildGrammar({ group, lang }).run();
});

prog.parse(process.argv);
