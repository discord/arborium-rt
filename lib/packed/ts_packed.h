// Packed tree-sitter language tables.
//
// A generated parser.c is ~90% static tables (the LR parse table, its action
// lists, lex modes, symbol metadata, ...). For a SIDE_MODULE grammar those
// tables are the bulk of the wasm. The packed format stores them as a single
// compact, entropy-coded blob that `ts_packed_language_load` expands into an
// ordinary heap-allocated `TSLanguage` the first time a grammar asks for its
// language. The expanded tables are byte-for-byte identical to the ones
// `tree-sitter generate` emitted; `pack.c` verifies that for every grammar at
// build time.
//
// The lex functions and external scanner stay compiled code in the grammar's
// own module and are passed in through `TSPackedFunctions`.

#ifndef TS_PACKED_H_
#define TS_PACKED_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TSLanguage TSLanguage;
typedef struct TSLexer TSLexer;

typedef struct {
  bool (*lex_fn)(TSLexer *, uint16_t);
  bool (*keyword_lex_fn)(TSLexer *, uint16_t);
  void *(*external_scanner_create)(void);
  void (*external_scanner_destroy)(void *);
  bool (*external_scanner_scan)(void *, TSLexer *, const bool *);
  unsigned (*external_scanner_serialize)(void *, char *);
  void (*external_scanner_deserialize)(void *, const char *, unsigned);
} TSPackedFunctions;

// Expand a packed blob into a newly allocated language. Returns NULL if the
// blob is malformed or allocation fails. The language is never freed.
const TSLanguage *ts_packed_language_load(
  const uint8_t *data,
  size_t length,
  const TSPackedFunctions *functions
);

#ifdef __cplusplus
}
#endif

#endif  // TS_PACKED_H_
