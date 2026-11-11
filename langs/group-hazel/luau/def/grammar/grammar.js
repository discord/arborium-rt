/**
 * @file Luau is a small, fast, and embeddable programming language based on Lua with a gradual type system.
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * https://tree-sitter.github.io/tree-sitter/creating-parsers/2-the-grammar-dsl.html
 */

/**
 * field() assigns a name to a child node in the syntax tree.
 */


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

const _STR_DOT = "."
const _STR_COLON = ":"

const _STR_SINLGE_QUOTE = "'"
const _STR_DOUBLE_QUOTE = '"'




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
 * @param {RuleOrLiteral} rule
 * @param {RuleOrLiteral} separator
 */
const list_seq = (rule, separator, trailing_separator = false) =>
  trailing_separator
    ? seq(rule, repeat(seq(separator, rule)), optional(separator))
    : seq(rule, repeat(seq(separator, rule)));

  
/**
 * @param {GrammarSymbols<string>} $
 */
// @ts-ignore
const optional_block = ($) => alias(optional($._block), $.block);


/**
 * @param {GrammarSymbols<string>} $
 */
// @ts-ignore
const name_list = ($) => list_seq(field('name', $.identifier), ',');


/**
 * bindinglist ::= binding [',' bindinglist] (* equivalent of Lua 5.1 'namelist', except with optional type annotations *)
 * @param {GrammarSymbols<string>} $
 */
// @ts-ignore
// @ts-ignore
const binding_list = ($) => {
  return list_seq(
    seq(
      field( "name", $.identifier ),
      optional( seq(_STR_COLON, $.type) )
    ),
    ","
  );
}




