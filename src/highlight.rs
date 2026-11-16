//! Full parse + highlight pipeline, executed synchronously in-process.
//!
//! Input: a `session_id` whose primary text has been loaded via
//! [`crate::registry::Registry::set_text`]. Output: either a `Vec` of themed
//! spans (dedup'd, coalesced, UTF-16 offsets) or a fully rendered HTML
//! string. In both cases the pipeline handles language injections
//! recursively, looking injected languages up in the registry by name.
//!
//! The structure mirrors `arborium_highlight::HighlighterCore` upstream,
//! but avoids the async `GrammarProvider` trait — grammar lookups here are
//! just `HashMap` hits, so there's no reason to drag a poll-based wrapper
//! through the runtime. HTML rendering goes through this module's own
//! `tagged_spans_to_html` rather than `arborium_highlight::spans_to_html`:
//! the upstream renderer dedups the *raw* span set internally, which
//! mis-resolves the overlapping captures recursive injection produces at
//! depth >= 2. Rendering from the already-resolved (`dedup_and_tag` +
//! `coalesce_by_tag`) spans instead keeps HTML output lock-step with the
//! themed-span output.

use std::collections::{HashMap, HashSet};

use arborium_highlight::{HtmlFormat, Span, html_escape};
use arborium_plugin_runtime::FuelSpent;
use arborium_theme::{tag_for_capture, tag_to_name};
use arborium_wire::{Utf8Injection, Utf8ParseResult};
use serde::Serialize;

use crate::registry::Registry;

/// Hard upper bound for recursion depth even when a caller passes a huge
/// value — prevents pathological grammars from blowing the stack.
const MAX_INJECTION_DEPTH: u32 = 32;

/// Fuel for one highlight call, shared by every parse and every query it
/// runs: the primary grammar's (the parse ran earlier, in
/// [`Registry::set_text`], on this same allotment) and every injected
/// block's beneath it.
///
/// Fuel models the work tree-sitter does instead of racing a wall clock.
/// Queries are charged for cursor operations weighted by how many candidate
/// matches each one has to touch (see
/// `arborium_plugin_runtime::FUEL_PER_OPERATION`); parses for parser
/// operations plus the extra work error recovery hides inside them (see
/// `arborium_plugin_runtime::PARSE_FUEL_PER_OPERATION`). Both are scaled so a
/// unit of fuel costs about the same time either way, which is what lets
/// one pool bound both. That buys two things a deadline can't:
///
/// - **Determinism.** The same document always costs the same fuel, on any
///   machine. A loaded CPU, a throttled background tab, or a paused
///   debugger can't silently shrink the budget and truncate highlights that
///   would otherwise render fine, and tests can assert on the cutoff.
/// - **A per-document ceiling.** One pool covers every parse and query in
///   the call, so a document is bounded as a whole. Under a per-call budget,
///   a page holding N injected chain-bomb code blocks costs N × the budget;
///   here the first blocks drain the pool and the rest are reported as
///   starved. And because parsing draws on the same fixed pool, a large
///   document can't buy itself more parse time by being large.
///
/// The trade is that fuel bounds work, not seconds — a slower machine takes
/// longer to burn the pool rather than truncating sooner — so the size is a
/// calibration against the slowest host we care about. In the browser
/// runtime both kinds of work measured ~2–3 ms per 1e6 fuel on the inputs
/// that matter, so 110e6 is ~220–330 ms of worst-case highlighting: the 16
/// KB kotlin `a.b().b()…` query chain bomb is cut off at ~230 ms, a parse
/// kept in error recovery (repeated kotlin `-}`, which wants ~3e8 by 2 KB
/// and keeps climbing) at ~250 ms, and recovery that keeps rebuilding one
/// ERROR node (a 50 KB unterminated javascript template literal, ~7e8) at
/// ~290 ms. Ordinary documents stay inside it: ~800 KB of TypeScript costs
/// ~80e6 (~28e6 parsing, ~52e6 querying).
/// `packages/arborium-rt-wasm/test/fuel.test.mts` and `parse-budget.test.mts`
/// pin both ends of that range.
pub const HIGHLIGHT_FUEL: u32 = 110_000_000;

