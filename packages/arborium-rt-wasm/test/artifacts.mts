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
export const MARKDOWN_INLINE_GRAMMAR_WASM = resolve(
	repoRoot,
	"target/grammars/markdown_inline/tree-sitter-markdown_inline.wasm",
);
export const MARKDOWN_INLINE_HIGHLIGHTS_SCM = resolve(
	repoRoot,
	"target/grammars/markdown_inline/highlights.scm",
);
export const MARKDOWN_INLINE_INJECTIONS_SCM = resolve(
	repoRoot,
	"target/grammars/markdown_inline/injections.scm",
);
export const HTML_GRAMMAR_WASM = resolve(
	repoRoot,
	"target/grammars/html/tree-sitter-html.wasm",
);
export const HTML_HIGHLIGHTS_SCM = resolve(
	repoRoot,
	"target/grammars/html/highlights.scm",
);
export const HTML_INJECTIONS_SCM = resolve(
	repoRoot,
	"target/grammars/html/injections.scm",
);
export const CSS_GRAMMAR_WASM = resolve(
	repoRoot,
	"target/grammars/css/tree-sitter-css.wasm",
);
export const CSS_HIGHLIGHTS_SCM = resolve(
	repoRoot,
	"target/grammars/css/highlights.scm",
);
export const JAVASCRIPT_GRAMMAR_WASM = resolve(
	repoRoot,
	"target/grammars/javascript/tree-sitter-javascript.wasm",
);
export const JAVASCRIPT_HIGHLIGHTS_SCM = resolve(
	repoRoot,
	"target/grammars/javascript/highlights.scm",
);
export const JAVASCRIPT_INJECTIONS_SCM = resolve(
	repoRoot,
	"target/grammars/javascript/injections.scm",
);
