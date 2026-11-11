#include <stdio.h>
#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"
#include <wctype.h>

enum TokenType {
  BLOCK_COMMENT_START,
  BLOCK_COMMENT_CONTENT,
  BLOCK_COMMENT_END,

  BLOCK_STRING_START,
  BLOCK_STRING_CONTENT,
  BLOCK_STRING_END,
};

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline bool consume_char(char c, TSLexer *lexer) {
  if (lexer->lookahead != c) {
    return false;
  }

  advance(lexer);
  return true;
}

static inline uint8_t consume_and_count_char(char c, TSLexer *lexer) {
  uint8_t count = 0;
  while (lexer->lookahead == c) {
    ++count;
    advance(lexer);
  }
  return count;
}

static inline void skip_whitespaces(TSLexer *lexer) {
  while (iswspace(lexer->lookahead)) {
    skip(lexer);
  }
}

// Data that for access through calls
typedef struct {
  char ending_char;
  uint8_t level_count;
} Scanner;

static inline void reset_state(Scanner *scanner) {
  scanner->ending_char = 0;
  scanner->level_count = 0;
}

void *tree_sitter_luau_external_scanner_create() {
  Scanner *scanner = ts_calloc(1, sizeof(Scanner));
  return scanner;
}

void tree_sitter_luau_external_scanner_destroy(void *payload) {
  Scanner *scanner = (Scanner *)payload;
  ts_free(scanner);
}

// Tree-sitter serializes a snapshot
unsigned tree_sitter_luau_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *scanner = (Scanner *)payload;
  buffer[0] = scanner->ending_char;
  buffer[1] = (char)scanner->level_count;
  return 2;
}

// Tree-sitter restores a snapshot
void tree_sitter_luau_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *scanner = (Scanner *)payload;
  if (length == 0) return;
  scanner->ending_char = buffer[0];
  if (length == 1) return;
  scanner->level_count = buffer[1];
}

// Detect "[["
static bool scan_block_start(Scanner *scanner, TSLexer *lexer) {
    // Do we have "["
    if (consume_char('[', lexer)) {
        // Is there a "=" somewhere that tells us the depth?
        uint8_t level = consume_and_count_char('=', lexer);

        // Is there another "[" for this to be valid?
        if (consume_char('[', lexer)) {
            scanner->level_count = level;
            return true;
        }
    }

    return false;
}

static bool scan_block_end(Scanner *scanner, TSLexer *lexer) {
    // Same as before
    if (consume_char(']', lexer)) {
        uint8_t level = consume_and_count_char('=', lexer);

        // Is the level count matching for the current level or something?
        if (scanner->level_count == level && consume_char(']', lexer)) {
            return true;
        }
    }

    return false;
}

static bool scan_block_content(Scanner *scanner, TSLexer *lexer) {
  while (lexer->lookahead != 0) {
    if (lexer->lookahead == ']') {
      lexer->mark_end(lexer);

      if (scan_block_end(scanner, lexer)) {
        return true;
      }
    } else {
      advance(lexer);
    }
  }

  return false;
}

static bool scan_comment_start(Scanner *scanner, TSLexer *lexer) {
  if (consume_char('-', lexer) && consume_char('-', lexer)) {
    lexer->mark_end(lexer);

    if (scan_block_start(scanner, lexer)) {
      lexer->mark_end(lexer);
      lexer->result_symbol = BLOCK_COMMENT_START;
      return true;
    }
  }

  return false;
}

static bool scan_comment_content(Scanner *scanner, TSLexer *lexer) {
  if (scanner->ending_char == 0) { // block comment
    if (scan_block_content(scanner, lexer)) {
      lexer->result_symbol = BLOCK_COMMENT_CONTENT;
      return true;
    }

    return false;
  }

  while (lexer->lookahead != 0) {
    if (lexer->lookahead == scanner->ending_char) {
      reset_state(scanner);
      lexer->result_symbol = BLOCK_COMMENT_CONTENT;
      return true;
    }

    advance(lexer);
  }

  return false;
}

bool tree_sitter_luau_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *scanner = (Scanner *)payload;

  if (valid_symbols[BLOCK_STRING_END] && scan_block_end(scanner, lexer)) {
    reset_state(scanner);
    lexer->result_symbol = BLOCK_STRING_END;
    return true;
  }

  if (valid_symbols[BLOCK_STRING_CONTENT] && scan_block_content(scanner, lexer)) {
    lexer->result_symbol = BLOCK_STRING_CONTENT;
    return true;
  }

  if (valid_symbols[BLOCK_COMMENT_END] && scanner->ending_char == 0 && scan_block_end(scanner, lexer)) {
    reset_state(scanner);
    lexer->result_symbol = BLOCK_COMMENT_END;
    return true;
  }

  if (valid_symbols[BLOCK_COMMENT_CONTENT] && scan_comment_content(scanner, lexer)) {
    return true;
  }

  skip_whitespaces(lexer);

  if (valid_symbols[BLOCK_STRING_START] && scan_block_start(scanner, lexer)) {
    lexer->result_symbol = BLOCK_STRING_START;
    return true;
  }

  if (valid_symbols[BLOCK_COMMENT_START]) {
    if (scan_comment_start(scanner, lexer)) {
      return true;
    }
  }

  return false;
}
