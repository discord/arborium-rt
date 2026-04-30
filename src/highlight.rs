//! Full parse + highlight pipeline executed entirely inside the WASM module.
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
//! through the WASM binary. The span rendering is delegated to
//! `arborium_highlight::spans_to_html` so HTML output stays lock-step with
//! the native Rust highlighter.

use std::collections::{HashMap, HashSet};

use arborium_highlight::{HtmlFormat, Span, spans_to_html};
use arborium_theme::tag_for_capture;
use arborium_wire::Utf8Injection;
use serde::Serialize;

use crate::registry::Registry;

/// Hard upper bound for recursion depth even when a caller passes a huge
/// value — prevents pathological grammars from blowing the stack.
const MAX_INJECTION_DEPTH: u32 = 32;

/// Scaffolding capture name used by grammars whose AST puts the call-target
/// identifier inside a left-recursive node (kotlin/swift navigation_expression).
/// Direct query patterns like
///   (call_expression (navigation_expression (navigation_suffix (simple_identifier) @function)))
/// are O(n^2) on chained calls because the QueryCursor descends the recursion.
/// Instead the grammars capture the receiver chain as a whole node:
///   (call_expression . (navigation_expression) @callable.chain)
/// (which is O(n) — the inner pattern doesn't descend), and this pipeline
/// retags any `@property` / `@variable.member` capture whose end byte equals
/// a `@callable.chain` capture's end byte (= last suffix in the chain =
/// the actual call target) into `@function` / `@function.call`.
///
/// The capture name does NOT start with `_`: arborium-plugin-runtime's
/// `parse_raw` drops underscore-prefixed captures before they reach the
/// spans Vec, which would prevent this pass from ever seeing the
/// scaffolding capture. `callable.chain` has no theme-tag mapping in
/// arborium-theme, so it's stripped at dedup time after this pass uses it.
const CALLABLE_CHAIN_CAPTURE: &str = "callable.chain";

#[derive(Debug)]
pub(crate) enum HighlightError {
    UnknownSession,
    Parse,
}

/// One themed span destined for JavaScript: dedup'd, coalesced, offsets in
/// UTF-16 code units, and tagged with the short theme slot string (`"k"`,
/// `"f"`, `"s"`, …) from `arborium_theme::tag_for_capture`.
#[derive(Serialize)]
pub(crate) struct WireThemedSpan {
    pub start: u32,
    pub end: u32,
    /// Short theme tag — the same one the default `HtmlFormat::CustomElements`
    /// renderer embeds as `<a-TAG>…</a-TAG>`. Callers can map it to a class
    /// name via `arborium_theme::tag_to_name` if they want a long form like
    /// `"keyword"`.
    pub tag: &'static str,
}