export default grammar({
  name: "luau",

  extras: ($) => [$.comment, /\s/],

  /**
   * Things from scanner.c
   */
  externals: ($) => [
    $._block_comment_start,
    $._block_comment_content,
    $._block_comment_end,

    $._block_string_start,
    $._block_string_content,
    $._block_string_end,
  ],

  // Things in here will not appear in the node tree
  supertypes: ($) => [$.statement, $.expression, $.declaration, $.expr_variable, $.type],

  word: ($) => $.identifier,


  // Other hack...
  conflicts: ($) => [
    [$.tuple_type, $.function_type_parameter],
  ],

  rules: {
    /**
     * Basically, the input of everything.
     * chunk ::= block
     */
    chunk: ($) =>
      seq(
        optional($.hash_bang_line),
        repeat($.statement),
        optional($.stat_return)
      ),

    hash_bang_line: (_) => /#.*/,

    // block ::= {stat} [retstat]
    _block: ($) =>
      choice(
        seq(repeat1($.statement), optional($.stat_return)),
        seq(repeat($.statement), $.stat_return)
      ),

    /**
     * Expressions!
     * Expressions are things that can produce something
     * this includes function and anything that you write in the right assignment
     */
    expression: ($) => {
      return choice(
        $.nil,
        $.boolean,
        $.number,
        $.string,
        $.expr_vararg,
        $.expr_variable,
        $.function_definition,
        $.function_call,
        $.parenthesized_expression,
        $.binary_expression,
        $.unary_expression,
        $.table_constructor,

        $.expr_ifConditional,
        $.type_cast_expression,
      )
    },

    // Basic expressions
    ...{
      nil: (_) => "nil",

      // If it is kept like this, one can figure out if true or false?
      _bool_true: (_) => "true",
      _bool_false: (_) => "false",

      boolean: ($) =>
        choice(
          $._bool_true,
          $._bool_false
        ),

      // LiteralString
      string: ($) => choice($._quote_string, $._block_string, $._interpolated_string,),

      // "..."
      expr_vararg: (_) => "...",

      // '(' exp ')'
      parenthesized_expression: ($) => seq("(", $.expression, ")"),

      // var ::=  Name | prefixexp [ exp ] | prefixexp . Name
      expr_variable: ($) =>
        choice($._contextual_keyword, $.identifier, $.bracket_index_expression, $.dot_index_expression),
    },

    ...{
      // prefixexp ::= var | functioncall | '(' exp ')'
      _prefix_expression: ($) =>
        prec(1, choice($.expr_variable, $.function_call, $.parenthesized_expression)),

      /**
       * prefixexp [ exp ]
       * tbl["Hello!"]
       */
      bracket_index_expression: ($) =>
        seq(
          field("table", $._prefix_expression),
          "[",
          field("field", $.expression),
          "]"
        ),
      /**
       * prefixexp . Name
       * tbl.Hello
       */
      dot_index_expression: ($) =>
        seq(
          field("table", $._prefix_expression),
          _STR_DOT,
          field("field", $.identifier)
        ),
      /**
       * prefixexp ':' Name
       * tbl:Hello
       */
      namecall_index_expression: ($) =>
        seq(
          field("table", $._prefix_expression),
          _STR_COLON,
          field("method", $.identifier)
        ),

      // explist ::= exp {',' exp}
      _expression_list: ($) => list_seq($.expression, ","),


      expr_ifConditional: $ => prec.right(seq(
        "if",
        field("condition", $.expression),
        "then",
        field("consequence", $.expression),
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

      for_generic_clause: ($) => seq(
        alias($._binding_list, $.variable_list),
        'in',
        alias($._expression_list, $.expression_list),
      ),
    },


    // Functions stuff
    ...{
      parameter: $ => seq(
        choice($.identifier, $.expr_vararg),
        optional(seq(_STR_COLON, $.type)),
      ),
      
      // '(' [parlist] ')'
      parameters: ($) => seq("(", optional($._parameter_list), ")"),
      // parlist ::= namelist [‘,’ varargparam] | varargparam
      /*_parameter_list: ($) =>
        choice(
          seq(name_list($), optional(seq(",", $._vararg_parameter))),
          $._vararg_parameter
        ),*/
      _parameter_list: $ => choice(list_seq($.parameter, ",")),

      // varargparam ::= ‘...’ [Name]
      _vararg_parameter: ($) =>
        seq($.expr_vararg, optional(field("name", $.identifier))),

      // functioncall ::=  prefixexp args | prefixexp ':' Name args
      function_call: ($) =>
        seq(
          field("name",
            choice(
              $._prefix_expression,
              $.namecall_index_expression
            )
          ),
          field("arguments",
            $.arguments
          )
        ),

      // args ::=  '(' [explist] ')' | tableconstructor | LiteralString
      arguments: ($) =>
        choice(
          seq("(", optional(list_seq($.expression, ",")), ")"),
          $.table_constructor,
          $.string
        ),

      // functiondef ::= function funcbody
      function_definition: ($) => seq("function", $._function_body),
      // funcbody ::= '(' [parlist] ')' block end
      _function_body: ($) =>
        seq(
          optional($.generic_type_list),
          field("parameters", $.parameters),
          optional(seq(':', $.type)),
          field("body", optional_block($)),
          "end"
        ),
    },


    // String stuff
    ...{
      _quote_string: ($) =>
        choice(
          seq(
            field("start", alias(_STR_DOUBLE_QUOTE, _STR_DOUBLE_QUOTE)),
            field(
              "content",
              optional(alias($._doublequote_string_content, $.string_content))
            ),
            field("end", alias(_STR_DOUBLE_QUOTE, _STR_DOUBLE_QUOTE))
          ),
          seq(
            field("start", alias(_STR_SINLGE_QUOTE, _STR_SINLGE_QUOTE)),
            field(
              "content",
              optional(alias($._singlequote_string_content, $.string_content))
            ),
            field("end", alias(_STR_SINLGE_QUOTE, _STR_SINLGE_QUOTE))
          )
        ),

      _doublequote_string_content: ($) =>
        repeat1(choice(token.immediate(prec(1, /[^"\\]+/)), $.backslash_escape_sequence)),

      _singlequote_string_content: ($) =>
        repeat1(choice(token.immediate(prec(1, /[^'\\]+/)), $.backslash_escape_sequence)),

      _block_string: ($) =>
        seq(
          field("start", alias($._block_string_start, "[[")),
          field("content", alias($._block_string_content, $.string_content)),
          field("end", alias($._block_string_end, "]]"))
        ),

      backslash_escape_sequence: (_) => token.immediate(seq(
          "\\",
          choice(
            /[^xu0-7]/,
            /[0-7]{1,3}/,
            /x[0-9a-fA-F]{2}/,
            /u[0-9a-fA-F]{4}/,
            /u\{[0-9a-fA-F]+\}/,
            /U[0-9a-fA-F]{8}/,
          ),
        )),

      // What is this here actually for???
      _interpolation_escape_sequence: ($) => choice(
        prec(2, token.immediate(seq("\\", /[^abfnrtvxu'\"\\\?]/))),
        prec(1, $.backslash_escape_sequence),
      ),

      _interpolated_string: ($) => seq(
        "`",
        repeat(choice(
          field("content", alias($._interpolation_string_content, $.string_content)),
          $._interpolation_escape_sequence,
          $.interpolation,
        )),
        "`",
      ),

      _interpolation_string_content: (_) => choice(token.immediate(prec(1, /[^`\{\\]+/)), '\\{'),

      interpolation: ($) => seq('{', $.expression, '}'),
    },

    // Numeral
    number: (_) => {
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


    // Binary and Unary expressions
    ...{
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
                // @ts-ignore
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
                // @ts-ignore
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
    },

    // Table stuff
    ...{
      // tableconstructor ::= '{' [fieldlist] '}'
      table_constructor: ($) => seq("{", optional($._field_list), "}"),
      // fieldlist ::= field {fieldsep field} [fieldsep]
      _field_list: ($) => list_seq($.field, $._field_sep, true),
      // fieldsep ::= ',' | ';'
      _field_sep: (_) => choice(",", ";"),
      // field ::= '[' exp ']' '=' exp | Name '=' exp | exp
      field: ($) =>
        choice(
          seq(
            "[",
            field("name", $.expression),
            "]",
            field("operator", "="),
            field("value", $.expression)
          ),
          seq(field("name", choice($._contextual_keyword, $.identifier)), "=", field("value", $.expression)),
          field("value", $.expression)
        ),
    },


    /**
     * Statements!
     * Statements are actions, basically
     */
    statement: ($) =>
      choice(
        $.empty_statement,
        $.stat_assignment,
        $.stat_compoundAssign,
        $.function_call,
        $.stat_break,
        $.stat_continue,
        //$.label_statement,
        //$.goto_statement,
        $.stat_do,
        $.stat_while,
        $.stat_repeat,
        $.stat_if,
        $.stat_for,
        $.stat_classDef,
        $.declaration,
        $.type_definition
      ),

    // Simple statements
    ...{
      // retstat ::= return [explist] [';']
      stat_return: ($) =>
        seq(
          'return',
          optional(alias($._expression_list, $.expression_list)),
          optional(';')
        ),

      // ';'
      empty_statement: (_) => ";",

      // varlist '=' explist
      stat_assignment: ($) =>
        seq(
          alias($._variable_assignment_varlist, $.variable_list),
          field("operator", "="),
          alias($._variable_assignment_explist, $.expression_list)
        ),
      // varlist ::= var {',' var}
      _variable_assignment_varlist: ($) =>
        list_seq(field("name", $.expr_variable), ","),
      // explist ::= exp {',' exp}
      _variable_assignment_explist: ($) =>
        list_seq(field("value", $.expression), ","),


      // Luau!
      stat_compoundAssign: ($) =>
        seq(
          alias($._variable_assignment_varlist, $.variable_list),
          choice('+=', '-=', '*=', '/=', '%=', '//=', '^=', '..='),
          alias($._variable_assignment_explist, $.expression_list)
        ),


      // Loop stuff
      stat_break: (_) => "break",
      stat_continue: (_) => "continue",

      // label ::= '::' Name '::'
      //label_statement: ($) => seq('::', $.identifier, '::'),
      // goto Name
      //goto_statement: ($) => seq('goto', $.identifier),
      
      // do block end
      stat_do: ($) => {
        return seq(
          "do",
          field("body", optional_block($)),
          "end"
        )
      },

      // if exp then block {elseif exp then block} [else block] end
      stat_if: ($) =>
        seq(
          'if',
          field('condition', $.expression),
          'then',
          field('consequence', optional_block($)),
          repeat(field('alternative', $.stat_elseif)),
          optional(field('alternative', $.stat_else)),
          'end'
        ),
      // elseif exp then block
      stat_elseif: ($) =>
        seq(
          'elseif',
          field('condition', $.expression),
          'then',
          field('consequence', optional_block($))
        ),
      // else block
      stat_else: ($) => seq('else', field('body', optional_block($))),

      // for Name '=' exp ',' exp [',' exp] do block end
      // for namelist in explist do block end
      stat_for: ($) =>
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

      
      // while exp do block end
      stat_while: ($) =>
        seq(
          "while",
          field("condition", $.expression),
          "do",
          field("body", optional_block($)),
          "end"
        ),

      // repeat block until exp
      stat_repeat: ($) =>
        seq(
          "repeat",
          field("body", optional_block($)),
          "until",
          field("condition", $.expression)
        ),


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
            "local_declaration",
            alias($._local_function_declaration, $.function_declaration)
          ),
          field("local_declaration", $.variable_declaration),

          field(
            "global_declaration",
            alias($._global_function_declaration, $.function_declaration)
          ),
          field(
            "global_declaration",
            alias($._global_variable_declaration, $.variable_declaration)
          ),
          field(
            "global_declaration",
            alias($._global_implicit_variable_declaration, $.implicit_variable_declaration)
          )
        ),
      // function funcname funcbody
      function_declaration: ($) =>
        seq('function', field('name', $._function_name), $._function_body),

      // local function Name funcbody
      _local_function_declaration: ($) =>
        seq(
          choice("local", "const"), // const HACK!
          "function", field("name", $.identifier), $._function_body
        ),

      // local attnamelist [‘=’ explist]
      variable_declaration: ($) =>
        seq(
          choice("local", "const"), // const HACK!
          choice(
            alias($._att_name_list, $.variable_list),
            alias($._variable_assignment, $.stat_assignment)
          )
        ),


      // global attnamelist [‘=’ explist]
      _global_variable_declaration: ($) =>
        seq(
          'global',
          choice(
            alias($._att_name_list, $.variable_list),
            alias($._variable_assignment, $.stat_assignment),
          )
        ),
      // global function Name funcbody
      _global_function_declaration: ($) =>
        seq('global', 'function', field('name', $.identifier), $._function_body),
      // funcname ::= Name {'.' Name} [':' Name]
      _function_name: ($) =>
        choice(
          $._function_name_prefix_expression,
          alias(
            $._function_name_namecall_index_expression,
            $.namecall_index_expression
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
      _function_name_namecall_index_expression: ($) =>
        seq(
          field('table', $._function_name_prefix_expression),
          ':',
          field('method', $.identifier)
        ),

      // attnamelist ‘=’ explist
      _variable_assignment: ($) =>
        seq(
          alias($._att_name_list, $.variable_list),
          field('operator', '='),
          alias($._variable_assignment_explist, $.expression_list)
        ),

      // attnamelist ::= [attrib] Name [attrib] {‘,’ Name [attrib]}
      /*_att_name_list: ($) =>
        seq(
          optional(field('attribute', alias($._attrib, $.attribute))),
          list_seq(
            seq(
              field('name', $.identifier),
              optional(field('attribute', alias($._attrib, $.attribute)))
            ),
            ','
          ),
        ),*/
      _att_name_list: $ => list_seq(
        seq(
          field('name', $.identifier),
          optional(seq(':', $.type)),
          optional(field('attribute', alias($._attrib, $.attribute))),
        ),
        ',',
      ),

      // global [attrib] '*'
      _global_implicit_variable_declaration: ($) =>
        seq(
          "global",
          optional(field("attribute", alias($._attrib, $.attribute))),
          "*"
        ),
      // attrib ::= '<' Name '>'
      _attrib: ($) => seq("<", $.identifier, ">"),



      // Classes
      stat_classDef: ($) => {
        return seq(
          seq(
            optional("open"), // This is not confirmed yet
            "class",
          ),
          $.identifier,
          optional(
            seq(
              "extends", // This is not confirmed yet
              $.identifier
            )
          ),
          field("body", optional_block($)),
          "end"
        )
      },

    },


    /**
     * Types
     */
    type: $ => choice(
      prec.right($.identifier),
      $.builtin_type,
      $.tuple_type,
      $.function_type,
      $.generic_type,
      $.table_type,
      $.empty_type,
      $.field_type,
      $.intersection_type,
      $.union_type,
      $.optional_type,
      $.literal_type,
      $.variadic_type,
    ),


    // Type defs
    ...{
      builtin_type: _ => choice(
        "any",
        "unknown",
        "never",
        "nil",
        "boolean",
        "number",
        "string",
        "table",
        "userdata",
        "thread",
        "buffer",
      ),

      tuple_type: $ => seq("(", list_seq($.type, ","), ")"),

      empty_type: _ => seq("(", ")"),

      function_type: $ => prec.right(seq(
        optional($.generic_type_list),
        "(",
        optional(list_seq($.function_type_parameter, ",")),
        ")",
        "->",
        field("return_type", $.type),
      )),
      function_type_parameter: $ => seq(
        optional(seq(field("name", $.identifier), ":")),
        field("type", $.type),
      ),

      generic_type: $ => seq(
        $.type,
        token(prec(1, "<")),
        list_seq(seq($.type, optional($.expr_vararg)), ","),
        ">",
      ),

      table_type: $ => seq(
        "{",
        optional(choice(
          list_seq(
            seq(choice($.identifier, $.table_field_type), ':', $.type),
            ","
          ),
          list_seq($.type, ","),
        )),
        optional(","),
        "}",
      ),


      field_type: $ => sep2($.identifier, '.'),
      table_field_type: $ => seq('[', $.type, ']'),
      union_type: $ => prec.left(1, seq($.type, '|', $.type)),
      intersection_type: $ => prec.left(2, seq($.type, '&', $.type)),
      optional_type: $ => seq($.type, '?'),
      literal_type: $ => choice($.string, $.boolean),
      variadic_type: $ => prec.right(seq('...', $.type)),
    },


    // Types stuff
    ...{
      type_definition: $ => seq(
        optional("export"),
        "type",
        field("name", $.type),
        "=",
        choice(
          $.type,
          seq("typeof", "(", $.expression, ")"),
        ),
      ),

      generic_type_list: $ => seq(
        repeat1("<"), // "repeat1" here supports << I think
        optional(
          list_seq(
            seq(
              $.identifier,
              optional($.expr_vararg)
            ),
            ","
          )
        ),
        repeat1(">"),
      ),

      type_cast_expression: $ => prec(PREC.CAST, seq(
        $.expression,
        "::",
        $.type,
      )),
    },

    // uhhh...
    special_self: (_) => "self",

    // only `global` for now
    _contextual_keyword: (_) => 'global',
    
    // Name
    identifier: (_) => {
      const identifier_start =
        // @ts-ignore
        /[^\p{Control}\s+\-*/%^#&~|<>=(){}\[\];:,.\\'"\d]/;
      const identifier_continue =
        // @ts-ignore
        /[^\p{Control}\s+\-*/%^#&~|<>=(){}\[\];:,.\\'"]*/;
      return token(seq(identifier_start, identifier_continue));
    },
    
    // Comments
    comment: ($) =>
      choice(
        seq(
          field("start", "--"),
          field("content", alias(/[^\r\n]*/, $.comment_content))
        ),
        seq(
          field("start", alias($._block_comment_start, "[[")),
          field("content", alias($._block_comment_content, $.comment_content)),
          field("end", alias($._block_comment_end, "]]"))
        )
      ),
  }
});
