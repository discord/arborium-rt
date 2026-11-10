// Theme slots the runtime can emit, mirroring `ThemeSlot::tag` and
// `tag_to_name` in third_party/arborium/crates/arborium-theme/src/highlights.rs.
// arborium-rt ships no theme CSS, so the playground supplies its own: each
// entry styles both the custom-element form (`<a-k>`) and the class-name
// form (`<span class="keyword">`) of the same slot.

interface TagStyle {
	readonly tag: string;
	readonly name: string;
	readonly css: string;
}

export const TAGS: readonly TagStyle[] = [
	{ tag: "k", name: "keyword", css: "color: #bb9af7" },
	{ tag: "f", name: "function", css: "color: #7aa2f7" },
	{ tag: "s", name: "string", css: "color: #9ece6a" },
	{ tag: "c", name: "comment", css: "color: #6b7280; font-style: italic" },
	{ tag: "t", name: "type", css: "color: #2ac3de" },
	{ tag: "v", name: "variable", css: "color: #c0caf5" },
	{ tag: "co", name: "constant", css: "color: #ff9e64" },
	{ tag: "n", name: "number", css: "color: #ff9e64" },
	{ tag: "o", name: "operator", css: "color: #89ddff" },
	{ tag: "p", name: "punctuation", css: "color: #9aa5ce" },
	{ tag: "pr", name: "property", css: "color: #73daca" },
	{ tag: "at", name: "attribute", css: "color: #e0af68" },
	{ tag: "tg", name: "tag", css: "color: #f7768e" },
	{ tag: "m", name: "macro", css: "color: #7dcfff" },
	{ tag: "l", name: "label", css: "color: #e0af68" },
	{ tag: "ns", name: "namespace", css: "color: #2ac3de" },
	{ tag: "cr", name: "constructor", css: "color: #e0af68" },
	{ tag: "tt", name: "title", css: "color: #7aa2f7; font-weight: bold" },
	{ tag: "st", name: "strong", css: "font-weight: bold" },
	{ tag: "em", name: "emphasis", css: "font-style: italic" },
	{
		tag: "tu",
		name: "link",
		css: "color: #73daca; text-decoration: underline",
	},
	{ tag: "tl", name: "literal", css: "color: #9ece6a" },
	{ tag: "tx", name: "strikethrough", css: "text-decoration: line-through" },
	{ tag: "da", name: "diff-add", css: "color: #9ece6a; background: #9ece6a1a" },
	{
		tag: "dd",
		name: "diff-delete",
		css: "color: #f7768e; background: #f7768e1a",
	},
	{ tag: "eb", name: "embedded", css: "color: #c0caf5" },
	{
		tag: "er",
		name: "error",
		css: "text-decoration: wavy underline #f7768e",
	},
];

const NAME_BY_TAG = new Map(TAGS.map((t) => [t.tag, t.name]));
const TAG_BY_NAME = new Map(TAGS.map((t) => [t.name, t.tag]));

export const tagName = (tag: string): string | undefined =>
	NAME_BY_TAG.get(tag);
export const tagForName = (name: string): string | undefined =>
	TAG_BY_NAME.get(name);

export function themeCss(): string {
	return TAGS.map(
		(t) =>
			`.code a-${t.tag}, .code .${t.name}, .legend a-${t.tag} { ${t.css} }`,
	).join("\n");
}