#[derive(Debug)]
pub enum HighlightError {
    UnknownSession,
    Parse,
}

/// One themed span destined for JavaScript: dedup'd, coalesced, offsets in
/// UTF-16 code units, and tagged with the short theme slot string (`"k"`,
/// `"f"`, `"s"`, …) from `arborium_theme::tag_for_capture`.
#[derive(Serialize)]
pub struct WireThemedSpan {
    pub start: u32,
    pub end: u32,
    /// Short theme tag — the same one the default `HtmlFormat::CustomElements`
    /// renderer embeds as `<a-TAG>…</a-TAG>`. Callers can map it to a class
    /// name via `arborium_theme::tag_to_name` if they want a long form like
    /// `"keyword"`.
    pub tag: &'static str,
}

#[derive(Serialize)]
pub struct WireThemedOutput {
    pub spans: Vec<WireThemedSpan>,
    /// Languages referenced by injection queries but not loaded in the
    /// registry. JavaScript can use this to auto-load grammars and retry.
    pub missing_injections: Vec<String>,
    /// Language names whose highlighting is incomplete because the call's
    /// fuel pool ([`HIGHLIGHT_FUEL`]) ran dry — the grammar's query was cut
    /// off mid-run, its parse was abandoned so it had no tree to query, or it
    /// was an injected block reached after the pool was already empty and
    /// skipped. Empty when the whole document fit in budget. When non-empty, `spans` holds whatever was
    /// resolved before the pool drained — partial output. Consumers can use
    /// this to fall back to an alternate highlighter, log a metric tagged by
    /// language, or surface "interrupted" in UI per-grammar (e.g. "markdown
    /// highlighting was complete but the injected kotlin block was
    /// truncated"). Sorted; deduplicated.
    pub out_of_fuel_languages: Vec<String>,
    /// Fuel this call consumed out of [`HIGHLIGHT_FUEL`], summed across every
    /// parse and query — the primary grammar's (including its parse, run
    /// earlier by `set_text`) and every injected block's. Deterministic for a
    /// given document, which makes it usable as a cost metric: track the
    /// distribution to see how much headroom real traffic leaves before
    /// raising or lowering the cap.
    pub fuel_used: u32,
    /// The part of `fuel_used` spent parsing; the rest went to queries.
    pub parse_fuel_used: u32,
}

#[derive(Serialize)]
pub struct WireHtmlOutput {
    pub html: String,
    /// Languages referenced by injection queries but not loaded in the
    /// registry. JavaScript can use this to auto-load grammars and retry.
    pub missing_injections: Vec<String>,
    /// See [`WireThemedOutput::out_of_fuel_languages`].
    pub out_of_fuel_languages: Vec<String>,
    /// See [`WireThemedOutput::fuel_used`].
    pub fuel_used: u32,
    /// See [`WireThemedOutput::parse_fuel_used`].
    pub parse_fuel_used: u32,
}

pub fn highlight_to_themed_utf16(
    reg: &mut Registry,
    session_id: u32,
    max_depth: u32,
) -> Result<WireThemedOutput, HighlightError> {
    let (source, collected) = collect_spans(reg, session_id, max_depth)?;

    let themed_byte = dedup_and_tag(collected.spans);
    if themed_byte.is_empty() {
        return Ok(WireThemedOutput {
            spans: Vec::new(),
            missing_injections: collected.missing.into_iter().collect(),
            out_of_fuel_languages: sorted(collected.out_of_fuel),
            fuel_used: collected.fuel_used,
            parse_fuel_used: collected.parse_fuel_used,
        });
    }
    let coalesced = coalesce_by_tag(themed_byte);
    let spans = byte_spans_to_utf16(&source, coalesced);

    Ok(WireThemedOutput {
        spans,
        missing_injections: collected.missing.into_iter().collect(),
        out_of_fuel_languages: sorted(collected.out_of_fuel),
        fuel_used: collected.fuel_used,
        parse_fuel_used: collected.parse_fuel_used,
    })
}

