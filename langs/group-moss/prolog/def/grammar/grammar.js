/**
 * @file Prolog grammar for tree-sitter (DataGrout)
 * @license MIT
 *
 * A SUPERSET grammar: ISO core + SWI dicts + ProbLog `::` annotations + DCG.
 *
 * Prolog reading is operator-precedence driven with user-definable `op/3`,
 * which tree-sitter cannot model at runtime. We therefore approximate a
 * *static superset* of the ISO standard operator table plus the common
 * SWI / CLP(FD) operators. Dialect detection (is this ISO-conformant? does it
 * use SWI dicts / ProbLog / call_tool?) is the downstream analyzer's job, not
 * the grammar's.
 *
 * Two operator towers share the same primaries:
 *   - `_term`  : full priority range (includes `,` `;` `->` `:-` `-->`).
 *                Used at clause top level, inside `( )` and `{ }`.
 *   - `_arg`   : priority < 1000 (EXCLUDES `,` and the clause operators).
 *                Used for compound-term arguments and list elements, so
 *                `foo(a, b)` is a 2-arg term — not `foo(','(a,b))`.
 *
 * tree-sitter precedence: HIGHER binds tighter. ISO priority is the inverse
 * (lower number binds tighter), so the numbers below are the *inverse* order.
 */

const PREC = {
  clause: 1, //  :- ?- --> (1200)
  decl: 2, //    dynamic/discontiguous/... prefix (1150)
  semicolon: 3, // ; | (1100)
  arrow: 4, //   -> *-> (1050)
  comma: 5, //   , (1000)
  not: 6, //     \+ prefix (900)
  compare: 7, // = \= == is < > =.. @< ... :: (700)
  colon: 8, //   : module-qualify (600)
  add: 9, //     + - /\ \/ xor (500)
  mul: 10, //    * / // mod rem div << >> .. (400)
  pow: 11, //    ** ^ (200)
  unary: 12, //  - + \ prefix (200)
  primary: 20,
};

// 700-priority comparison / unification / type-check operators (xfx, ISO + CLP).
const COMPARE_OPS = [
  '=', '\\=', '==', '\\==', '@<', '@>', '@=<', '@>=', '=..',
  'is', '=:=', '=\\=', '<', '>', '=<', '>=', '>:<', ':<', 'as',
  '#=', '#\\=', '#<', '#>', '#=<', '#>=', 'in', 'ins',
];
const ADD_OPS = ['+', '-', '/\\', '\\/', 'xor'];
const MUL_OPS = ['*', '/', '//', 'rem', 'mod', 'div', 'rdiv', 'gcd', '<<', '>>', '..'];
const CONTROL_OPS = [':-', '-->', '?-', '::', ';', '|', '->', '*->', ':', '**', '^', '\\+'];
// Misc symbolic atoms that also appear as functors / bare atoms, e.g. SWI's
// reserved-term tag `@(true)` and `$VAR`.
const EXTRA_OPS = ['@', '$', '?'];
// Every operator that may legally appear bare inside parentheses as an atom,
// e.g. `Order = (<)`, `maplist((:-), L)`. De-duplicated.
const ALL_OPS = [...new Set([...COMPARE_OPS, ...ADD_OPS, ...MUL_OPS, ...CONTROL_OPS, ...EXTRA_OPS])];
const DECL_OPS = [
  'dynamic', 'discontiguous', 'multifile', 'initialization',
  'meta_predicate', 'module_transparent', 'volatile', 'public', 'table',
];

