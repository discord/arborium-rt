// Theme slots the runtime can emit, mirroring `ThemeSlot::tag` and
// `tag_to_name` in third_party/arborium/crates/arborium-theme/src/highlights.rs.
// arborium-rt ships no theme CSS, so the playground supplies its own: each
// slot maps to Tailwind classes (a light and a `dark:` colour from the default
// palette) that the page adds to every token element it renders, whether it
// is the custom-element form (`<a-k>`) or the class-name form
// (`<span class="keyword">`). Keep these as complete literal class strings so
// Tailwind's source scan picks them up.

interface TagStyle {
	readonly tag: string;
	readonly name: string;
	readonly className: string;
}

export const TAGS: readonly TagStyle[] = [
	{
		tag: "k",
		name: "keyword",
		className: "text-violet-700 dark:text-violet-300",
	},
	{ tag: "f", name: "function", className: "text-blue-700 dark:text-blue-300" },
	{ tag: "s", name: "string", className: "text-green-700 dark:text-green-300" },
	{ tag: "c", name: "comment", className: "text-zinc-500 italic" },
	{ tag: "t", name: "type", className: "text-cyan-700 dark:text-cyan-300" },
	{
		tag: "v",
		name: "variable",
		className: "text-zinc-900 dark:text-indigo-100",
	},
	{
		tag: "co",
		name: "constant",
		className: "text-orange-700 dark:text-orange-300",
	},
	{
		tag: "n",
		name: "number",
		className: "text-orange-700 dark:text-orange-300",
	},
	{ tag: "o", name: "operator", className: "text-sky-700 dark:text-sky-300" },
	{
		tag: "p",
		name: "punctuation",
		className: "text-slate-500 dark:text-slate-400",
	},
	{
		tag: "pr",
		name: "property",
		className: "text-teal-700 dark:text-teal-300",
	},
	{
		tag: "at",
		name: "attribute",
		className: "text-amber-700 dark:text-amber-300",
	},
	{ tag: "tg", name: "tag", className: "text-rose-700 dark:text-rose-300" },
	{ tag: "m", name: "macro", className: "text-sky-700 dark:text-sky-300" },
	{ tag: "l", name: "label", className: "text-amber-700 dark:text-amber-300" },
	{
		tag: "ns",
		name: "namespace",
		className: "text-cyan-700 dark:text-cyan-300",
	},
	{
		tag: "cr",
		name: "constructor",
		className: "text-amber-700 dark:text-amber-300",
	},
	{
		tag: "tt",
		name: "title",
		className: "font-bold text-blue-700 dark:text-blue-300",
	},
	{ tag: "st", name: "strong", className: "font-bold" },
	{ tag: "em", name: "emphasis", className: "italic" },
	{
		tag: "tu",
		name: "link",
		className: "text-teal-700 underline dark:text-teal-300",
	},
	{
		tag: "tl",
		name: "literal",
		className: "text-green-700 dark:text-green-300",
	},
	{ tag: "tx", name: "strikethrough", className: "line-through" },
	{
		tag: "da",
		name: "diff-add",
		className: "bg-green-500/10 text-green-700 dark:text-green-300",
	},
	{
		tag: "dd",
		name: "diff-delete",
		className: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
	},
	{
		tag: "eb",
		name: "embedded",
		className: "text-zinc-900 dark:text-indigo-100",
	},
	{
		tag: "er",
		name: "error",
		className: "underline decoration-rose-500 decoration-wavy",
	},
];

/** Added to every rendered token so hovering shows what the runtime emitted. */
export const TOKEN_CLASS =
	"rounded-xs hover:outline hover:outline-zinc-400 dark:hover:outline-zinc-600";

const BY_TAG = new Map(TAGS.map((t) => [t.tag, t]));
const TAG_BY_NAME = new Map(TAGS.map((t) => [t.name, t.tag]));

export const tagName = (tag: string): string | undefined =>
	BY_TAG.get(tag)?.name;
export const tagClass = (tag: string): string =>
	BY_TAG.get(tag)?.className ?? "";
export const tagForName = (name: string): string | undefined =>
	TAG_BY_NAME.get(name);