pub fn highlight_to_html(
    reg: &mut Registry,
    session_id: u32,
    max_depth: u32,
    format: HtmlFormat,
) -> Result<WireHtmlOutput, HighlightError> {
    let (source, collected) = collect_spans(reg, session_id, max_depth)?;
    // Render from the same resolved spans the themed path produces — NOT the
    // raw overlapping ones. `arborium_highlight::spans_to_html` runs its own
    // dedup over the raw set, which mis-resolves the overlapping captures that
    // recursive injection produces (e.g. markdown's fenced-code literal
    // enclosing an injected JS keyword at depth >= 2), dropping the inner
    // capture to the enclosing one. Routing through `dedup_and_tag` +
    // `coalesce_by_tag` keeps HTML output lock-step with
    // `highlight_to_themed_utf16`.
    let tagged = coalesce_by_tag(dedup_and_tag(collected.spans));
    Ok(WireHtmlOutput {
        html: tagged_spans_to_html(&source, tagged, &format),
        missing_injections: collected.missing.into_iter().collect(),
        out_of_fuel_languages: sorted(collected.out_of_fuel),
        fuel_used: collected.fuel_used,
        parse_fuel_used: collected.parse_fuel_used,
    })
}

/// Drain a HashSet<String> into a deterministically-ordered Vec<String>.
/// Sorted output keeps wire payloads stable across runs (helpful for
/// snapshot tests and metric aggregation).
fn sorted(set: HashSet<String>) -> Vec<String> {
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort();
    v
}

/// Accumulator threaded through the whole walk: the raw spans resolved so
/// far (UTF-8 byte offsets anchored to the primary document), the two
/// per-language signals the wire outputs report, and the call's shared fuel
/// pool.
///
/// One pool spans the whole document: the primary parse and query take what
/// they need and each injected block's parse and query get whatever is
/// left. Injections are visited depth-first in document order, so a greedy
/// block starves the ones after it rather than every block paying its own
/// separate budget.
struct Collected {
    spans: Vec<Span>,
    /// Injected language names with no grammar in the registry.
    missing: HashSet<String>,
    /// Injected language names cut short or skipped by fuel exhaustion.
    out_of_fuel: HashSet<String>,
    /// Fuel left to spend on the parses and queries still to come.
    fuel_remaining: u32,
    /// Fuel spent so far, summed across every parse and query in the call.
    fuel_used: u32,
    /// The part of `fuel_used` spent parsing.
    parse_fuel_used: u32,
}

impl Collected {
    fn new(fuel: u32) -> Self {
        Self {
            spans: Vec::new(),
            missing: HashSet::new(),
            out_of_fuel: HashSet::new(),
            fuel_remaining: fuel,
            fuel_used: 0,
            parse_fuel_used: 0,
        }
    }

    fn starved(&self) -> bool {
        self.fuel_remaining == 0
    }

    /// Charge one parse against the pool. A parse that ran out leaves its
    /// session without a tree; the query that follows reports that as out of
    /// fuel, and [`Self::absorb`] records the language then.
    ///
    /// Saturating for the same reason as [`Self::absorb`]: the parser can
    /// overshoot its allotment by up to one tick.
    fn charge_parse(&mut self, spent: FuelSpent) {
        self.fuel_remaining = self.fuel_remaining.saturating_sub(spent.used);
        self.fuel_used = self.fuel_used.saturating_add(spent.used);
        self.parse_fuel_used = self.parse_fuel_used.saturating_add(spent.used);
    }

    /// Book one query's result: charge its fuel against the pool, record
    /// `language` as starved if its query was cut off (or had no tree to run
    /// on because its parse was), and take its spans, shifted to
    /// primary-document offsets. Returns the injections it found, for the
    /// caller to descend into.
    ///
    /// The runtime may overshoot its allotment by up to one tick (a query
    /// cursor is only interruptible at tick boundaries), hence the
    /// saturating arithmetic.
    fn absorb(
        &mut self,
        language: &str,
        result: Utf8ParseResult,
        shift: u32,
    ) -> Vec<Utf8Injection> {
        self.fuel_remaining = self.fuel_remaining.saturating_sub(result.fuel_used);
        self.fuel_used = self.fuel_used.saturating_add(result.fuel_used);
        if result.out_of_fuel {
            self.out_of_fuel.insert(language.to_string());
        }
        self.spans.extend(result.spans.into_iter().map(|s| Span {
            start: s.start + shift,
            end: s.end + shift,
            capture: s.capture,
            pattern_index: s.pattern_index,
        }));
        result.injections
    }
}