module.exports = grammar({
  name: 'prolog',

  word: $ => $.unquoted_atom,

  extras: $ => [/\s/, $.line_comment, $.block_comment],

  rules: {
    source_file: $ => repeat($._clause_or_directive),

    // A clause / directive is a term terminated by the end token `.`.
    _clause_or_directive: $ => $.clause,
    clause: $ => seq(field('term', $._term), $._end),

    // The clause terminator: `.` (we do NOT model `.` as an operator, so a
    // bare dot is unambiguous; floats carry their own embedded dot token).
    _end: _ => token(prec(-1, '.')),

    // ───────────────────────── term towers ─────────────────────────

    _term: $ => choice($.binary_operation, $.unary_operation, $._primary),

    binary_operation: $ => choice(
      prec.right(PREC.clause, seq(field('left', $._term), field('operator', choice(':-', '-->')), field('right', $._term))),
      prec.right(PREC.semicolon, seq(field('left', $._term), field('operator', choice(';', '|')), field('right', $._term))),
      prec.right(PREC.arrow, seq(field('left', $._term), field('operator', choice('->', '*->')), field('right', $._term))),
      prec.right(PREC.comma, seq(field('left', $._term), field('operator', ','), field('right', $._term))),
      prec.left(PREC.compare, seq(field('left', $._term), field('operator', choice(...COMPARE_OPS)), field('right', $._term))),
      prec.right(PREC.compare, seq(field('left', $._term), field('operator', '::'), field('right', $._term))),
      prec.right(PREC.colon, seq(field('left', $._term), field('operator', ':'), field('right', $._term))),
      prec.left(PREC.add, seq(field('left', $._term), field('operator', choice(...ADD_OPS)), field('right', $._term))),
      prec.left(PREC.mul, seq(field('left', $._term), field('operator', choice(...MUL_OPS)), field('right', $._term))),
      prec.left(PREC.pow, seq(field('left', $._term), field('operator', '**'), field('right', $._term))),
      prec.right(PREC.pow, seq(field('left', $._term), field('operator', '^'), field('right', $._term))),
    ),

    unary_operation: $ => choice(
      prec.right(PREC.clause, seq(field('operator', choice(':-', '?-')), field('operand', $._term))),
      prec.right(PREC.decl, seq(field('operator', choice(...DECL_OPS)), field('operand', $._term))),
      prec.right(PREC.not, seq(field('operator', '\\+'), field('operand', $._term))),
      prec.right(PREC.unary, seq(field('operator', choice('-', '+', '\\')), field('operand', $._term))),
    ),

    // Argument / list-element tower — priority < 1000 (no comma operator).
    // The two operator rules are hidden but ALIASED back to the same visible
    // node names as the term tower (`binary_operation` / `unary_operation`) so
    // arg-internal operator structure is preserved rather than promoted away.
    _arg: $ => choice(
      alias($._arg_binary, $.binary_operation),
      alias($._arg_unary, $.unary_operation),
      $._primary,
    ),

    _arg_binary: $ => choice(
      prec.left(PREC.compare, seq(field('left', $._arg), field('operator', choice(...COMPARE_OPS)), field('right', $._arg))),
      prec.right(PREC.compare, seq(field('left', $._arg), field('operator', '::'), field('right', $._arg))),
      prec.right(PREC.colon, seq(field('left', $._arg), field('operator', ':'), field('right', $._arg))),
      prec.left(PREC.add, seq(field('left', $._arg), field('operator', choice(...ADD_OPS)), field('right', $._arg))),
      prec.left(PREC.mul, seq(field('left', $._arg), field('operator', choice(...MUL_OPS)), field('right', $._arg))),
      prec.left(PREC.pow, seq(field('left', $._arg), field('operator', '**'), field('right', $._arg))),
      prec.right(PREC.pow, seq(field('left', $._arg), field('operator', '^'), field('right', $._arg))),
    ),

    _arg_unary: $ => choice(
      prec.right(PREC.not, seq(field('operator', '\\+'), field('operand', $._arg))),
      prec.right(PREC.unary, seq(field('operator', choice('-', '+', '\\')), field('operand', $._arg))),
    ),

    // ───────────────────────── primaries ─────────────────────────

    _primary: $ => choice(
      $.dict_access,
      $.compound_term,
      $.dict,
      $.list,
      $.curly_block,
      $.parenthesized,
      $.operator_atom,
      $.atom,
      $.variable,
      $.number,
      $.string,
      $.back_quoted_string,
      $.cut,
    ),

    // An operator used as a plain atom (a "name"), e.g. the sole argument in
    // `lc_allowed_predicate(=)`, `maplist(is, ...)`, or parenthesized as `(<)`
    // (the parens come from the `parenthesized` rule). Low precedence so that
    // an operator with operands always parses as a binary/unary operation.
    operator_atom: _ => prec(-1, choice(...ALL_OPS)),

    // SWI dict functional access: `Dict.key`. The whole `.key` is a single
    // `token.immediate` (no layout between the dot and the key), which
    // disambiguates it from the clause terminator `.` — that dot is always
    // followed by layout/EOF, never by an immediately-adjacent key.
    dict_access: $ => prec.left(PREC.primary, seq(
      field('object', choice($.variable, $.dict, $.compound_term, $.parenthesized)),
      repeat1(field('access', $.dict_access_key)),
    )),
    // `.key` field access, or `.method(Args)` (SWI dict method, e.g. `.put(D)`).
    dict_access_key: $ => seq(
      field('key', $._dict_key),
      optional(seq(token.immediate('('), sep1(',', field('argument', $._arg)), ')')),
    ),
    _dict_key: _ => token.immediate(/\.[a-z][a-zA-Z0-9_]*/),

    // functor(args) — `(` must be immediate (no layout) per ISO. The functor is
    // usually an atom, but symbolic operators are valid functors in canonical
    // form too (e.g. SWI's `@(true)`, or `=(X, Y)`).
    compound_term: $ => prec(PREC.primary, seq(
      field('functor', choice($.atom, $.operator_atom)),
      token.immediate('('),
      sep1(',', field('argument', $._arg)),
      ')',
    )),

    // SWI dict: Tag{k: v, ...}  with Tag an atom or var; `{` is immediate.
    dict: $ => prec(PREC.primary, seq(
      field('tag', choice($.atom, $.variable)),
      token.immediate('{'),
      sep(',', field('pair', $.dict_pair)),
      '}',
    )),
    dict_pair: $ => seq(field('key', choice($.atom, $.number)), ':', field('value', $._arg)),

    list: $ => seq(
      '[',
      optional(seq(
        sep1(',', field('element', $._arg)),
        optional(seq('|', field('tail', $._arg))),
      )),
      ']',
    ),

    // `{ Goals }` — grouping used in DCG bodies and as a curly term.
    curly_block: $ => seq('{', optional($._term), '}'),

    parenthesized: $ => seq('(', $._term, ')'),

    // ───────────────────────── tokens ─────────────────────────

    atom: $ => choice($.unquoted_atom, $.quoted_atom),
    unquoted_atom: _ => /[a-z][a-zA-Z0-9_]*/,
    quoted_atom: _ => /'([^'\\]|\\.|'')*'/,

    variable: _ => /[A-Z_][a-zA-Z0-9_]*/,

    cut: _ => '!',

    number: $ => choice($._float, $._integer, $._char_code),
    _float: _ => token(choice(
      /[0-9]+\.[0-9]+([eE][+-]?[0-9]+)?/, // 3.14, 6.02e23
      /[0-9]+[eE][+-]?[0-9]+/, // 1e-9, 2E10 (no fractional part)
    )),
    _integer: _ => token(choice(
      /0x[0-9a-fA-F]+/,
      /0o[0-7]+/,
      /0b[01]+/,
      /[0-9]+/,
    )),
    _char_code: _ => token(/0'(\\.|[^\\])/),

    string: _ => /"([^"\\]|\\.|"")*"/,
    back_quoted_string: _ => /`([^`\\]|\\.)*`/,

    line_comment: _ => token(/%[^\n]*/),
    block_comment: _ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),
  },
});

function sep1(separator, rule) {
  return seq(rule, repeat(seq(separator, rule)));
}

function sep(separator, rule) {
  return optional(sep1(separator, rule));
}
