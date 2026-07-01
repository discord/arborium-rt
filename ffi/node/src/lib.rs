//! Node.js native addon: a statically-linked arborium runtime.
//!
//! Every grammar is compiled into the shared `arborium-rt-native` crate (and,
//! transitively, into this cdylib) with its flattened queries baked in. At
//! first use, [`arborium_rt_native::register_all`] registers all of them into
//! the process-global [`arborium_rt::registry`] and the napi surface drives the
//! same highlight pipeline the wasm shim uses — no wasm host, no dynamic
//! grammar loading.
//!
//! The registry is a single process-global mutex, populated exactly once and
//! immutable afterward (no `unregister` is exposed — everything is static).
//! Node's single JS thread serializes all calls; under `worker_threads` the
//! addon (and its registry) is shared across isolates, and the one-time
//! `OnceLock` init in `register_all` keeps concurrent first-touch safe.

use std::sync::MutexGuard;

use napi::Result;
use napi_derive::napi;

use arborium_rt::highlight::{
    HighlightError, decode_format, highlight_to_html, highlight_to_themed_utf16,
};
use arborium_rt::registry::{Registry, registry};
use arborium_rt_native::register_all;

/// Default injection recursion depth, matching the TS wrapper's default.
const DEFAULT_MAX_INJECTION_DEPTH: u32 = 3;

fn grammar_id(language: &str) -> Result<u32> {
    register_all()
        .get(language)
        .copied()
        .ok_or_else(|| napi::Error::from_reason(format!("unknown language: {language}")))
}

fn lock_registry() -> Result<MutexGuard<'static, Registry>> {
    registry()
        .lock()
        .map_err(|_| napi::Error::from_reason("registry poisoned"))
}

// --- JS-facing value types -------------------------------------------------

/// One themed span: UTF-16 `[start, end)` code-unit offsets tagged with the
/// short theme slot (`"k"`, `"f"`, `"s"`, …) from `arborium_theme`.
#[napi(object)]
pub struct ThemedSpan {
    pub start: u32,
    pub end: u32,
    pub tag: String,
}

#[napi(object)]
pub struct HighlightSpansResult {
    pub spans: Vec<ThemedSpan>,
    /// Languages referenced by injections but not bundled in this addon.
    pub missing_injections: Vec<String>,
    /// Languages whose parse exceeded the wall-clock budget (partial output).
    pub timed_out_languages: Vec<String>,
}

#[napi(object)]
pub struct HighlightHtmlResult {
    pub html: String,
    pub missing_injections: Vec<String>,
    pub timed_out_languages: Vec<String>,
}

/// A raw highlight-query capture span (UTF-16 offsets, not themed).
#[napi(object)]
pub struct ParseSpan {
    pub start: u32,
    pub end: u32,
    pub capture: String,
    pub pattern_index: u32,
}

/// A language-injection point discovered during the primary parse.
#[napi(object)]
pub struct ParseInjection {
    pub start: u32,
    pub end: u32,
    pub language: String,
    pub include_children: bool,
}

#[napi(object)]
pub struct ParseResult {
    pub spans: Vec<ParseSpan>,
    pub injections: Vec<ParseInjection>,
    pub timed_out: bool,
}

/// Options for span highlighting. `maxInjectionDepth` defaults to 3.
#[napi(object)]
pub struct HighlightOptions {
    pub max_injection_depth: Option<u32>,
}

/// Options for HTML highlighting. `format` is an integer code matching
/// `arborium_rt::highlight::decode_format`: 0 = custom-elements (default),
/// 1 = custom-elements-with-prefix, 2 = class-names, 3 = class-names-with-prefix.
/// `prefix` applies only to the two `*WithPrefix` variants.
#[napi(object)]
pub struct HtmlOptions {
    pub max_injection_depth: Option<u32>,
    pub format: Option<u32>,
    pub prefix: Option<String>,
}

// --- shared pipeline helpers (operate on a held registry lock) -------------

fn run_spans(reg: &mut Registry, session: u32, depth: u32) -> Result<HighlightSpansResult> {
    let out = highlight_to_themed_utf16(reg, session, depth).map_err(highlight_err)?;
    Ok(HighlightSpansResult {
        spans: out
            .spans
            .into_iter()
            .map(|s| ThemedSpan {
                start: s.start,
                end: s.end,
                tag: s.tag.to_string(),
            })
            .collect(),
        missing_injections: out.missing_injections,
        timed_out_languages: out.timed_out_languages,
    })
}

fn run_html(reg: &mut Registry, session: u32, opts: &HtmlOptions) -> Result<HighlightHtmlResult> {
    let depth = opts
        .max_injection_depth
        .unwrap_or(DEFAULT_MAX_INJECTION_DEPTH);
    let format = decode_format(
        opts.format.unwrap_or(0),
        opts.prefix.as_deref().unwrap_or(""),
    );
    let out = highlight_to_html(reg, session, depth, format).map_err(highlight_err)?;
    Ok(HighlightHtmlResult {
        html: out.html,
        missing_injections: out.missing_injections,
        timed_out_languages: out.timed_out_languages,
    })
}

