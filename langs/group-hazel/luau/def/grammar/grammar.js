/**
 * @file Luau grammar for tree-sitter
 * @author Amaan Qureshi <amaanq12@gmail.com>
 * @license MIT
 */


/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

//const lua = require('@muniftanjim/tree-sitter-lua/grammar');
//const lua = require('../../../../lua/build/grammar-stage/grammar/grammar.js');

const lua = (function() {
  /**
 * @file Lua grammar for tree-sitter
 * @author Munif Tanjim
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  OR: 1, // or
  AND: 2, // and
  COMPARE: 3, // < > <= >= ~= ==
  BIT_OR: 4, // |
  BIT_NOT: 5, // ~
  BIT_AND: 6, // &
  BIT_SHIFT: 7, // << >>
  CONCAT: 8, // ..
  PLUS: 9, // + -
  MULTI: 10, // * / // %
  UNARY: 11, // not # - ~
  POWER: 12, // ^
};

const list_seq = (rule, separator, trailing_separator = false) =>
  trailing_separator
    ? seq(rule, repeat(seq(separator, rule)), optional(separator))
    : seq(rule, repeat(seq(separator, rule)));

const optional_block = ($) => alias(optional($._block), $.block);

// namelist ::= Name {',' Name}
const name_list = ($) => list_seq(field('name', $.identifier), ',');

return grammar({
  name: 'lua',

  extras: ($) => [$.comment, /\s/],

  externals: ($) => [
    $._block_comment_start,
    $._block_comment_content,
    $._block_comment_end,

    $._block_string_start,
    $._block_string_content,
    $._block_string_end,
  ],

  supertypes: ($) => [$.statement, $.expression, $.declaration, $.variable],

  word: ($) => $.identifier,

  rules: {
    // chunk ::= block
    chunk: ($) =>
      seq(
        optional($.hash_bang_line),
        repeat($.statement),
        optional($.return_statement)
      ),

    hash_bang_line: (_) => /#.*/,

    // block ::= {stat} [retstat]
    _block: ($) =>
      choice(
        seq(repeat1($.statement), optional($.return_statement)),
        seq(repeat($.statement), $.return_statement)
      ),

    /*
      stat ::=  ';' |
                varlist '=' explist |
                functioncall |
                label |
                break |
                goto Name |
                do block end |
                while exp do block end |
                repeat block until exp |
                if exp then block {elseif exp then block} [else block] end |
                for Name '=' exp ',' exp [',' exp] do block end |
                for namelist in explist do block end |
                function funcname funcbody |
                local function Name funcbody |
                global function Name funcbody | 
                local attnamelist ['=' explist] |
                global attnamelist ['=' explist] |
                global [attrib] ‘*’
    */
    statement: ($) =>
      choice(
        $.empty_statement,
        $.assignment_statement,
        $.function_call,
        $.label_statement,
        $.break_statement,
        $.goto_statement,
        $.do_statement,
        $.while_statement,
        $.repeat_statement,
        $.if_statement,
        $.for_statement,
        $.declaration,
      ),

    // retstat ::= return [explist] [';']
    return_statement: ($) =>
      seq(
        'return',
        optional(alias($._expression_list, $.expression_list)),
        optional(';')
      ),

    // ';'
    empty_statement: (_) => ';',

    // varlist '=' explist
    assignment_statement: ($) =>
      seq(
        alias($._variable_assignment_varlist, $.variable_list),
        field('operator', '='),
        alias($._variable_assignment_explist, $.expression_list)
      ),
    // varlist ::= var {',' var}
    _variable_assignment_varlist: ($) =>
      list_seq(field('name', $.variable), ','),
    // explist ::= exp {',' exp}
    _variable_assignment_explist: ($) =>
      list_seq(field('value', $.expression), ','),

    // label ::= '::' Name '::'
    label_statement: ($) => seq('::', $.identifier, '::'),

    // break
    break_statement: (_) => 'break',

    // goto Name
    goto_statement: ($) => seq('goto', $.identifier),

    // do block end
    do_statement: ($) => seq('do', field('body', optional_block($)), 'end'),

    // while exp do block end
    while_statement: ($) =>
      seq(
        'while',
        field('condition', $.expression),
        'do',
        field('body', optional_block($)),
        'end'
      ),

    // repeat block until exp
    repeat_statement: ($) =>
      seq(
        'repeat',
        field('body', optional_block($)),
        'until',
        field('condition', $.expression)
      ),

    // if exp then block {elseif exp then block} [else block] end
    if_statement: ($) =>
      seq(
        'if',
        field('condition', $.expression),
        'then',
        field('consequence', optional_block($)),
        repeat(field('alternative', $.elseif_statement)),
        optional(field('alternative', $.else_statement)),
        'end'
      ),
    // elseif exp then block
    elseif_statement: ($) =>
      seq(
        'elseif',
        field('condition', $.expression),
        'then',
        field('consequence', optional_block($))
      ),
    // else block
    else_statement: ($) => seq('else', field('body', optional_block($))),

    // for Name '=' exp ',' exp [',' exp] do block end
    // for namelist in explist do block end
    for_statement: ($) =>
      seq(
        'for',
        field('clause', choice($.for_generic_clause, $.for_numeric_clause)),
        'do',
        field('body', optional_block($)),
        'end'
      ),
    // namelist in explist
    for_generic_clause: ($) =>
      seq(
        alias($._name_list, $.variable_list),
        'in',
        alias($._expression_list, $.expression_list)
      ),
    // Name '=' exp ',' exp [',' exp]
    for_numeric_clause: ($) =>
      seq(
        field('name', $.identifier),
        field('operator', '='),
        field('start', $.expression),
        ',',
        field('end', $.expression),
        optional(seq(',', field('step', $.expression)))
      ),
    // namelist ::= Name {',' Name}
    _name_list: ($) => name_list($),

    // function funcname funcbody
    // local function Name funcbody
    // global function Name funcbody
    // local attnamelist [‘=’ explist]
    // global attnamelist [‘=’ explist]
    // global [attrib] ‘*’
    declaration: ($) =>
      choice(
        $.function_declaration,
        field(
          'local_declaration',
          alias($._local_function_declaration, $.function_declaration)
        ),
        field('local_declaration', $.variable_declaration),
        field(
          'global_declaration',
          alias($._global_function_declaration, $.function_declaration)
        ),
        field(
          'global_declaration',
          alias($._global_variable_declaration, $.variable_declaration)
        ),
        field(
          'global_declaration',
          alias($._global_implicit_variable_declaration, $.implicit_variable_declaration)
        )
      ),
    // function funcname funcbody
    function_declaration: ($) =>
      seq('function', field('name', $._function_name), $._function_body),
    // local function Name funcbody
    _local_function_declaration: ($) =>
      seq('local', 'function', field('name', $.identifier), $._function_body),
    // global function Name funcbody
    _global_function_declaration: ($) =>
      seq('global', 'function', field('name', $.identifier), $._function_body),
    // funcname ::= Name {'.' Name} [':' Name]
    _function_name: ($) =>
      choice(
        $._function_name_prefix_expression,
        alias(
          $._function_name_method_index_expression,
          $.method_index_expression
        )
      ),
    _function_name_prefix_expression: ($) =>
      choice(
        $.identifier,
        alias($._function_name_dot_index_expression, $.dot_index_expression)
      ),
    _function_name_dot_index_expression: ($) =>
      seq(
        field('table', $._function_name_prefix_expression),
        '.',
        field('field', $.identifier)
      ),
    _function_name_method_index_expression: ($) =>
      seq(
        field('table', $._function_name_prefix_expression),
        ':',
        field('method', $.identifier)
      ),

    // local attnamelist [‘=’ explist]
    variable_declaration: ($) =>
      seq(
        'local',
        choice(
          alias($._att_name_list, $.variable_list),
          alias($._variable_assignment, $.assignment_statement)
        )
      ),
    // global attnamelist [‘=’ explist]
    _global_variable_declaration: ($) =>
      seq(
        'global',
        choice(
          alias($._att_name_list, $.variable_list),
          alias($._variable_assignment, $.assignment_statement),
        )
      ),
    // attnamelist ‘=’ explist
    _variable_assignment: ($) =>
      seq(
        alias($._att_name_list, $.variable_list),
        field('operator', '='),
        alias($._variable_assignment_explist, $.expression_list)
      ),

    // attnamelist ::= [attrib] Name [attrib] {‘,’ Name [attrib]}
    _att_name_list: ($) =>
      seq(
        optional(field('attribute', alias($._attrib, $.attribute))),
        list_seq(
          seq(
            field('name', $.identifier),
            optional(field('attribute', alias($._attrib, $.attribute)))
          ),
          ','
        ),
      ),
    // global [attrib] ‘*’
    _global_implicit_variable_declaration: ($) =>
      seq(
        'global',
        optional(field('attribute', alias($._attrib, $.attribute))),
        '*'
      ),
    // attrib ::= ‘<’ Name ‘>’
    _attrib: ($) => seq('<', $.identifier, '>'),

    // explist ::= exp {',' exp}
    _expression_list: ($) => list_seq($.expression, ','),

    /*
      exp ::=  nil | false | true | Numeral | LiteralString | '...' | functiondef |
               prefixexp | tableconstructor | exp binop exp | unop exp
     */
    expression: ($) =>
      choice(
        $.nil,
        $.false,
        $.true,
        $.number,
        $.string,
        $.vararg_expression,
        $.function_definition,
        $.variable,
        $.function_call,
        $.parenthesized_expression,
        $.table_constructor,
        $.binary_expression,
        $.unary_expression
      ),

    // nil
    nil: (_) => 'nil',

    // false
    false: (_) => 'false',

    // true
    true: (_) => 'true',

    // Numeral
    number: (_) => {
      function number_literal(digits, exponent_marker, exponent_digits) {
        return choice(
          seq(digits, /U?LL/i),
          seq(
            choice(
              seq(optional(digits), optional('.'), digits),
              seq(digits, optional('.'), optional(digits))
            ),
            optional(
              seq(
                choice(
                  exponent_marker.toLowerCase(),
                  exponent_marker.toUpperCase()
                ),
                seq(optional(choice('-', '+')), exponent_digits)
              )
            ),
            optional(choice('i', 'I'))
          )
        );
      }

      const decimal_digits = /[0-9]+/;
      const decimal_literal = number_literal(
        decimal_digits,
        'e',
        decimal_digits
      );

      const hex_digits = /[a-fA-F0-9]+/;
      const hex_literal = seq(
        choice('0x', '0X'),
        number_literal(hex_digits, 'p', decimal_digits)
      );

      const bin_digits = /[01]+/;
      const bin_literal = seq(
        choice('0b', '0B'),
        choice(
          seq(bin_digits, /U?LL/i),
          seq(bin_digits, optional(choice('i', 'I')))
        )
      );

      return token(choice(decimal_literal, hex_literal, bin_literal));
    },

    // LiteralString
    string: ($) => choice($._quote_string, $._block_string),

    _quote_string: ($) =>
      choice(
        seq(
          field('start', alias('"', '"')),
          field(
            'content',
            optional(alias($._doublequote_string_content, $.string_content))
          ),
          field('end', alias('"', '"'))
        ),
        seq(
          field('start', alias("'", "'")),
          field(
            'content',
            optional(alias($._singlequote_string_content, $.string_content))
          ),
          field('end', alias("'", "'"))
        )
      ),

    _doublequote_string_content: ($) =>
      repeat1(choice(token.immediate(prec(1, /[^"\\]+/)), $.escape_sequence)),

    _singlequote_string_content: ($) =>
      repeat1(choice(token.immediate(prec(1, /[^'\\]+/)), $.escape_sequence)),

    _block_string: ($) =>
      seq(
        field('start', alias($._block_string_start, '[[')),
        field('content', alias($._block_string_content, $.string_content)),
        field('end', alias($._block_string_end, ']]'))
      ),

    escape_sequence: () =>
      token.immediate(
        seq(
          '\\',
          choice(
            /[\nabfnrtv\\'"]/,
            /z\s*/,
            /[0-9]{1,3}/,
            /x[0-9a-fA-F]{2}/,
            /u\{[0-9a-fA-F]+\}/
          )
        )
      ),

    // '...'
    vararg_expression: (_) => '...',

    // functiondef ::= function funcbody
    function_definition: ($) => seq('function', $._function_body),
    // funcbody ::= '(' [parlist] ')' block end
    _function_body: ($) =>
      seq(
        field('parameters', $.parameters),
        field('body', optional_block($)),
        'end'
      ),
    // '(' [parlist] ')'
    parameters: ($) => seq('(', optional($._parameter_list), ')'),
    // parlist ::= namelist [‘,’ varargparam] | varargparam
    _parameter_list: ($) =>
      choice(
        seq(name_list($), optional(seq(',', $._vararg_parameter))),
        $._vararg_parameter
      ),
    // varargparam ::= ‘...’ [Name]
    _vararg_parameter: ($) =>
      seq($.vararg_expression, optional(field('name', $.identifier))),

    // prefixexp ::= var | functioncall | '(' exp ')'
    _prefix_expression: ($) =>
      prec(1, choice($.variable, $.function_call, $.parenthesized_expression)),

    // var ::=  Name | prefixexp [ exp ] | prefixexp . Name
    variable: ($) =>
      choice($._contextual_keyword, $.identifier, $.bracket_index_expression, $.dot_index_expression),
    // prefixexp [ exp ]
    bracket_index_expression: ($) =>
      seq(
        field('table', $._prefix_expression),
        '[',
        field('field', $.expression),
        ']'
      ),
    // prefixexp . Name
    dot_index_expression: ($) =>
      seq(
        field('table', $._prefix_expression),
        '.',
        field('field', $.identifier)
      ),

    // functioncall ::=  prefixexp args | prefixexp ':' Name args
    function_call: ($) =>
      seq(
        field('name', choice($._prefix_expression, $.method_index_expression)),
        field('arguments', $.arguments)
      ),
    // prefixexp ':' Name
    method_index_expression: ($) =>
      seq(
        field('table', $._prefix_expression),
        ':',
        field('method', $.identifier)
      ),
    // args ::=  '(' [explist] ')' | tableconstructor | LiteralString
    arguments: ($) =>
      choice(
        seq('(', optional(list_seq($.expression, ',')), ')'),
        $.table_constructor,
        $.string
      ),

    // '(' exp ')'
    parenthesized_expression: ($) => seq('(', $.expression, ')'),

    // tableconstructor ::= '{' [fieldlist] '}'
    table_constructor: ($) => seq('{', optional($._field_list), '}'),
    // fieldlist ::= field {fieldsep field} [fieldsep]
    _field_list: ($) => list_seq($.field, $._field_sep, true),
    // fieldsep ::= ',' | ';'
    _field_sep: (_) => choice(',', ';'),
    // field ::= '[' exp ']' '=' exp | Name '=' exp | exp
    field: ($) =>
      choice(
        seq(
          '[',
          field('name', $.expression),
          ']',
          field('operator', '='),
          field('value', $.expression)
        ),
        seq(field('name', choice($._contextual_keyword, $.identifier)), '=', field('value', $.expression)),
        field('value', $.expression)
      ),

    // exp binop exp
    binary_expression: ($) =>
      choice(
        ...[
          ['or', PREC.OR],
          ['and', PREC.AND],
          ['<', PREC.COMPARE],
          ['<=', PREC.COMPARE],
          ['==', PREC.COMPARE],
          ['~=', PREC.COMPARE],
          ['>=', PREC.COMPARE],
          ['>', PREC.COMPARE],
          ['|', PREC.BIT_OR],
          ['~', PREC.BIT_NOT],
          ['&', PREC.BIT_AND],
          ['<<', PREC.BIT_SHIFT],
          ['>>', PREC.BIT_SHIFT],
          ['+', PREC.PLUS],
          ['-', PREC.PLUS],
          ['*', PREC.MULTI],
          ['/', PREC.MULTI],
          ['//', PREC.MULTI],
          ['%', PREC.MULTI],
        ].map(([operator, precedence]) =>
          prec.left(
            precedence,
            seq(
              field('left', $.expression),
              field('operator', operator),
              field('right', $.expression)
            )
          )
        ),
        ...[
          ['..', PREC.CONCAT],
          ['^', PREC.POWER],
        ].map(([operator, precedence]) =>
          prec.right(
            precedence,
            seq(
              field('left', $.expression),
              field('operator', operator),
              field('right', $.expression)
            )
          )
        )
      ),

    // unop exp
    unary_expression: ($) =>
      prec.left(
        PREC.UNARY,
        seq(
          field('operator', choice('not', '#', '-', '~')),
          field('operand', $.expression),
        )
      ),

    // Name
    identifier: (_) => {
      const identifier_start =
        /[^\p{Control}\s+\-*/%^#&~|<>=(){}\[\];:,.\\'"\d]/;
      const identifier_continue =
        /[^\p{Control}\s+\-*/%^#&~|<>=(){}\[\];:,.\\'"]*/;
      return token(seq(identifier_start, identifier_continue));
    },

    // comment
    comment: ($) =>
      choice(
        seq(
          field('start', '--'),
          field('content', alias(/[^\r\n]*/, $.comment_content))
        ),
        seq(
          field('start', alias($._block_comment_start, '[[')),
          field('content', alias($._block_comment_content, $.comment_content)),
          field('end', alias($._block_comment_end, ']]'))
        )
      ),

    // only `global` for now
    _contextual_keyword: (_) => 'global',
  },
});
})()

const PREC = {
  ASSIGN: 0,
  OR: 1, // or
  AND: 2, // and
  COMPARE: 3, // < > <= >= ~= ==
  BIT_OR: 4, // |
  BIT_NOT: 5, // ~
  BIT_AND: 6, // &
  BIT_SHIFT: 7, // << >>
  CONCAT: 8, // ..
  PLUS: 9, // + -
  MULTI: 10, // * / // %
  CAST: 11, // ::
  UNARY: 12, // not # -
  POWER: 13, // ^
};

/**
 * Creates a rule to match one or more of the rules separated by a comma
 *
 * @param {Rule} rule
 *
 * @returns {SeqRule}
 */
function commaSep1(rule) {
  return sep1(rule, ',');
}

/**
 * Creates a rule to match zero or more of the rules separated by a comma
 *
 * @param {Rule} rule
 * @returns {ChoiceRule}
 */
function commaSep(rule) {
  return optional(commaSep1(rule));
}

/**
 * Creates a rule to match one or more occurrences of `rule` separated by `sep`
 *
 * @param {RegExp | Rule | string} rule
 *
 * @param {RegExp | Rule | string} sep
 *
 * @returns {SeqRule}
 */
function sep1(rule, sep) {
  return seq(rule, repeat(seq(sep, rule)));
}


/**
 * Creates a rule to match two or more occurrences of `rule` separated by `sep`
 *
 * @param {RegExp | Rule | string} rule
 *
 * @param {RegExp | Rule | string} sep
 *
 * @returns {SeqRule}
 */
function sep2(rule, sep) {
  return seq(rule, repeat1(seq(sep, rule)));
}

/**
 * @param {GrammarSymbols<string>} $
 */
const optional_block = $ => alias(optional($._block), $.block);

module.exports = grammar(lua, {
  name: 'luau',

  supertypes: ($, original) => original.concat([
    $.type,
  ]),

  rules: {
    // Luau has no goto and label statements, and has continue statements
    statement: ($, original) => choice(
      ...original.members.filter(
        member => member.name !== 'goto_statement' && member.name !== 'label_statement',
      ),
      $.update_statement,
      $.continue_statement,
      $.type_definition,
    ),

    update_statement: $ => seq(
      alias($._variable_assignment_varlist, $.variable_list),
      choice('+=', '-=', '*=', '/=', '%=', '//=', '^=', '..='),
      alias($._variable_assignment_explist, $.expression_list),
    ),

    continue_statement: _ => 'continue',

    type_definition: $ => seq(
      optional('export'),
      'type',
      field('name', $.type),
      '=',
      choice(
        $.type,
        seq('typeof', '(', $.expression, ')'),
      ),
    ),

    _function_body: $ => seq(
      optional($.generic_type_list),
      field('parameters', $.parameters),
      optional(seq(':', $.type)),
      field('body', optional_block($)),
      'end',
    ),
    generic_type_list: $ => seq(
      '<',
      commaSep1(
        seq($.identifier, optional($.vararg_expression)),
      ),
      '>',
    ),
    _parameter_list: $ => choice(commaSep1($.parameter)),

    parameter: $ => seq(
      choice($.identifier, $.vararg_expression),
      optional(seq(':', $.type)),
    ),

    _att_name_list: $ => sep1(
      seq(
        field('name', $.identifier),
        optional(seq(':', $.type)),
        optional(field('attribute', alias($._attrib, $.attribute))),
      ),
      ',',
    ),

    type: $ => choice(
      prec.right($.identifier),
      $.builtin_type,
      $.tuple_type,
      $.function_type,
      $.generic_type,
      $.object_type,
      $.empty_type,
      $.field_type,
      $.intersection_type,
      $.union_type,
      $.optional_type,
      $.literal_type,
      $.variadic_type,
    ),

    builtin_type: _ => choice(
      'thread',
      'buffer',
      'any',
      'userdata',
      'unknown',
      'never',
      'string',
      'number',
      'table',
      'boolean',
      'nil',
    ),

    tuple_type: $ => seq('(', commaSep1($.type), ')'),

    function_type: $ => prec.right(seq(
      '(',
      choice(
        seq(commaSep(seq($.identifier, ':', $.type)), optional(seq(',', commaSep($.type)))),
        commaSep($.type),
      ),
      ')',
      '->',
      $.type,
    )),

    generic_type: $ => seq(
      $.type,
      token(prec(1, '<')),
      commaSep(seq($.type, optional('...'))),
      '>',
    ),

    object_type: $ => seq(
      '{',
      optional(choice(
        commaSep1(
          seq(choice($.identifier, $.object_field_type), ':', $.type),
        ),
        commaSep1($.type),
      )),
      optional(','),
      '}',
    ),

    empty_type: _ => seq('(', ')'),

    field_type: $ => sep2($.identifier, '.'),

    object_field_type: $ => seq('[', $.type, ']'),

    union_type: $ => prec.left(1, seq($.type, '|', $.type)),

    intersection_type: $ => prec.left(2, seq($.type, '&', $.type)),

    optional_type: $ => seq($.type, '?'),

    literal_type: $ => choice($.string, $.true, $.false),

    variadic_type: $ => prec.right(seq('...', $.type)),

    expression: ($, original) => choice(
      original,
      $.cast_expression,
      $.if_expression,
    ),

    // Luau has no bitwise operators
    binary_expression: $ => choice(
      ...[
        ['or', PREC.OR],
        ['and', PREC.AND],
        ['<', PREC.COMPARE],
        ['<=', PREC.COMPARE],
        ['==', PREC.COMPARE],
        ['~=', PREC.COMPARE],
        ['>=', PREC.COMPARE],
        ['>', PREC.COMPARE],
        ['+', PREC.PLUS],
        ['-', PREC.PLUS],
        ['*', PREC.MULTI],
        ['/', PREC.MULTI],
        ['//', PREC.MULTI],
        ['%', PREC.MULTI],
      ].map(([operator, precedence]) =>
        prec.left(
          precedence,
          seq(
            field('left', $.expression),
            // @ts-ignore
            operator,
            field('right', $.expression),
          ),
        ),
      ),
      ...[
        ['..', PREC.CONCAT],
        ['^', PREC.POWER],
      ].map(([operator, precedence]) =>
        prec.right(
          precedence,
          seq(
            field('left', $.expression),
            // @ts-ignore
            operator,
            field('right', $.expression),
          ),
        ),
      ),
    ),

    unary_expression: ($) => prec.left(
      PREC.UNARY,
      seq(choice('not', '#', '-'), field('operand', $.expression)),
    ),

    cast_expression: $ => prec(PREC.CAST, seq(
      $.expression,
      '::',
      $.type,
    )),

    if_expression: $ => prec.right(seq(
      'if',
      field('condition', $.expression),
      'then',
      field('consequence', $.expression),
      repeat($.elseif_clause),
      optional($.else_clause),
    )),

    elseif_clause: $ => seq(
      'elseif',
      field('condition', $.expression),
      'then',
      field('consequence', $.expression),
    ),

    else_clause: $ => seq(
      'else',
      field('consequence', $.expression),
    ),

    _binding_list: $ => commaSep1(seq(
      field('name', $.identifier),
      optional(seq(':', $.type)),
    )),


    for_generic_clause: ($) => seq(
      alias($._binding_list, $.variable_list),
      'in',
      alias($._expression_list, $.expression_list),
    ),

    // Luau can have hex and binary numbers, with the 0x and 0b prefixes, and can have underscores
    number: _ => {
      const decimal_digits = /[0-9][0-9_]*/;
      const signed_integer = seq(optional(choice('-', '+')), decimal_digits);
      const decimal_exponent_part = seq(choice('e', 'E'), signed_integer);

      const hex_digits = /[a-fA-F0-9][a-fA-F0-9_]*/;
      const hex_exponent_part = seq(choice('p', 'P'), signed_integer);

      const binary_digits = /[0-1][0-1_]*/;

      const decimal_literal = choice(
        seq(
          decimal_digits,
          '.',
          optional(decimal_digits),
          optional(decimal_exponent_part),
        ),
        seq('.', decimal_digits, optional(decimal_exponent_part)),
        seq(decimal_digits, optional(decimal_exponent_part)),
      );

      const hex_literal = seq(
        choice('0x', '0X'),
        hex_digits,
        optional(seq('.', hex_digits)),
        optional(hex_exponent_part),
      );

      const binary_literal = seq(
        choice('0b', '0B'),
        binary_digits,
      );

      return token(choice(decimal_literal, hex_literal, binary_literal));
    },

    string: ($, original) => choice(
      original,
      $._interpolated_string,
    ),

    _interpolated_string: $ => seq(
      '`',
      repeat(choice(
        field('content', alias($._interpolation_string_content, $.string_content)),
        $._escape_sequence,
        $.interpolation,
      )),
      '`',
    ),

    _interpolation_string_content: _ => choice(token.immediate(prec(1, /[^`\{\\]+/)), '\\{'),

    _escape_sequence: $ => choice(
      prec(2, token.immediate(seq('\\', /[^abfnrtvxu'\"\\\?]/))),
      prec(1, $.escape_sequence),
    ),

    escape_sequence: _ => token.immediate(seq(
      '\\',
      choice(
        /[^xu0-7]/,
        /[0-7]{1,3}/,
        /x[0-9a-fA-F]{2}/,
        /u[0-9a-fA-F]{4}/,
        /u\{[0-9a-fA-F]+\}/,
        /U[0-9a-fA-F]{8}/,
      ),
    )),

    interpolation: $ => seq('{', $.expression, '}'),

    // Name
    identifier: _ => {
      const identifier_start =
        /[^\p{Control}\s+\-*/%^#&~|<>=(){}\[\];:,.\\'"`?\d]/u;
      const identifier_continue =
        /[^\p{Control}\s+\-*/%^#&~|<>=(){}\[\];:,.\\'"`?]*/u;
      return token(seq(identifier_start, identifier_continue));
    },
  },
});