/// Walk the primary session + injections recursively, spending one shared
/// fuel pool across every parse and query. Also returns the primary source text, for HTML emission /
/// UTF-16 conversion.
fn collect_spans(
    reg: &mut Registry,
    session_id: u32,
    max_depth: u32,
) -> Result<(String, Collected), HighlightError> {
    let (primary_gid, primary_inner, source) = {
        let entry = reg
            .session(session_id)
            .ok_or(HighlightError::UnknownSession)?;
        (entry.grammar_id, entry.inner_id, entry.text.clone())
    };

    let mut out = Collected::new(HIGHLIGHT_FUEL);

    let primary_injections = {
        let grammar = reg
            .grammar_mut(primary_gid)
            .ok_or(HighlightError::UnknownSession)?;
        let primary_language = grammar.language_name.clone();
        // `Registry::set_text` already parsed the primary text, on this same
        // allotment. Charge what it cost; if it ran out, the query below
        // comes back empty and out of fuel, and the language is reported.
        if let Some(spent) = grammar.runtime.parse_fuel(primary_inner) {
            out.charge_parse(spent);
        }
        let result = grammar
            .runtime
            .parse_with_fuel(primary_inner, out.fuel_remaining)
            .map_err(|_| HighlightError::Parse)?;
        out.absorb(&primary_language, result, 0)
    };

    let depth = max_depth.min(MAX_INJECTION_DEPTH);
    if depth > 0 {
        process_injections(reg, &source, primary_injections, 0, depth, &mut out);
    }

    Ok((source, out))
}

fn process_injections(
    reg: &mut Registry,
    source: &str,
    injections: Vec<Utf8Injection>,
    base_offset: u32,
    remaining_depth: u32,
    out: &mut Collected,
) {
    if remaining_depth == 0 {
        return;
    }

    let mut injections = injections.into_iter();
    for inj in injections.by_ref() {
        // Pool drained by an earlier block. Don't even start on the remaining
        // ranges: there's no fuel to parse them. Report them as starved
        // instead — their highlighting is missing for the same reason a
        // cut-off query's is.
        if out.starved() {
            out.out_of_fuel.insert(inj.language);
            out.out_of_fuel.extend(injections.map(|rest| rest.language));
            return;
        }

        let start = inj.start as usize;
        let end = inj.end as usize;
        if start >= end || end > source.len() {
            continue;
        }
        if !source.is_char_boundary(start) || !source.is_char_boundary(end) {
            continue;
        }
        let Some(inj_gid) = reg.resolve_language(&inj.language) else {
            // Grammar not loaded (and not lazily loadable) — record the name
            // and skip this injection.
            out.missing.insert(inj.language.clone());
            continue;
        };

        // Own the sub-range so we can keep borrowing `reg` mutably below.
        let injected_text = source[start..end].to_string();

        let inj_result = {
            let Some(grammar) = reg.grammar_mut(inj_gid) else {
                continue;
            };
            let temp = grammar.runtime.create_session();
            let fuel = out.fuel_remaining;
            let parse_spent = grammar
                .runtime
                .set_text_with_fuel(temp, &injected_text, fuel);
            out.charge_parse(parse_spent);
            // An out-of-fuel parse leaves no tree, so this comes back empty
            // and out of fuel, and `absorb` reports the language.
            let result = grammar.runtime.parse_with_fuel(temp, out.fuel_remaining);
            grammar.runtime.free_session(temp);
            match result {
                Ok(r) => r,
                Err(_) => continue,
            }
        };

        let shift = base_offset + inj.start;
        let nested = out.absorb(&inj.language, inj_result, shift);

        if !nested.is_empty() {
            process_injections(reg, &injected_text, nested, shift, remaining_depth - 1, out);
        }
    }
}

struct TaggedByteSpan {
    start: u32,
    end: u32,
    tag: &'static str,
}

