package com.discord.arborium

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * One themed span: UTF-16 `[start, end)` code-unit offsets tagged with the short
 * theme slot (`"k"`, `"f"`, `"s"`, …). Structurally identical to the wasm/node
 * packages' `ThemedSpan` so highlighting is interchangeable across targets.
 */
@Serializable
public data class ThemedSpan(
    val start: Int,
    val end: Int,
    val tag: String,
)

@Serializable
public data class HighlightSpansResult(
    val spans: List<ThemedSpan> = emptyList(),
    /** Languages referenced by injections but not bundled in this artifact. */
    @SerialName("missing_injections") val missingInjections: List<String> = emptyList(),
    /** Languages whose parse exceeded the wall-clock budget (partial output). */
    @SerialName("timed_out_languages") val timedOutLanguages: List<String> = emptyList(),
)

@Serializable
public data class HighlightHtmlResult(
    val html: String,
    @SerialName("missing_injections") val missingInjections: List<String> = emptyList(),
    @SerialName("timed_out_languages") val timedOutLanguages: List<String> = emptyList(),
)

/** HTML markup style; `code` is the integer the native layer expects. */
public enum class HtmlFormat(internal val code: Int) {
    CustomElements(0),
    CustomElementsWithPrefix(1),
    ClassNames(2),
    ClassNamesWithPrefix(3),
}

/** `-1` tells the native layer to use its default injection depth (3). */
private const val DEFAULT_DEPTH_SENTINEL = -1

private val JSON = Json { ignoreUnknownKeys = true }

/** Entry point for one-shot highlighting and grammar discovery. */
public object Arborium {
    /** The ids of every grammar bundled in this artifact, sorted. */
    public fun availableLanguages(): List<String> =
        ArboriumNative.availableLanguages().toList()

    /** One-shot: highlight [text] as [language] into themed UTF-16 spans. */
    public fun highlightToSpans(
        language: String,
        text: String,
        maxInjectionDepth: Int = DEFAULT_DEPTH_SENTINEL,
    ): HighlightSpansResult = Session(language).use {
        it.setText(text)
        it.highlightToSpans(maxInjectionDepth)
    }

    /** One-shot: highlight [text] as [language] into a rendered HTML string. */
    public fun highlightToHtml(
        language: String,
        text: String,
        maxInjectionDepth: Int = DEFAULT_DEPTH_SENTINEL,
        format: HtmlFormat = HtmlFormat.CustomElements,
        prefix: String = "",
    ): HighlightHtmlResult = Session(language).use {
        it.setText(text)
        it.highlightToHtml(maxInjectionDepth, format, prefix)
    }
}

/**
 * A reusable parse session for one document. Open it for a bundled grammar id,
 * [setText], then call the highlight methods. Backed by a native registry
 * session that is freed on [close] — use it with `use { … }` (it is
 * [AutoCloseable]) or call [close] explicitly.
 */
public class Session(language: String) : AutoCloseable {
    private var id: Long = ArboriumNative.createSession(language)

    /** Replace the session text and parse it immediately. */
    public fun setText(text: String) {
        ArboriumNative.setText(id, text)
    }

    /** Full pipeline → themed UTF-16 spans. */
    public fun highlightToSpans(
        maxInjectionDepth: Int = DEFAULT_DEPTH_SENTINEL,
    ): HighlightSpansResult =
        JSON.decodeFromString(ArboriumNative.highlightToSpans(id, maxInjectionDepth))

    /** Full pipeline → rendered HTML. */
    public fun highlightToHtml(
        maxInjectionDepth: Int = DEFAULT_DEPTH_SENTINEL,
        format: HtmlFormat = HtmlFormat.CustomElements,
        prefix: String = "",
    ): HighlightHtmlResult =
        JSON.decodeFromString(
            ArboriumNative.highlightToHtml(id, maxInjectionDepth, format.code, prefix),
        )

    /** Cancel an in-progress parse/highlight (cooperative wall-clock budget). */
    public fun cancel() {
        ArboriumNative.cancel(id)
    }

    /** Free the native session. Idempotent. */
    override fun close() {
        if (id != 0L) {
            ArboriumNative.freeSession(id)
            id = 0L
        }
    }
}
