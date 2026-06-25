#!/usr/bin/env node

import sade from "sade";
import { bootstrap } from "./commands/bootstrap.ts";

const prog = sade("my-cli");

prog.command("bootstrap").action(async () => {
	await bootstrap().run();
});

prog.parse(process.argv);