fn run_parse(reg: &mut Registry, session: u32) -> Result<ParseResult> {
    let result = reg
        .with_session(session, |rt, inner| rt.parse_utf16(inner))
        .ok_or_else(|| napi::Error::from_reason("unknown session"))?
        .map_err(|_| napi::Error::from_reason("parse failed"))?;
    Ok(ParseResult {
        spans: result
            .spans
            .into_iter()
            .map(|s| ParseSpan {
                start: s.start,
                end: s.end,
                capture: s.capture,
                pattern_index: s.pattern_index,
            })
            .collect(),
        injections: result
            .injections
            .into_iter()
            .map(|i| ParseInjection {
                start: i.start,
                end: i.end,
                language: i.language,
                include_children: i.include_children,
            })
            .collect(),
        timed_out: result.timed_out,
    })
}

fn highlight_err(e: HighlightError) -> napi::Error {
    match e {
        HighlightError::UnknownSession => napi::Error::from_reason("unknown session"),
        HighlightError::Parse => napi::Error::from_reason("parse failed"),
    }
}

// --- top-level functions ---------------------------------------------------

/// The ids of every grammar bundled in this addon, sorted.
#[napi]
pub fn available_languages() -> Vec<String> {
    arborium_rt_native::available_languages()
}

/// One-shot: highlight `text` as `language` into themed UTF-16 spans.
/// `maxInjectionDepth` defaults to 3 (0 = primary grammar only).
#[napi]
pub fn highlight_to_spans(
    language: String,
    text: String,
    max_injection_depth: Option<u32>,
) -> Result<HighlightSpansResult> {
    let gid = grammar_id(&language)?;
    let depth = max_injection_depth.unwrap_or(DEFAULT_MAX_INJECTION_DEPTH);
    let mut reg = lock_registry()?;
    let session = reg
        .create_session(gid)
        .ok_or_else(|| napi::Error::from_reason("session creation failed"))?;
    reg.set_text(session, &text);
    let out = run_spans(&mut reg, session, depth);
    reg.free_session(session);
    out
}

/// One-shot: highlight `text` as `language` into a rendered HTML string.
#[napi]
pub fn highlight_to_html_string(
    language: String,
    text: String,
    options: Option<HtmlOptions>,
) -> Result<HighlightHtmlResult> {
    let gid = grammar_id(&language)?;
    let opts = options.unwrap_or(HtmlOptions {
        max_injection_depth: None,
        format: None,
        prefix: None,
    });
    let mut reg = lock_registry()?;
    let session = reg
        .create_session(gid)
        .ok_or_else(|| napi::Error::from_reason("session creation failed"))?;
    reg.set_text(session, &text);
    let out = run_html(&mut reg, session, &opts);
    reg.free_session(session);
    out
}

// --- stateful Session ------------------------------------------------------

/// A reusable parse session for one document. Holds a registry session id;
/// call [`Session::set_text`] then any of the highlight/parse methods. The
/// underlying registry session is freed when this object is garbage-collected
/// (or explicitly via [`Session::free`]).
#[napi]
pub struct Session {
    session_id: u32,
}

#[napi]
impl Session {
    /// Open a session for `language` (must be a bundled grammar id).
    #[napi(constructor)]
    pub fn new(language: String) -> Result<Self> {
        let gid = grammar_id(&language)?;
        let mut reg = lock_registry()?;
        let session_id = reg
            .create_session(gid)
            .ok_or_else(|| napi::Error::from_reason("session creation failed"))?;
        Ok(Session { session_id })
    }

    /// Replace the session text and parse it immediately.
    #[napi]
    pub fn set_text(&self, text: String) -> Result<()> {
        let mut reg = lock_registry()?;
        reg.set_text(self.session_id, &text);
        Ok(())
    }

    /// Raw parse of the primary grammar: capture spans + injection points.
    #[napi]
    pub fn parse(&self) -> Result<ParseResult> {
        let mut reg = lock_registry()?;
        run_parse(&mut reg, self.session_id)
    }

    /// Full pipeline → themed UTF-16 spans.
    #[napi]
    pub fn highlight_to_spans(
        &self,
        options: Option<HighlightOptions>,
    ) -> Result<HighlightSpansResult> {
        let depth = options
            .and_then(|o| o.max_injection_depth)
            .unwrap_or(DEFAULT_MAX_INJECTION_DEPTH);
        let mut reg = lock_registry()?;
        run_spans(&mut reg, self.session_id, depth)
    }

    /// Full pipeline → rendered HTML.
    #[napi]
    pub fn highlight_to_html(&self, options: Option<HtmlOptions>) -> Result<HighlightHtmlResult> {
        let opts = options.unwrap_or(HtmlOptions {
            max_injection_depth: None,
            format: None,
            prefix: None,
        });
        let mut reg = lock_registry()?;
        run_html(&mut reg, self.session_id, &opts)
    }

    /// Cancel an in-progress parse/highlight (cooperative wall-clock budget).
    #[napi]
    pub fn cancel(&self) -> Result<()> {
        let mut reg = lock_registry()?;
        reg.cancel(self.session_id);
        Ok(())
    }

    /// Explicitly free the underlying registry session. Idempotent; the same
    /// happens automatically when this object is garbage-collected.
    #[napi]
    pub fn free(&self) -> Result<()> {
        let mut reg = lock_registry()?;
        reg.free_session(self.session_id);
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // free_session is idempotent, so a prior explicit free() is harmless.
        if let Ok(mut reg) = registry().lock() {
            reg.free_session(self.session_id);
        }
    }
}
