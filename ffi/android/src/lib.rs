//! Android JNI shim: a statically-linked arborium runtime as
//! `libarborium_rt.so`, loaded by the AAR's Kotlin binding
//! (`com.discord.arborium.ArboriumNative`).
//!
//! Every grammar is compiled into the shared `arborium-rt-native` crate (and,
//! transitively, into this cdylib) with its flattened queries baked in. At
//! first use, [`arborium_rt_native::register_all`] registers all of them into
//! the process-global [`arborium_rt::registry`]; the JNI entry points then
//! drive the shared [`arborium_rt::highlight`] pipeline, returning results as
//! JSON strings the Kotlin side deserializes.
//!
//! Each `Java_com_discord_arborium_ArboriumNative_*` export takes/returns JVM
//! types, translates to/from Rust, and throws `java.lang.RuntimeException` on
//! error (mirroring the shape used in discord/markdown's `ffi/java`). Session
//! ids are the registry's `u32` handles, widened to `jlong` for the JVM.

use anyhow::{Result, anyhow};
use jni::JNIEnv;
use jni::objects::{JClass, JObject, JString};
use jni::sys::{jint, jlong, jobjectArray, jstring};

use arborium_rt::highlight::{decode_format, highlight_to_html, highlight_to_themed_utf16};
use arborium_rt::registry::{Registry, registry};
use arborium_rt_native::register_all;

/// Default injection recursion depth, matching the other targets' default.
const DEFAULT_MAX_INJECTION_DEPTH: u32 = 3;

// --- Rust core (no JNIEnv) -------------------------------------------------

fn lock() -> Result<std::sync::MutexGuard<'static, Registry>> {
    registry().lock().map_err(|_| anyhow!("registry poisoned"))
}

fn create_session(language: &str) -> Result<jlong> {
    let gid = *register_all()
        .get(language)
        .ok_or_else(|| anyhow!("unknown language: {language}"))?;
    let mut reg = lock()?;
    let sid = reg
        .create_session(gid)
        .ok_or_else(|| anyhow!("session creation failed"))?;
    Ok(jlong::from(sid))
}

fn set_text(session: jlong, text: &str) -> Result<()> {
    lock()?.set_text(session as u32, text);
    Ok(())
}

fn cancel(session: jlong) -> Result<()> {
    lock()?.cancel(session as u32);
    Ok(())
}

fn free_session(session: jlong) -> Result<()> {
    lock()?.free_session(session as u32);
    Ok(())
}

fn highlight_spans_json(session: jlong, max_depth: u32) -> Result<String> {
    let mut reg = lock()?;
    let out = highlight_to_themed_utf16(&mut reg, session as u32, max_depth)
        .map_err(|e| anyhow!("{e:?}"))?;
    Ok(serde_json::to_string(&out)?)
}

fn highlight_html_json(session: jlong, max_depth: u32, format: u32, prefix: &str) -> Result<String> {
    let fmt = decode_format(format, prefix);
    let mut reg = lock()?;
    let out =
        highlight_to_html(&mut reg, session as u32, max_depth, fmt).map_err(|e| anyhow!("{e:?}"))?;
    Ok(serde_json::to_string(&out)?)
}

// --- JNI glue --------------------------------------------------------------

/// Read a Java `String` argument into an owned Rust `String`.
fn read_string(env: &mut JNIEnv, s: &JString) -> Result<String> {
    Ok(env.get_string(s)?.into())
}

/// Throw a `RuntimeException` carrying `e`'s message. Best-effort: if a throw
/// is already pending, the JVM keeps the first one.
fn throw(env: &mut JNIEnv, e: anyhow::Error) {
    let _ = env.throw_new("java/lang/RuntimeException", e.to_string());
}