#[derive(Serialize)]
pub(crate) struct WireThemedOutput {
    pub spans: Vec<WireThemedSpan>,
    /// Languages referenced by injection queries but not loaded in the
    /// registry. JavaScript can use this to auto-load grammars and retry.
    pub missing_injections: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct WireHtmlOutput {
    pub html: String,
    /// Languages referenced by injection queries but not loaded in the
    /// registry. JavaScript can use this to auto-load grammars and retry.
    pub missing_injections: Vec<String>,
}

pub(crate) fn highlight_to_themed_utf16(
    reg: &mut Registry,
    session_id: u32,
    max_depth: u32,
) -> Result<WireThemedOutput, HighlightError> {
    let (source, mut raw_spans, missing) = collect_spans(reg, session_id, max_depth)?;
    apply_call_context_upgrades(&mut raw_spans);

    let themed_byte = dedup_and_tag(raw_spans);
    if themed_byte.is_empty() {
        return Ok(WireThemedOutput {
            spans: Vec::new(),
            missing_injections: missing.into_iter().collect(),
        });
    }
    let coalesced = coalesce_by_tag(themed_byte);
    let spans = byte_spans_to_utf16(&source, coalesced);

    Ok(WireThemedOutput {
        spans,
        missing_injections: missing.into_iter().collect(),
    })
}

pub(crate) fn highlight_to_html(
    reg: &mut Registry,
    session_id: u32,
    max_depth: u32,
    format: HtmlFormat,
) -> Result<WireHtmlOutput, HighlightError> {
    let (source, mut raw_spans, missing) = collect_spans(reg, session_id, max_depth)?;
    apply_call_context_upgrades(&mut raw_spans);
    Ok(WireHtmlOutput {
        html: spans_to_html(&source, raw_spans, &format),
        missing_injections: missing.into_iter().collect(),
    })
}

/// See [`CALLABLE_CHAIN_CAPTURE`] for the rationale.
///
/// Builds a set of end-byte positions from `_callable.chain` capture spans
/// and retags any `@property` (kotlin) / `@variable.member` (swift) span
/// whose end byte coincides with one of those positions — that span is the
/// last navigation_suffix in the chain, which means it's the function being
/// called rather than a property access along the way. After retagging,
/// the scaffolding `_callable.chain` spans are dropped (they have no theme
/// tag of their own and would be filtered by `tag_for_capture` anyway, but
/// dropping early keeps later passes shorter).
///
/// O(n + m) time, O(c) space where c is the number of chain captures.
fn apply_call_context_upgrades(spans: &mut Vec<Span>) {
    let chain_ends: HashSet<u32> = spans
        .iter()
        .filter(|s| s.capture == CALLABLE_CHAIN_CAPTURE)
        .map(|s| s.end)
        .collect();
    if chain_ends.is_empty() {
        spans.retain(|s| s.capture != CALLABLE_CHAIN_CAPTURE);
        return;
    }
    for span in spans.iter_mut() {
        if !chain_ends.contains(&span.end) {
            continue;
        }
        match span.capture.as_str() {
            "property" => span.capture = String::from("function"),
            "variable.member" => span.capture = String::from("function.call"),
            _ => {}
        }
    }
    spans.retain(|s| s.capture != CALLABLE_CHAIN_CAPTURE);
}

/// Walk the primary session + injections recursively. Returns the primary
/// source text (for HTML emission / UTF-16 conversion), the full set of
/// raw spans with UTF-8 byte offsets anchored to the primary document, and
/// a set of language names that were referenced by injections but not found
/// in the registry.
fn collect_spans(
    reg: &mut Registry,
    session_id: u32,
    max_depth: u32,
) -> Result<(String, Vec<Span>, HashSet<String>), HighlightError> {
    let (primary_gid, primary_inner, source) = {
        let entry = reg
            .session(session_id)
            .ok_or(HighlightError::UnknownSession)?;
        (entry.grammar_id, entry.inner_id, entry.text.clone())
    };

    let mut all_spans: Vec<Span> = Vec::new();
    let mut missing_injections: HashSet<String> = HashSet::new();

    let primary_injections = {
        let grammar = reg
            .grammar_mut(primary_gid)
            .ok_or(HighlightError::UnknownSession)?;
        let result = grammar
            .runtime
            .parse(primary_inner)
            .map_err(|_| HighlightError::Parse)?;
        for s in result.spans {
            all_spans.push(Span {
                start: s.start,
                end: s.end,
                capture: s.capture,
                pattern_index: s.pattern_index,
            });
        }
        result.injections
    };

    let depth = max_depth.min(MAX_INJECTION_DEPTH);
    if depth > 0 {
        process_injections(
            reg,
            &source,
            primary_injections,
            0,
            depth,
            &mut all_spans,
            &mut missing_injections,
        );
    }

    Ok((source, all_spans, missing_injections))
}

fn process_injections(
    reg: &mut Registry,
    source: &str,
    injections: Vec<Utf8Injection>,
    base_offset: u32,
    remaining_depth: u32,
    all_spans: &mut Vec<Span>,
    missing_injections: &mut HashSet<String>,
) {
    if remaining_depth == 0 {
        return;
    }

    for inj in injections {
        let start = inj.start as usize;
        let end = inj.end as usize;
        if start >= end || end > source.len() {
            continue;
        }
        if !source.is_char_boundary(start) || !source.is_char_boundary(end) {
            continue;
        }
        let Some(inj_gid) = reg.grammar_id_by_name(&inj.language) else {
            // Grammar not loaded — record the name and skip this injection.
            missing_injections.insert(inj.language.clone());
            continue;
        };

        // Own the sub-range so we can keep borrowing `reg` mutably below.
        let injected_text = source[start..end].to_string();

        let inj_result = {
            let Some(grammar) = reg.grammar_mut(inj_gid) else {
                continue;
            };
            let temp = grammar.runtime.create_session();
            grammar.runtime.set_text(temp, &injected_text);
            let result = grammar.runtime.parse(temp);
            grammar.runtime.free_session(temp);
            match result {
                Ok(r) => r,
                Err(_) => continue,
            }
        };

        let shift = base_offset + inj.start;
        for s in inj_result.spans {
            all_spans.push(Span {
                start: s.start + shift,
                end: s.end + shift,
                capture: s.capture,
                pattern_index: s.pattern_index,
            });
        }

        if !inj_result.injections.is_empty() {
            process_injections(
                reg,
                &injected_text,
                inj_result.injections,
                shift,
                remaining_depth - 1,
                all_spans,
                missing_injections,
            );
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
pub(crate) fn decode_format(code: u32, prefix: &str) -> HtmlFormat {
    match code {
        1 => HtmlFormat::CustomElementsWithPrefix(prefix.to_string()),
        2 => HtmlFormat::ClassNames,
        3 => HtmlFormat::ClassNamesWithPrefix(prefix.to_string()),
        _ => HtmlFormat::CustomElements,
    }
}