/// Same semantics as the private dedup step inside
/// `arborium_highlight::spans_to_html`: for each (start,end) range, prefer
/// spans whose capture resolves to a theme tag over unstyled ones, and
/// among equals prefer higher pattern_index.
fn dedup_and_tag(spans: Vec<Span>) -> Vec<TaggedByteSpan> {
    if spans.is_empty() {
        return Vec::new();
    }

    let mut deduped: HashMap<(u32, u32), Span> = HashMap::with_capacity(spans.len());
    for span in spans {
        let key = (span.start, span.end);
        let new_has_tag = tag_for_capture(&span.capture).is_some();
        if let Some(existing) = deduped.get(&key) {
            let existing_has_tag = tag_for_capture(&existing.capture).is_some();
            let replace = match (new_has_tag, existing_has_tag) {
                (true, false) => true,
                (false, true) => false,
                _ => span.pattern_index >= existing.pattern_index,
            };
            if replace {
                deduped.insert(key, span);
            }
        } else {
            deduped.insert(key, span);
        }
    }

    let mut tagged: Vec<TaggedByteSpan> = deduped
        .into_values()
        .filter_map(|s| {
            tag_for_capture(&s.capture).map(|tag| TaggedByteSpan {
                start: s.start,
                end: s.end,
                tag,
            })
        })
        .collect();

    tagged.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| b.end.cmp(&a.end)));
    tagged
}

fn coalesce_by_tag(spans: Vec<TaggedByteSpan>) -> Vec<TaggedByteSpan> {
    let mut out: Vec<TaggedByteSpan> = Vec::with_capacity(spans.len());
    for span in spans {
        if let Some(last) = out.last_mut()
            && last.tag == span.tag
            && span.start <= last.end
        {
            last.end = last.end.max(span.end);
            continue;
        }
        out.push(span);
    }
    out
}

/// Opening/closing markup for one theme tag, per `HtmlFormat`. Mirrors the
/// private `make_html_tags` in `arborium_highlight::render` so custom-element
/// and class-name output matches the upstream renderer byte-for-byte.
fn make_html_tags(tag: &str, format: &HtmlFormat) -> (String, String) {
    match format {
        HtmlFormat::CustomElements => (format!("<a-{tag}>"), format!("</a-{tag}>")),
        HtmlFormat::CustomElementsWithPrefix(prefix) => {
            (format!("<{prefix}-{tag}>"), format!("</{prefix}-{tag}>"))
        }
        HtmlFormat::ClassNames => match tag_to_name(tag) {
            Some(name) => (format!("<span class=\"{name}\">"), "</span>".to_string()),
            None => ("<span>".to_string(), "</span>".to_string()),
        },
        HtmlFormat::ClassNamesWithPrefix(prefix) => match tag_to_name(tag) {
            Some(name) => (
                format!("<span class=\"{prefix}-{name}\">"),
                "</span>".to_string(),
            ),
            None => ("<span>".to_string(), "</span>".to_string()),
        },
    }
}

