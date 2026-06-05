import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

export const JSON_GRAMMAR_WASM = resolve(
	repoRoot,
	"target/grammars/json/tree-sitter-json.wasm",
);
export const JSON_HIGHLIGHTS_SCM = resolve(
	repoRoot,
	"third_party/arborium/langs/group-acorn/json/def/queries/highlights.scm",
);
export const KOTLIN_GRAMMAR_WASM = resolve(
	repoRoot,
	"target/grammars/kotlin/tree-sitter-kotlin.wasm",
);
// Read the post-flatten output from target/grammars rather than the raw
// submodule source, so the test sees what the build pipeline actually ships
// — this matters in CI where the `package` job downloads the artifact built
// by the `grammars` job and never re-flattens.
export const KOTLIN_HIGHLIGHTS_SCM = resolve(
	repoRoot,
	"target/grammars/kotlin/highlights.scm",
);
export const MARKDOWN_GRAMMAR_WASM = resolve(
	repoRoot,
	"target/grammars/markdown/tree-sitter-markdown.wasm",
);
export const MARKDOWN_HIGHLIGHTS_SCM = resolve(
	repoRoot,
	"target/grammars/markdown/highlights.scm",
);
export const MARKDOWN_INJECTIONS_SCM = resolve(
	repoRoot,
	"target/grammars/markdown/injections.scm",
);