/// Materialize a Rust `String` result as a Java `String`, throwing on either a
/// Rust-side error or a JNI allocation failure. Returns a null jstring after a
/// throw (the pending exception is what the caller observes).
fn respond_string(env: &mut JNIEnv, result: Result<String>) -> jstring {
    match result {
        Ok(s) => match env.new_string(s) {
            Ok(js) => js.into_raw(),
            Err(e) => {
                throw(env, anyhow!(e));
                JObject::null().into_raw()
            }
        },
        Err(e) => {
            throw(env, e);
            JObject::null().into_raw()
        }
    }
}

/// `String[] availableLanguages()` — the ids of every bundled grammar, sorted.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_discord_arborium_ArboriumNative_availableLanguages<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
) -> jobjectArray {
    match build_languages(&mut env) {
        Ok(arr) => arr,
        Err(e) => {
            throw(&mut env, e);
            JObject::null().into_raw()
        }
    }
}

fn build_languages(env: &mut JNIEnv) -> Result<jobjectArray> {
    let langs = arborium_rt_native::available_languages();
    let arr = env.new_object_array(langs.len() as i32, "java/lang/String", JObject::null())?;
    for (i, lang) in langs.iter().enumerate() {
        let js = env.new_string(lang)?;
        env.set_object_array_element(&arr, i as i32, &js)?;
    }
    Ok(arr.into_raw())
}

/// `long createSession(String language)` — open a registry session for a
/// bundled grammar id. Throws if the language is unknown.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_discord_arborium_ArboriumNative_createSession<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    language: JString<'local>,
) -> jlong {
    let r = read_string(&mut env, &language).and_then(|l| create_session(&l));
    match r {
        Ok(id) => id,
        Err(e) => {
            throw(&mut env, e);
            0
        }
    }
}

/// `void setText(long session, String text)` — replace the session text and
/// parse it immediately.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_discord_arborium_ArboriumNative_setText<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    session: jlong,
    text: JString<'local>,
) {
    let r = read_string(&mut env, &text).and_then(|t| set_text(session, &t));
    if let Err(e) = r {
        throw(&mut env, e);
    }
}

/// `void cancel(long session)` — cancel an in-progress parse/highlight.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_discord_arborium_ArboriumNative_cancel<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    session: jlong,
) {
    if let Err(e) = cancel(session) {
        throw(&mut env, e);
    }
}

/// `void freeSession(long session)` — free the registry session. Idempotent.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_discord_arborium_ArboriumNative_freeSession<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    session: jlong,
) {
    if let Err(e) = free_session(session) {
        throw(&mut env, e);
    }
}

/// `String highlightToSpans(long session, int maxDepth)` — full pipeline →
/// JSON `{spans, missing_injections, timed_out_languages}` with UTF-16 offsets.
/// A negative `maxDepth` falls back to the default.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_discord_arborium_ArboriumNative_highlightToSpans<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    session: jlong,
    max_depth: jint,
) -> jstring {
    let depth = depth_or_default(max_depth);
    let result = highlight_spans_json(session, depth);
    respond_string(&mut env, result)
}

/// `String highlightToHtml(long session, int maxDepth, int format, String prefix)`
/// — full pipeline → JSON `{html, missing_injections, timed_out_languages}`.
/// `format` matches `arborium_rt::highlight::decode_format` (0 = custom-elements,
/// 1 = custom-with-prefix, 2 = class-names, 3 = class-with-prefix); `prefix`
/// applies only to the two `*WithPrefix` variants.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_discord_arborium_ArboriumNative_highlightToHtml<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    session: jlong,
    max_depth: jint,
    format: jint,
    prefix: JString<'local>,
) -> jstring {
    let depth = depth_or_default(max_depth);
    let result = read_string(&mut env, &prefix)
        .and_then(|p| highlight_html_json(session, depth, format.max(0) as u32, &p));
    respond_string(&mut env, result)
}

/// A negative depth (the Kotlin sentinel for "unset") falls back to the default.
fn depth_or_default(max_depth: jint) -> u32 {
    if max_depth < 0 {
        DEFAULT_MAX_INJECTION_DEPTH
    } else {
        max_depth as u32
    }
}