/// Render already-resolved (dedup'd, tagged, coalesced) byte spans to HTML.
///
/// Unlike `arborium_highlight::spans_to_html`, this consumes spans that have
/// been through `dedup_and_tag` + `coalesce_by_tag`, so the only overlaps left
/// are proper nestings introduced by recursive language injection — an outer
/// span (e.g. markdown's fenced-code literal) fully containing inner ones
/// (e.g. an injected JS keyword). It resolves those innermost-wins: each run of
/// source text is emitted with the tag of the narrowest span covering it, which
/// keeps the output consistent with `highlight_to_themed_utf16`'s spans.
///
/// Like the upstream renderer, trailing newlines are trimmed so the output
/// embeds cleanly in `<pre><code>` without dangling whitespace.
fn tagged_spans_to_html(source: &str, spans: Vec<TaggedByteSpan>, format: &HtmlFormat) -> String {
    let source = source.trim_end_matches('\n');

    // Drop zero-width spans. They render no text, but their open/close events
    // share a position: ends sort before starts, so the close fires before the
    // open and the span is pushed onto the stack but never popped — leaving a
    // stray tag on top that would steal the next run of text. (Injected
    // grammars emit these, e.g. a zero-width marker at a statement boundary.)
    let mut spans: Vec<TaggedByteSpan> = spans.into_iter().filter(|s| s.start < s.end).collect();
    if spans.is_empty() {
        return html_escape(source);
    }

    // Enclosing spans must open before the spans they contain, so sort by
    // (start asc, end desc): at a shared start the widest span sorts first and
    // lands deeper in the stack, leaving the narrowest (innermost) on top.
    spans.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| b.end.cmp(&a.end)));

    struct Event {
        position: u32,
        is_start: bool,
        index: usize,
    }

    // Boundary events: (position, is_start, span index). At a shared position,
    // closes sort before opens (`false` < `true`) so a span ending where the
    // next begins doesn't transiently nest inside it.
    let mut events: Vec<Event> = Vec::with_capacity(spans.len() * 2);
    for (i, s) in spans.iter().enumerate() {
        events.push(Event {
            position: s.start,
            is_start: true,
            index: i,
        });
        events.push(Event {
            position: s.end,
            is_start: false,
            index: i,
        });
    }
    events.sort_by(|a, b| {
        a.position
            .cmp(&b.position)
            .then_with(|| a.is_start.cmp(&b.is_start))
    });

    let mut html = String::with_capacity(source.len() * 2);
    let mut last_pos: usize = 0;
    let mut stack: Vec<usize> = Vec::new();

    let mut emit = |stack: &[usize], text: &str| {
        if let Some(&top) = stack.last() {
            let (open, close) = make_html_tags(spans[top].tag, format);
            html.push_str(&open);
            html.push_str(&html_escape(text));
            html.push_str(&close);
        } else {
            html.push_str(&html_escape(text));
        }
    };

    for Event {
        position,
        is_start,
        index,
    } in events
    {
        let pos = position as usize;
        if pos > last_pos && pos <= source.len() {
            emit(&stack, &source[last_pos..pos]);
            last_pos = pos;
        }
        if is_start {
            stack.push(index);
        } else if let Some(p) = stack.iter().rposition(|&x| x == index) {
            stack.remove(p);
        }
    }

    if last_pos < source.len() {
        emit(&stack, &source[last_pos..]);
    }

    html
}

/// Convert all span endpoints from UTF-8 byte offsets to UTF-16 code unit
/// indices in a single linear pass over `source`. O(n + m) where n is source
/// length and m is span count.
fn byte_spans_to_utf16(source: &str, spans: Vec<TaggedByteSpan>) -> Vec<WireThemedSpan> {
    if spans.is_empty() {
        return Vec::new();
    }

    let mut sorted: Vec<u32> = spans.iter().flat_map(|s| [s.start, s.end]).collect();
    sorted.sort_unstable();
    sorted.dedup();

    let mut u16_for_byte: HashMap<u32, u32> = HashMap::with_capacity(sorted.len());
    let mut sorted_iter = sorted.into_iter().peekable();
    let mut utf16_index: u32 = 0;
    let mut byte_index: u32 = 0;

    for c in source.chars() {
        while let Some(&next) = sorted_iter.peek() {
            if next <= byte_index {
                u16_for_byte.insert(next, utf16_index);
                sorted_iter.next();
            } else {
                break;
            }
        }
        byte_index += c.len_utf8() as u32;
        utf16_index += if c as u32 >= 0x10000 { 2 } else { 1 };
    }
    for offset in sorted_iter {
        u16_for_byte.insert(offset, utf16_index);
    }

    spans
        .into_iter()
        .map(|s| WireThemedSpan {
            start: *u16_for_byte.get(&s.start).unwrap_or(&0),
            end: *u16_for_byte.get(&s.end).unwrap_or(&0),
            tag: s.tag,
        })
        .collect()
}

/// Decode an integer format code from the ABI into an `HtmlFormat`.
/// Prefix is only consulted for the two `*WithPrefix` variants.
pub fn decode_format(code: u32, prefix: &str) -> HtmlFormat {
    match code {
        1 => HtmlFormat::CustomElementsWithPrefix(prefix.to_string()),
        2 => HtmlFormat::ClassNames,
        3 => HtmlFormat::ClassNamesWithPrefix(prefix.to_string()),
        _ => HtmlFormat::CustomElements,
    }
}
