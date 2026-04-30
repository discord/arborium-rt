// Build web-tree-sitter.wasm (MAIN_MODULE=2) + .mjs loader. Port of
// `scripts/build-host-wasm.sh`.
//
// Concatenates the upstream-maintained `stdlib-symbols.txt` +
// `binding_web/lib/exports.txt` with the two deltas arborium-rt imports:
// plain `ts_*` names (upstream only exports `*_wasm` JS-bridge variants)
// and the libc/pthread surface Rust's std pulls in.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger, hasCommand, paths, run } from './util.js';

/**
 * Plain tree-sitter C symbols arborium-rt's runtime imports that aren't in
 * `binding_web/lib/exports.txt`. Discovered empirically via
 * `wasm-dis arborium_emscripten_runtime.wasm | grep '(import "env"'`.
 * Long-term these should migrate upstream.
 */
const EXTRA_TS_EXPORTS = [
    // Parser lifecycle + language management (spike step 3).
    '_ts_parser_new',
    '_ts_parser_logger',
    '_ts_parser_print_dot_graphs',
    '_ts_parser_set_logger',
    '_ts_parser_parse_with_options',
    '_ts_language_delete',
    // Query cursor alloc/dealloc (spike step 3).
    '_ts_query_cursor_new',
    '_ts_query_cursor_delete',
    // Tree root walk (spike step 4).
    '_ts_tree_root_node',
    // Query execution + node-byte offsets (new for arborium-rt's highlight path).
    '_ts_query_cursor_exec',
    // _with_options variant: arborium-plugin-runtime uses this to install a
    // wall-clock-budget progress callback that interrupts O(n^2) queries
    // before they freeze the host. See `parse_raw` in the plugin runtime.
    '_ts_query_cursor_exec_with_options',
    '_ts_query_cursor_next_match',
    '_ts_node_start_byte',
    '_ts_node_end_byte',
];

/**
 * libc / pthread symbols Rust std imports beyond what `stdlib-symbols.txt`
 * covers (which is just malloc/memcpy-level). Same discovery method.
 * All of these are provided by emcc's libc or its pthread no-op stubs.
 */
const EXTRA_LIBC_EXPORTS = [
    '_abort',
    // Used by std::time::Instant in arborium-plugin-runtime's wall-clock
    // budget (deadline check inside the QueryCursor progress callback).
    '_clock_gettime',
    '_getcwd',
    '_getentropy',
    '_getenv',
    '_posix_memalign',
    '_strerror_r',
    '_write',
    '_writev',
    '_pthread_cond_destroy',
    '_pthread_cond_init',
    '_pthread_cond_signal',
    '_pthread_cond_wait',
    '_pthread_condattr_destroy',
    '_pthread_condattr_init',
    '_pthread_condattr_setclock',
    '_pthread_mutex_destroy',
    '_pthread_mutex_init',
    '_pthread_mutex_lock',
    '_pthread_mutex_trylock',
    '_pthread_mutex_unlock',
    '_pthread_mutexattr_destroy',
    '_pthread_mutexattr_init',
    '_pthread_mutexattr_settype',
];

/**
 * Runtime methods the emscripten loader needs accessible as JS properties on
 * the Module instance.
 */
const EXPORTED_RUNTIME_METHODS = [
    'AsciiToString',
    'stringToUTF8',
    'UTF8ToString',
    'lengthBytesUTF8',
    'stringToUTF16',
    'loadWebAssemblyModule',
    'getValue',
    'setValue',
    'HEAPF32',
    'HEAPF64',
    'HEAP_DATA_VIEW',
    'HEAP8',
    'HEAPU8',
    'HEAP16',
    'HEAPU16',
    'HEAP32',
    'HEAPU32',
    'HEAP64',
    'HEAPU64',
    'LE_HEAP_STORE_I64',
];

export async function buildHost(): Promise<void> {
    const p = paths();
    const log = new Logger('host');

    if (!await hasCommand('emcc')) {
        throw new Error('emcc not found on PATH. install emsdk 4.0.15 and source emsdk_env.sh.');
    }

    mkdirSync(p.hostWasmOut, { recursive: true });

    const baseExports = [
        join(p.bindingRoot, 'src', 'wasm', 'stdlib-symbols.txt'),
        join(p.bindingRoot, 'binding_web', 'lib', 'exports.txt'),
    ]
        .map((f) =>
            readFileSync(f, 'utf8')
                .split('\n')
                .map((line) => line.trim().replace(/^"/, '').replace(/",?$/, ''))
                .filter((s) => s.length > 0)
                .map((s) => `_${s}`)
                .join(','),
        )
        .filter((s) => s.length > 0)
        .join(',');

    const exports = [baseExports, ...EXTRA_TS_EXPORTS, ...EXTRA_LIBC_EXPORTS].join(',');

    log.step('compiling web-tree-sitter.wasm (MAIN_MODULE=2)');
    await run(
        log,
        'emcc',
        [
            '-O2', '--minify', '0',
            '-gsource-map=inline',
            '-fno-exceptions',
            '-std=c11',
            '-s', 'WASM=1',
            '-s', 'MODULARIZE=1',
            '-s', 'EXPORT_ES6=1',
            // web,worker only — drops the Node branch that emits
            // `await import("module")` and bare `require("fs"|"path"|"url"|"crypto")`
            // calls, which rspack/webpack static-analyze and reject. The
            // runtime loader pre-fetches the host wasm via resolveWasm and
            // hands it to the factory as `Module.wasmBinary`, so Node tests
            // don't rely on the dropped fs-based auto-loader.
            '-s', 'ENVIRONMENT=web,worker',
            '-s', 'INITIAL_MEMORY=33554432',
            '-s', 'ALLOW_MEMORY_GROWTH=1',
            '-s', 'SUPPORT_BIG_ENDIAN=1',
            '-s', 'WASM_BIGINT=1',
            '-s', 'MAIN_MODULE=2',
            '-s', 'FILESYSTEM=0',
            '-s', 'NODEJS_CATCH_EXIT=0',
            '-s', 'NODEJS_CATCH_REJECTION=0',
            '-s', `EXPORTED_FUNCTIONS=${exports}`,
            '-s', `EXPORTED_RUNTIME_METHODS=${EXPORTED_RUNTIME_METHODS.join(',')}`,
            '-D', 'fprintf(...)=',
            '-D', 'printf(...)=',
            '-D', 'NDEBUG=',
            '-D', '_POSIX_C_SOURCE=200112L',
            '-D', '_DEFAULT_SOURCE=',
            '-D', '_BSD_SOURCE=',
            '-D', '_DARWIN_C_SOURCE=',
            '-I', 'src',
            '-I', 'include',
            '--js-library', 'binding_web/lib/imports.js',
            '--pre-js', 'binding_web/lib/prefix.js',
            '-o', join(p.hostWasmOut, 'web-tree-sitter.mjs'),
            'src/lib.c',
            'binding_web/lib/tree-sitter.c',
        ],
        { cwd: p.bindingRoot },
    );

    log.step(`built web-tree-sitter.{wasm,mjs} in ${p.hostWasmOut}`);
}
