import {
	type BundledGrammarId,
	GRAMMARS,
	type Grammar,
	loadArboriumRuntime,
	type Runtime,
	type Session,
	type ThemedSpan,
} from "@discord/arborium-rt-wasm";
import { SAMPLES } from "./samples.ts";
import { TAGS, TOKEN_CLASS, tagClass, tagForName, tagName } from "./tags.ts";

// ── DOM ──────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing #${id}`);
	return el as T;
};

const statusEl = $<HTMLSpanElement>("status");
const languageEl = $<HTMLSelectElement>("language");
const outputEl = $<HTMLSelectElement>("output");
const depthEl = $<HTMLInputElement>("depth");
const autoloadEl = $<HTMLInputElement>("autoload");
const sourceEl = $<HTMLTextAreaElement>("source");
const resultEl = $<HTMLPreElement>("result");
const statsEl = $<HTMLDListElement>("stats");
const rawEl = $<HTMLPreElement>("raw");

$<HTMLDivElement>("legend").innerHTML = TAGS.map(
	(t) =>
		`<div><span class="inline-block min-w-8 text-zinc-500 dark:text-zinc-400">${t.tag}</span><a-${t.tag} class="${t.className}">${t.name}</a-${t.tag}></div>`,
).join("");

// ── Grammar resolution ──────────────────────────────────────────────────

const GRAMMAR_IDS = Object.keys(GRAMMARS).sort() as BundledGrammarId[];

// Injection queries name languages the way authors write them (markdown
// fences say `js`, not `javascript`). The runtime resolves injections by the
// name a grammar was *registered* under, so an alias is loaded as its own
// registration of the target grammar's assets.
const ALIASES: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	node: "javascript",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	py: "python",
	python3: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	shell: "bash",
	console: "bash",
	yml: "yaml",
	md: "markdown",
	cs: "c-sharp",
	csharp: "c-sharp",
	"c#": "c-sharp",
	"c++": "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	h: "c",
	kt: "kotlin",
	kts: "kotlin",
	golang: "go",
	ex: "elixir",
	exs: "elixir",
	erl: "erlang",
	hs: "haskell",
	ml: "ocaml",
	pl: "perl",
	ps1: "powershell",
	pwsh: "powershell",
	tf: "hcl",
	terraform: "hcl",
	docker: "dockerfile",
	htm: "html",
	xhtml: "html",
	svg: "xml",
	"objective-c": "objc",
	objectivec: "objc",
	jl: "julia",
	clj: "clojure",
	el: "elisp",
	"emacs-lisp": "elisp",
	lisp: "commonlisp",
	scm: "scheme",
	vimscript: "vim",
	viml: "vim",
	jinja: "jinja2",
	typ: "typst",
	sol: "solidity",
	patch: "diff",
};

const isGrammarId = (id: string): id is BundledGrammarId => id in GRAMMARS;

function resolveGrammarId(name: string): BundledGrammarId | undefined {
	const lower = name.trim().toLowerCase();
	for (const candidate of [
		lower,
		ALIASES[lower],
		lower.replaceAll("-", "_"),
		lower.replaceAll("_", "-"),
	]) {
		if (candidate && isGrammarId(candidate)) return candidate;
	}
	return undefined;
}

// ── Runtime state ───────────────────────────────────────────────────────

let runtime: Runtime;
/** Registered name → grammar. A name is registered at most once. */
const grammars = new Map<string, Promise<Grammar>>();
/** Names we tried to load for an injection and couldn't. */
const failedInjections = new Map<string, string>();
/** One long-lived session per primary grammar id. */
const sessions = new Map<string, Session>();

function ensureGrammar(name: string, id: BundledGrammarId): Promise<Grammar> {
	let grammar = grammars.get(name);
	if (!grammar) {
		grammar = runtime.loadGrammar({ ...GRAMMARS[id], languageId: name });
		grammars.set(name, grammar);
		// Let a failed load be retried rather than caching the rejection.
		grammar.catch(() => grammars.delete(name));
	}
	return grammar;
}

function sessionFor(id: string, grammar: Grammar): Session {
	let session = sessions.get(id);
	if (!session) {
		session = grammar.createSession();
		sessions.set(id, session);
	}
	return session;
}

// ── Highlighting ────────────────────────────────────────────────────────

interface Outcome {
	kind: "spans" | "html";
	spans: ThemedSpan[];
	html: string;
	missingInjections: string[];
	outOfFuelLanguages: string[];
	fuelUsed: number;
	highlightMs: number;
	totalMs: number;
	loaded: string[];
}

let runId = 0;

