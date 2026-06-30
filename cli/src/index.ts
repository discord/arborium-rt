#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Listr } from "listr2";
import sade from "sade";
import { applyPatches, bootstrap } from "./commands/bootstrap.ts";
import { buildNodeGrammars } from "./commands/build/node/grammars.ts";
import { buildNode } from "./commands/build/node/index.ts";
import { buildGrammar } from "./commands/build/wasm/grammar.ts";
import { buildAll } from "./commands/build/wasm/grammars.ts";
import { buildWasmHost } from "./commands/build/wasm/host.ts";
import { buildWasmRuntime } from "./commands/build/wasm/runtime.ts";
import { packageGrammars } from "./commands/package/wasm/grammars.ts";
import { packageWasmHost } from "./commands/package/wasm/host.ts";
import { buildGrammarIndex } from "./lib/arborium-yaml.ts";
import { paths } from "./lib/util.ts";
import { writeThirdPartyNotices } from "./lib/write-third-party-notices.ts";

function cliVersion(): string {
	const pkgPath = join(paths().cliPackageDir, "package.json");
	return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string })
		.version;
}

/** Treat any trailing positional args as an explicit grammar-id filter. */
function idsFilter(opts: { _: string[] }): string[] | undefined {
	return opts._.length > 0 ? opts._ : undefined;
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
	.command("list-groups")
	.describe("print arborium groups with at least one buildable grammar")
	.option("--json", "emit the group list as a JSON array")
	.action(async (opts) => {
		const index = await buildGrammarIndex(paths().langsRoots);
		const groups = [...new Set([...index.values()].map((e) => e.group))].sort();
		if (opts.json) {
			process.stdout.write(`${JSON.stringify(groups)}\n`);
		} else {
			for (const g of groups) process.stdout.write(`${g}\n`);
		}
	});

// Parent group for the wasm-platform build subcommands. Registering it gives
// `build wasm` a help landing that lists the subcommands; the subcommands
// (`build wasm runtime`, `build wasm host`, `build wasm grammar[s]`) route on
// their own since no shorter `build`/`build wasm` command short-circuits the
// lookup.
prog
	.command("build wasm")
	.describe(
		"build wasm-platform artifacts; pass `runtime`, `host`, or `grammar[s]`",
	)
	.action(() => {
		prog.help("build wasm");
	});

prog
	.command("build wasm runtime")
	.describe("build the Rust SIDE_MODULE runtime wasm (needs emcc)")
	.action(async () => {
		await buildWasmRuntime().run();
	});

prog
	.command("build wasm host")
	.describe("build the MAIN_MODULE host wasm + .mjs loader (needs emcc)")
	.action(async () => {
		await buildWasmHost().run();
	});

prog
	.command("build wasm grammars")
	.describe(
		"build + package every browser grammar in the corpus (default: all)",
	)
	.option("--group", "only build grammars in this arborium group")
	.example("build wasm grammars              # build every grammar")
	.example("build wasm grammars json css     # build only these grammars")
	.example("build wasm grammars --group group-acorn")
	.action(async (opts) => {
		const only = idsFilter(opts);
		await buildAll({
			...(only ? { only } : {}),
			...(opts.group ? { group: String(opts.group) } : {}),
		}).run();
	});

prog
	.command("build wasm grammar <group> <lang>")
	.describe("build one browser grammar end-to-end (wasm + flattened queries)")
	.action(async (group, lang) => {
		await new Listr(buildGrammar({ group, lang })).run();
	});

prog
	.command("build node")
	.describe(
		"link the Node addon (for the host platform) from grammar sources staged by `build node grammars`",
	)
	.action(async () => {
		await buildNode().run();
	});

prog
	.command("build node grammars")
	.describe(
		"stage Node grammar sources (parser.c + scanner + queries); link with `build node`",
	)
	.option("--group", "only stage grammars in this arborium group")
	.example("build node grammars                    # stage every grammar")
	.example(
		"build node grammars json markdown      # restrict to these grammars",
	)
	.example("build node grammars --group group-acorn # one staging shard")
	.action(async (opts) => {
		const only = idsFilter(opts);
		await new Listr(
			buildNodeGrammars({
				...(only ? { only } : {}),
				...(opts.group ? { group: String(opts.group) } : {}),
			}),
		).run();
	});

prog
	.command("package wasm grammars")
	.describe("package built grammars into dist/, then regenerate (default: all)")
	.example("package wasm grammars          # package every built grammar")
	.example("package wasm grammars json css # package only these grammars")
	.action(async (opts) => {
		const only = opts._.length > 0 ? (opts._ as string[]) : undefined;
		await packageGrammars(only ? { only } : {}).run();
	});

prog
	.command("package wasm host")
	.describe("package built host + runtime wasms into dist/ for publish/testing")
	.action(async () => {
		await packageWasmHost().run();
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
