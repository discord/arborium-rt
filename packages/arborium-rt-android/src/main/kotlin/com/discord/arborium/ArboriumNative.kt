package com.discord.arborium

/**
 * Low-level JNI bindings to `libarborium_rt.so` (built from `ffi/android`).
 *
 * These map 1:1 to the `Java_com_discord_arborium_ArboriumNative_*` exports in
 * the Rust shim. Session ids are the runtime's `u32` handles widened to `Long`;
 * `0` is never a valid session. The `highlight*` methods return JSON strings
 * that [Session] deserializes. Prefer the typed [Arborium]/[Session] API — this
 * object is internal to the binding.
 */
internal object ArboriumNative {
    init {
        System.loadLibrary("arborium_rt")
    }

    external fun availableLanguages(): Array<String>

    external fun createSession(language: String): Long

    external fun setText(session: Long, text: String)

    external fun cancel(session: Long)

    external fun freeSession(session: Long)

    /** JSON `{spans, missing_injections, timed_out_languages}`. */
    external fun highlightToSpans(session: Long, maxDepth: Int): String

    /** JSON `{html, missing_injections, timed_out_languages}`. */
    external fun highlightToHtml(session: Long, maxDepth: Int, format: Int, prefix: String): String
}