async function highlight(): Promise<void> {
	const token = ++runId;
	const id = languageEl.value;
	if (!isGrammarId(id)) return;
	const text = sourceEl.value;
	const output = outputEl.value;
	const maxInjectionDepth = Math.max(
		0,
		Math.min(32, depthEl.valueAsNumber || 0),
	);
	const started = performance.now();
	const loaded: string[] = [];

	try {
		const grammar = await ensureGrammar(id, id);
		if (token !== runId) return;
		const session = sessionFor(id, grammar);
		session.setText(text);

		for (;;) {
			const t0 = performance.now();
			const result =
				output === "spans"
					? { ...session.highlightToSpans({ maxInjectionDepth }), html: "" }
					: {
							...session.highlightToHtml({
								maxInjectionDepth,
								format: {
									kind:
										output === "class-names"
											? "class-names"
											: "custom-elements",
								},
							}),
							spans: [],
						};
			const highlightMs = performance.now() - t0;

			const toLoad = autoloadEl.checked
				? result.missingInjections.filter((n) => !failedInjections.has(n))
				: [];
			if (toLoad.length === 0) {
				render(text, {
					kind: output === "spans" ? "spans" : "html",
					...result,
					highlightMs,
					totalMs: performance.now() - started,
					loaded,
				});
				return;
			}

			await Promise.all(
				toLoad.map(async (name) => {
					const target = resolveGrammarId(name);
					if (!target) {
						failedInjections.set(name, "no bundled grammar");
						return;
					}
					try {
						await ensureGrammar(name, target);
						loaded.push(name === target ? name : `${name}→${target}`);
					} catch (err) {
						failedInjections.set(name, String(err));
					}
				}),
			);
			if (token !== runId) return;
			// A newer run may have reused this session for different text
			// while we were loading; restore ours before re-highlighting.
			session.setText(text);
		}
	} catch (err) {
		if (token !== runId) return;
		console.error(err);
		setStatus(`Highlight failed: ${err}`, true);
	}
}

