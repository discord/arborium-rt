//! C ABI surface.
//!
//! All functions in this module are `#[unsafe(no_mangle)] pub extern "C"`
//! and exposed to consumers via emscripten's dynamic linker. See the
//! crate-level README for the full contract.
//!
//! Pointer rules:
//!
//! - Input buffers (`*const u8`) are borrowed for the duration of the call;
//!   they're never retained.
//! - Output buffers are allocated by the runtime in shared linear memory
//!   and ownership transfers to the caller. Callers **must** return them
//!   via `arborium_rt_free(ptr, len)`.
//! - Session IDs and grammar IDs are opaque `u32` handles. `0` is never a
//!   valid ID — the registry starts counting at `1` so `0` can double as a
//!   null-return signal.

use std::alloc::{Layout, alloc, dealloc};
use std::slice;

use arborium_tree_sitter::Language;

use crate::highlight::{decode_format, highlight_to_html, highlight_to_themed_utf16};
use crate::registry::registry;

/// Register a grammar by its `*const TSLanguage` (obtained from the grammar
/// side module's `tree_sitter_<lang>()` export), its language name (used
/// for injection lookups), plus its three query sources. Returns a non-zero
/// grammar ID on success, `0` on failure.
///
/// The language name is what injection queries refer to — e.g. a grammar
/// whose injection query emits `@injection.language` of `"javascript"`
/// will resolve against whichever grammar was most recently registered
/// with `language_name = "javascript"`.
///
/// # Safety
///
/// `language` must be a valid `*const TSLanguage` from a grammar module
/// loaded into the same emscripten runtime. `name_ptr` + query pointers
/// must be valid for `*_len` bytes and contain UTF-8. A NULL query pointer
/// with `*_len == 0` represents an empty query. The name **must** be
/// non-empty.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn arborium_rt_register_grammar(
    language: *const core::ffi::c_void,
    name_ptr: *const u8,
    name_len: u32,
    highlights_ptr: *const u8,
    highlights_len: u32,
    injections_ptr: *const u8,
    injections_len: u32,
    locals_ptr: *const u8,
    locals_len: u32,
) -> u32 {
    if language.is_null() {
        return 0;
    }
    let name = match unsafe { str_from_parts(name_ptr, name_len) } {
        Some(s) if !s.is_empty() => s,
        _ => return 0,
    };
    let highlights = match unsafe { str_from_parts(highlights_ptr, highlights_len) } {
        Some(s) => s,
        None => return 0,
    };
    let injections = match unsafe { str_from_parts(injections_ptr, injections_len) } {
        Some(s) => s,
        None => return 0,
    };
    let locals = match unsafe { str_from_parts(locals_ptr, locals_len) } {
        Some(s) => s,
        None => return 0,
    };
    let language = unsafe { Language::from_raw(language.cast()) };
    let mut reg = registry().lock().expect("registry poisoned");
    reg.register_grammar(name, language, highlights, injections, locals)
        .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn arborium_rt_unregister_grammar(grammar_id: u32) {
    let mut reg = registry().lock().expect("registry poisoned");
    reg.unregister_grammar(grammar_id);
}

#[unsafe(no_mangle)]
pub extern "C" fn arborium_rt_create_session(grammar_id: u32) -> u32 {
    let mut reg = registry().lock().expect("registry poisoned");
    reg.create_session(grammar_id).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn arborium_rt_free_session(session_id: u32) {
    let mut reg = registry().lock().expect("registry poisoned");
    reg.free_session(session_id);
}

/// Load UTF-8 text for a session. Replaces any previous text. Triggers an
/// immediate parse (matching `PluginRuntime::set_text` semantics).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn arborium_rt_set_text(
    session_id: u32,
    text_ptr: *const u8,
    text_len: u32,
) {
    let text = match unsafe { str_from_parts(text_ptr, text_len) } {
        Some(s) => s,
        None => return,
    };
    let mut reg = registry().lock().expect("registry poisoned");
    reg.set_text(session_id, text);
}

#[unsafe(no_mangle)]
pub extern "C" fn arborium_rt_cancel(session_id: u32) {
    let mut reg = registry().lock().expect("registry poisoned");
    reg.cancel(session_id);
}

/// Execute queries on the session's current tree and return a JSON-encoded
/// `arborium_wire::Utf16ParseResult` in shared linear memory.
///
/// On success: writes a pointer into `*out_ptr` and length into `*out_len`,
/// returns `0`. On failure: leaves outputs untouched, returns non-zero.
/// The caller owns the returned buffer and must return it via
/// `arborium_rt_free(ptr, len)` to avoid leaking.
///
/// # Safety
///
/// `out_ptr` and `out_len` must point to writable `u32`/`u8*` slots the
/// caller controls.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn arborium_rt_parse_utf16(
    session_id: u32,
    out_ptr: *mut *mut u8,
    out_len: *mut u32,
) -> i32 {
    let result = {
        let mut reg = registry().lock().expect("registry poisoned");
        reg.with_session(session_id, |rt, inner_id| rt.parse_utf16(inner_id))
    };
    let parse_result = match result {
        Some(Ok(r)) => r,
        Some(Err(_)) => return 2,
        None => return 1,
    };
    let json = match serde_json::to_vec(&parse_result) {
        Ok(v) => v,
        Err(_) => return 3,
    };
    unsafe { write_bytes_out(&json, out_ptr, out_len) }
}

