// Public API for @appellation/arborium-rt.

export {
    loadArboriumRuntime,
    Runtime,
    Grammar,
    Session,
    type LoadArboriumRuntimeOptions,
    type LoadGrammarOptions,
    type ArboriumGrammarPackage,
} from './runtime.js';

export {
    ABI_VERSION,
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
    Edit,
} from './types.js';
