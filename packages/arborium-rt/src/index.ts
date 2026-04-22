// Public API for @appellation/arborium-rt.

export {
    loadArboriumRuntime,
    Runtime,
    Grammar,
    Session,
    type LoadGrammarOptions,
    type ArboriumGrammarPackage,
    type HighlightOptions,
    type HighlightToHtmlOptions,
} from './runtime.js';

export {
    ArboriumError,
    type ArboriumErrorKind,
    type HostModule,
    type HostModuleFactory,
    type RuntimeAbi,
    type WasmSource,
} from './abi.js';

export type {
    Utf16Span,
    Utf16Injection,
    Utf16ParseResult,
    ThemedSpan,
    ThemedHighlightResult,
    HtmlFormat,
    Edit,
} from './types.js';