const escapeHtml = (s: string): string =>
	s.replace(
		/[&<>"]/g,
		(c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`,
	);

/**
 * Render themed spans client-side. Spans may nest (injections inside
 * injections), so paint each code unit with the innermost span covering it —
 * the same innermost-wins rule the runtime's HTML renderer uses.
 */
function renderSpans(text: string, spans: readonly ThemedSpan[]): string {
	const owner = new Int32Array(text.length).fill(-1);
	const byLengthDesc = spans
		.map((span, index) => ({ span, index }))
		.sort((a, b) => b.span.end - b.span.start - (a.span.end - a.span.start));
	for (const { span, index } of byLengthDesc) {
		owner.fill(index, Math.max(0, span.start), Math.min(text.length, span.end));
	}

	let html = "";
	let runStart = 0;
	for (let pos = 1; pos <= text.length; pos++) {
		if (pos < text.length && owner[pos] === owner[runStart]) continue;
		const chunk = escapeHtml(text.slice(runStart, pos));
		const span = spans[owner[runStart] ?? -1];
		if (span && /^[a-z]+$/.test(span.tag)) {
			const title = `${tagName(span.tag) ?? "?"} (${span.tag}) · ${span.start}–${span.end}`;
			html += `<a-${span.tag} class="${TOKEN_CLASS} ${tagClass(span.tag)}" title="${title}">${chunk}</a-${span.tag}>`;
		} else {
			html += chunk;
		}
		runStart = pos;
	}
	return html;
}

/**
 * Theme runtime-rendered HTML and add hover titles, so either format looks and
 * behaves like the spans view.
 */
function annotateHtml(root: HTMLElement): void {
	for (const el of root.querySelectorAll<HTMLElement>("*")) {
		const element = el.tagName.toLowerCase();
		const tag = element.startsWith("a-")
			? element.slice(2)
			: tagForName(el.className);
		if (!tag) continue;
		el.className = `${el.className} ${TOKEN_CLASS} ${tagClass(tag)}`;
		el.title = `${tagName(tag) ?? "?"} (${tag})`;
	}
}

function render(text: string, out: Outcome): void {
	if (out.kind === "spans") {
		resultEl.innerHTML = renderSpans(text, out.spans);
		rawEl.textContent = out.spans
			.map(
				(s) =>
					`${String(s.start).padStart(6)}–${String(s.end).padEnd(6)} ${s.tag.padEnd(3)} ${JSON.stringify(text.slice(s.start, s.end))}`,
			)
			.join("\n");
	} else {
		resultEl.innerHTML = out.html;
		annotateHtml(resultEl);
		rawEl.textContent = out.html;
	}

	const unresolved = out.missingInjections.map((n) => {
		const why = failedInjections.get(n);
		return why ? `${n} (${why})` : n;
	});
	const stats: [string, string, boolean?][] = [
		["highlight", `${out.highlightMs.toFixed(2)} ms`],
		["total", `${out.totalMs.toFixed(1)} ms`],
		out.kind === "spans"
			? ["spans", String(out.spans.length)]
			: ["html", `${out.html.length} chars`],
		["fuel", out.fuelUsed.toLocaleString()],
		[
			"out of fuel",
			out.outOfFuelLanguages.join(", ") || "—",
			out.outOfFuelLanguages.length > 0,
		],
		["missing injections", unresolved.join(", ") || "—", unresolved.length > 0],
		["loaded now", out.loaded.join(", ") || "—"],
		["registered", [...grammars.keys()].sort().join(", ")],
	];
	statsEl.innerHTML = stats
		.map(
			([k, v, bad]) =>
				`<div class="flex gap-1.5"><dt class="text-zinc-500 dark:text-zinc-400">${k}</dt><dd${bad ? ' class="text-red-600 dark:text-red-400"' : ""}>${escapeHtml(v)}</dd></div>`,
		)
		.join("");
	setStatus(`Ready · ${GRAMMAR_IDS.length} grammars bundled`);
}

function setStatus(text: string, error = false): void {
	statusEl.textContent = text;
	statusEl.toggleAttribute("data-error", error);
}

// ── Persistence (URL hash, then localStorage) ───────────────────────────

const STORAGE_KEY = "arborium-rt-playground";

interface State {
	lang: string;
	code: string;
}

const encode = (s: string): string =>
	btoa(String.fromCharCode(...new TextEncoder().encode(s)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
const decode = (s: string): string =>
	new TextDecoder().decode(
		Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
			c.charCodeAt(0),
		),
	);

function loadState(): State | undefined {
	const params = new URLSearchParams(location.hash.slice(1));
	const lang = params.get("lang");
	if (lang) {
		try {
			return { lang, code: decode(params.get("code") ?? "") };
		} catch {
			return { lang, code: "" };
		}
	}
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		return saved ? (JSON.parse(saved) as State) : undefined;
	} catch {
		return undefined;
	}
}

function saveState(): void {
	const state: State = { lang: languageEl.value, code: sourceEl.value };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function shareLink(): string {
	const params = new URLSearchParams({
		lang: languageEl.value,
		code: encode(sourceEl.value),
	});
	return `${location.origin}${location.pathname}#${params}`;
}

// ── Wiring ──────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | undefined;
function schedule(): void {
	clearTimeout(timer);
	timer = setTimeout(() => {
		saveState();
		void highlight();
	}, 30);
}

const isSample = (text: string): boolean =>
	text.trim() === "" || Object.values(SAMPLES).includes(text);

function loadSample(): void {
	sourceEl.value = SAMPLES[languageEl.value] ?? "";
	sourceEl.placeholder = `No built-in sample for ${languageEl.value}; paste some code.`;
	schedule();
}

languageEl.addEventListener("change", () => {
	// Keep custom code when switching (handy for comparing grammars on the
	// same input); swap only if the editor still holds a stock sample.
	if (isSample(sourceEl.value)) loadSample();
	else schedule();
});
$<HTMLButtonElement>("sample").addEventListener("click", loadSample);
for (const el of [outputEl, depthEl, autoloadEl]) {
	el.addEventListener("change", schedule);
}
sourceEl.addEventListener("input", schedule);
sourceEl.addEventListener("keydown", (e) => {
	if (e.key !== "Tab" || e.shiftKey || e.metaKey || e.ctrlKey) return;
	e.preventDefault();
	// execCommand keeps the edit on the textarea's undo stack.
	if (!document.execCommand("insertText", false, "\t")) {
		sourceEl.setRangeText(
			"\t",
			sourceEl.selectionStart,
			sourceEl.selectionEnd,
			"end",
		);
		schedule();
	}
});
$<HTMLButtonElement>("share").addEventListener("click", async (e) => {
	const button = e.currentTarget as HTMLButtonElement;
	const link = shareLink();
	history.replaceState(null, "", link);
	try {
		await navigator.clipboard.writeText(link);
		button.textContent = "Copied!";
	} catch {
		button.textContent = "Link in URL bar";
	}
	setTimeout(() => {
		button.textContent = "Copy link";
	}, 1500);
});

// Keep the two panes' scroll positions roughly in step.
sourceEl.addEventListener("scroll", () => {
	resultEl.scrollTop = sourceEl.scrollTop;
	resultEl.scrollLeft = sourceEl.scrollLeft;
});

async function main(): Promise<void> {
	languageEl.innerHTML = GRAMMAR_IDS.map(
		(id) => `<option value="${id}">${id}</option>`,
	).join("");

	const state = loadState();
	const fallback = isGrammarId("markdown") ? "markdown" : GRAMMAR_IDS[0];
	languageEl.value =
		state && isGrammarId(state.lang) ? state.lang : (fallback ?? "");
	if (state?.code) sourceEl.value = state.code;
	else sourceEl.value = SAMPLES[languageEl.value] ?? "";

	if (GRAMMAR_IDS.length === 0) {
		setStatus(
			"No grammars bundled — run `./scripts/arborium-rt package wasm grammars` first.",
			true,
		);
		return;
	}

	try {
		const t0 = performance.now();
		runtime = await loadArboriumRuntime();
		setStatus(`Runtime loaded in ${(performance.now() - t0).toFixed(0)} ms`);
	} catch (err) {
		console.error(err);
		setStatus(`Failed to load runtime: ${err}`, true);
		return;
	}
	languageEl.disabled = false;
	await highlight();
}

void main();
