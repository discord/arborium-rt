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
// The blob also carries the lex functions as data, run by `ts_packed_lex`;
// the external scanner stays compiled code in the grammar's own module and is
// passed in through `TSPackedFunctions`.

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
typedef struct TSPackedLexer TSPackedLexer;

typedef struct {
  // The language's lex functions. When the blob carries the lexers as data,
  // these are stubs that call ts_packed_lex() with the program the loader
  // stores through `lex_program` / `keyword_lex_program`.
  bool (*lex_fn)(TSLexer *, uint16_t);
  bool (*keyword_lex_fn)(TSLexer *, uint16_t);
  const TSPackedLexer **lex_program;
  const TSPackedLexer **keyword_lex_program;
  void *(*external_scanner_create)(void);
  void (*external_scanner_destroy)(void *);
  bool (*external_scanner_scan)(void *, TSLexer *, const bool *);
  unsigned (*external_scanner_serialize)(void *, char *);
  void (*external_scanner_deserialize)(void *, const char *, unsigned);
} TSPackedFunctions;

// Run a packed lex program; behaves exactly like the generated lex function.
bool ts_packed_lex(const TSPackedLexer *program, TSLexer *lexer, uint16_t state);

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