/// Run the full parse + injection + theming pipeline for the session and
/// return a JSON array of themed spans with UTF-16 offsets.
///
/// `max_injection_depth` caps recursion into injected languages (0 = only
/// the primary grammar; higher values resolve nested injections like
/// JS-in-HTML-in-Markdown).
///
/// Return codes match `arborium_rt_parse_utf16`: `0` on success,
/// non-zero on failure.
///
/// # Safety
///
/// Same pointer contract as `arborium_rt_parse_utf16`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn arborium_rt_highlight_to_spans_utf16(
    session_id: u32,
    max_injection_depth: u32,
    out_ptr: *mut *mut u8,
    out_len: *mut u32,
) -> i32 {
    let outcome = {
        let mut reg = registry().lock().expect("registry poisoned");
        highlight_to_themed_utf16(&mut reg, session_id, max_injection_depth)
    };
    let themed = match outcome {
        Ok(t) => t,
        Err(crate::highlight::HighlightError::UnknownSession) => return 1,
        Err(crate::highlight::HighlightError::Parse) => return 2,
    };
    let json = match serde_json::to_vec(&themed) {
        Ok(v) => v,
        Err(_) => return 3,
    };
    unsafe { write_bytes_out(&json, out_ptr, out_len) }
}

/// Run the full parse + injection + theming pipeline and return a rendered
/// HTML string in shared memory.
///
/// `format` selects how captures map to markup:
///
/// | code | variant                                 |
/// |------|-----------------------------------------|
/// | 0    | `CustomElements` (default `<a-k>…`)     |
/// | 1    | `CustomElementsWithPrefix(prefix)`      |
/// | 2    | `ClassNames` (`<span class="keyword">`) |
/// | 3    | `ClassNamesWithPrefix(prefix)`          |
///
/// For the two `*WithPrefix` variants `prefix_ptr` + `prefix_len` supply
/// the prefix; for the other two they're ignored (pass 0/0).
///
/// # Safety
///
/// Same pointer contract as `arborium_rt_parse_utf16`. `prefix_ptr` must be
/// valid for `prefix_len` UTF-8 bytes, or NULL/0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn arborium_rt_highlight_to_html(
    session_id: u32,
    max_injection_depth: u32,
    format: u32,
    prefix_ptr: *const u8,
    prefix_len: u32,
    out_ptr: *mut *mut u8,
    out_len: *mut u32,
) -> i32 {
    let prefix = match unsafe { str_from_parts(prefix_ptr, prefix_len) } {
        Some(s) => s,
        None => return 4,
    };
    let format = decode_format(format, prefix);
    let outcome = {
        let mut reg = registry().lock().expect("registry poisoned");
        highlight_to_html(&mut reg, session_id, max_injection_depth, format)
    };
    let html_output = match outcome {
        Ok(s) => s,
        Err(crate::highlight::HighlightError::UnknownSession) => return 1,
        Err(crate::highlight::HighlightError::Parse) => return 2,
    };
    let json = match serde_json::to_vec(&html_output) {
        Ok(v) => v,
        Err(_) => return 3,
    };
    unsafe { write_bytes_out(&json, out_ptr, out_len) }
}

/// Return an output buffer previously handed out by any
/// `arborium_rt_*` entry point that allocates in shared memory.
///
/// # Safety
///
/// `ptr` must have been returned by a runtime allocation entry point with
/// the same `len`. Passing any other pointer is UB.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn arborium_rt_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len as usize, 1) else {
        return;
    };
    unsafe { dealloc(ptr, layout) };
}

/// Build a `&str` from a raw ptr/len, returning `None` on null+nonzero or
/// on non-UTF-8 contents. Null+zero is treated as an empty string, which
/// matches the convention for "unused query".
unsafe fn str_from_parts<'a>(ptr: *const u8, len: u32) -> Option<&'a str> {
    if ptr.is_null() {
        return if len == 0 { Some("") } else { None };
    }
    let bytes = unsafe { slice::from_raw_parts(ptr, len as usize) };
    core::str::from_utf8(bytes).ok()
}

/// Allocate a buffer in the shared heap, copy `bytes` into it, and hand the
/// pointer + length to the caller via `*out_ptr` / `*out_len`. Returns `0`
/// on success, matches the error codes used by the surrounding entry points.
///
/// # Safety
///
/// `out_ptr` / `out_len` must be writable slots the caller owns.
unsafe fn write_bytes_out(bytes: &[u8], out_ptr: *mut *mut u8, out_len: *mut u32) -> i32 {
    let len = bytes.len();
    if len == 0 {
        unsafe {
            *out_ptr = core::ptr::null_mut();
            *out_len = 0;
        }
        return 0;
    }
    let layout = match Layout::from_size_align(len, 1) {
        Ok(l) => l,
        Err(_) => return 4,
    };
    // SAFETY: layout is non-zero-sized; alloc returns aligned or null.
    let ptr = unsafe { alloc(layout) };
    if ptr.is_null() {
        return 5;
    }
    unsafe {
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, len);
        *out_ptr = ptr;
        *out_len = len as u32;
    }
    0
}
