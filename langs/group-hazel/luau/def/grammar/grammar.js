/**
 * @file Luau is a small, fast, and embeddable programming language based on Lua with a gradual type system.
 * @author Munif Tanjim, Amaan Qureshi, karl-police
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
const optional_block = ($) => alias(optional($._block), $.block);


/**
 * @param {GrammarSymbols<string>} $
 */
const name_list = ($) => list_seq(field('name', $.identifier), ',');



/**
 * @param {GrammarSymbols<string>} $
 */
const binding_func = ($) => {
  return seq(
    field("name", $.identifier),
    optional(
      seq(":", field("type", $.type))
    )
  )
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
  supertypes: ($) => [
    $.statement, $.expression, $.declaration, $.expr_variable, /*$.type*/
    $.simple_expr
  ],

  word: ($) => $.identifier,


  // Other hacks...
  conflicts: ($) => [
    [$._type_list, $._bound_type_list],
    [$._simple_type, $._type_list, $._bound_type_list],
    [$._simple_type, $._bound_type_list],
    [$._named_type],
  ],

  rules: {
    /**
     * Basically, the input of everything.
     * chunk ::= block
     */
    chunk: ($) =>
      seq(
        optional($.hash_bang_line),
        $._block
      ),

    hash_bang_line: (_) => /#.*/,

    // block ::= {stat [';']} [laststat [';']]
    _block: ($) =>
      choice(
        $.last_stat, // cheat
        seq(
          repeat1(seq($.statement, optional(";"))),
          optional(seq($.last_stat, optional(";")))
        ),
      ),

    /**
     * Expressions!
     * Expressions are things that can produce something
     * this includes function and anything that you write in the right assignment
     */
    // exp ::= asexp { binop exp } | unop exp { binop exp }
    // asexp leads to the other ones
    expression: ($) => {
      return choice(
          $.as_expr,
          $.binary_expression,
          $.unary_expression,
        )
    },

    ...{
      // asexp ::= simpleexp ['::' Type]
      as_expr: ($) => prec.left(seq(
        $.simple_expr,
        optional($.type_cast_expr)
      )),

      type_cast_expr: ($) =>
        prec.right(
          PREC.CAST,
          seq(
            "::",
            field("type", $.type)
          )
        ),

      // prefixexp ::= var | functioncall | '(' exp ')'
      _prefix_expr: ($) =>
        prec(1, 
          choice(
            $.expr_variable,
            $.function_call,
            $.parenthesized_expression
          )
        ),

      // simpleexp ::= NUMBER | STRING | 'nil' | 'true' | 'false' |
      // '...' | tableconstructor | attributes 'function' funcbody | prefixexp | ifelseexp | stringinterp
      simple_expr: ($) => {
        return choice(
          $.number,
          $.string, // also has "stringinterp"
          $.nil,
          $.boolean,
          $.expr_vararg,
          $.table_constructor,
          $.expr_function_definition, // attributes 'function' funcbody
          $._prefix_expr,
          $.expr_ifConditional,
        )
      },
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
      /**
       * prefixexp [ exp ]
       * tbl["Hello!"]
       */
      bracket_index_expression: ($) =>
        seq(
          field("table", $._prefix_expr),
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
          field("table", $._prefix_expr),
          _STR_DOT,
          field("field", $.identifier)
        ),
      /**
       * prefixexp ':' Name
       * tbl:Hello
       */
      namecall_index_expression: ($) =>
        seq(
          field("table", $._prefix_expr),
          _STR_COLON,
          field("method", $.identifier)
        ),

      // explist ::= {exp ','} exp
      _expression_list: ($) => list_seq($.expression, ","),


      // ifelseexp ::= 'if' exp 'then' exp {'elseif' exp 'then' exp} 'else' exp
      expr_ifConditional: $ => prec.right(seq(
        "if",
        field("condition", $.expression),
        "then",
        field("consequence", $.expression),
        repeat($.elseif_clause),
        optional($.else_clause), // uhh...
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

      // functioncall ::= prefixexp funcargs | prefixexp ':' NAME funcargs
      function_call: ($) =>
        prec(2, seq(
          field("name",
            choice(
              $._prefix_expr,
              $.namecall_index_expression
            )
          ),
          optional(
            repeat(field("generic_args", $.genericTypeList_angle_wrapper))
          ), // uhh...
          field("arguments",
            $.arguments
          )
        )),

      // args ::=  '(' [explist] ')' | tableconstructor | LiteralString
      arguments: ($) =>
        choice(
          seq("(", optional(list_seq($.expression, ",")), ")"),
          $.table_constructor,
          $.string
        ),

      // attributes 'function' funcbody
      expr_function_definition: ($) =>
        seq(optional(field("attributes", $.attributes)), "function", $._function_body),
      
      genericTypeList_angle_wrapper: ($) => seq("<", $.generic_type_list, ">",),

      // funcbody ::= ['<' GenericTypeList '>'] '(' [parlist] ')' [':' ReturnType] block 'end'
      _function_body: ($) =>
        seq(
          optional($.genericTypeList_angle_wrapper),
          "(",
            field("parameters", optional($._parameter_list)),
          ")",
          optional(seq(
            ":", field("return_type", $._return_type),
          )),
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

      //_interpolation_string_content: (_) => choice(token.immediate(prec(1, /[^`\{\\]+/)), '\\{'),
      _interpolation_string_content: (_) =>
        choice(token.immediate(prec(1, /[^`\{\\]+/)), token.immediate('\\{')),

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
      // binop ::=
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

      // unop ::=
      unary_expression: ($) =>
        prec.left(
          PREC.UNARY,
          seq(
            field('operator', choice("-", "not", "#")),
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
      // fieldsep ::= ',' | ';'
      _field_sep: (_) => choice(",", ";"),
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
        //$.stat_break, // in last_stat
        //$.stat_continue, // in last_stat
        //$.label_statement,
        //$.goto_statement,
        $.stat_do,
        $.stat_while,
        $.stat_repeat,
        $.stat_if,
        $.stat_for,
        $.stat_classDef,
        $.declaration,

        $.type_definition_stat,
        $.type_function_stat,
      ),

    // Simple statements
    ...{
      stat_return: ($) =>
        seq(
          'return',
          optional(alias($._expression_list, $.expression_list)),
        ),
      // laststat ::= 'return' [explist] | 'break' | 'continue'
      last_stat: ($) =>
        choice($.stat_return, $.stat_break, $.stat_continue),

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
      // compoundop ::=
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
      
      // 'do' block 'end'
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
          alias($._binding_list, $.variable_list),
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

      // binding ::= NAME [':' Type]
      _binding: ($) =>
        seq(
          field("name", $.identifier),
          optional(
            seq(":", field("type", $.type))
          )
        ),
      // bindinglist ::= binding [',' bindinglist] (* equivalent of Lua 5.1 'namelist', except with optional type annotations *)
      _binding_list: ($) => list_seq($._binding, ","),

      
      // 'while' exp 'do' block 'end'
      stat_while: ($) =>
        seq(
          "while",
          field("condition", $.expression),
          "do",
          field("body", optional_block($)),
          "end"
        ),

      // 'repeat' block 'until' exp
      stat_repeat: ($) =>
        seq(
          "repeat",
          field("body", optional_block($)),
          "until",
          field("condition", $.expression)
        ),

      // attributes 'function' funcname funcbody
      // this is a stat
      function_declaration: ($) =>
        seq(
          optional(field("attributes", $.attributes)),
          "function", field("name", $._function_name), $._function_body),
      // attributes 'local' 'function' NAME funcbody
      _local_function_declaration: ($) =>
        seq(
          optional(field("attributes", $.attributes)),
          "local",
          "function", field("name", $.identifier),
          $._function_body
        ),

      // 'local' bindinglist ['=' explist]
      variable_declaration: ($) =>
        seq(
          "local",
          alias($._binding_list, $.variable_list),
          optional(seq(
            field("operator", "="),
            alias($._variable_assignment_explist, $.expression_list)
          ))
        ),
        
      // 'const' 'function' NAME funcbody
      _const_function_declaration: ($) =>
        seq(
          optional(field("attributes", $.attributes)),
          "const",
          "function", field("name", $.identifier),
          $._function_body
        ),

      // 'const' bindinglist '=' explist
      _const_var_declaration: ($) =>
        seq(
            "const",
            alias($._binding_list, $.variable_list),
            field("operator", "="),
            alias($._variable_assignment_explist, $.expression_list)
          ),
      // Aliases are there because they help with hidden node tree rules


      // Remove the global stuff below?
      //
      // global function Name funcbody
      // global attnamelist [‘=’ explist]
      // global [attrib] ‘*’
      // Helper
      declaration: ($) =>
        choice(
          $.function_declaration,
          field(
            "local_declaration", alias($._local_function_declaration, $.function_declaration)
          ),
          field("local_declaration", $.variable_declaration),

          field(
            "const_declaration", alias($._const_function_declaration, $.function_declaration)
          ),
          field(
            "const_declaration", alias($._const_var_declaration, $.variable_declaration)
          ),

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

      // funcname ::= NAME {'.' NAME} [':' NAME]
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
      ...{
        class_member: ($) =>
          choice(
            $.class_field,
            $.class_method,
          ),
        class_field: ($) =>
          seq(
            "public",
            binding_func($),
          ),
        class_method: ($) => $.function_declaration,

        class_body: ($) => repeat1($.class_member),
        
        stat_classDef: ($) => {
          return seq(
            seq(
              //optional("open"), // This is not confirmed yet
              "class",
            ),
            $.identifier,
            optional(
              seq(
                //"extends", // This is not confirmed yet
                $.identifier
              )
            ),
            field("body", optional($.class_body)),
            "end"
          )
        },
      }

    },


    /**
     * Types
     */
    type: ($) => choice(
      $._type_operand,

      $.union_type,
      $.intersection_type,
    ),


    // Types stuff
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


      _type_operand: ($) => choice($._simple_type, $._optional_type),
      _optional_type: ($) => prec.left(4, seq($._type_operand, "?")),

      // SimpleType ::=
      _simple_type: ($) => choice(
          //"nil",
          $.builtin_type, // I think?
          $.singleton_type,
          $._named_type,
          $._typeof_type,
          $.table_type,
          $.function_type,
          seq("(", $.type, ")"), // '(' Type ')'
        ),

      // SingletonType ::= STRING | 'true' | 'false'
      singleton_type: ($) => choice($.string, $.boolean),

      // NAME ['.' NAME] [ '<' [TypeParams] '>' ]
      _named_type: ($) => seq(
        $.identifier,
        optional( seq(".", $.identifier) ),
        optional( seq( "<", optional($.type_params), ">" ) ),
      ),
      // 'typeof' '(' exp ')'
      _typeof_type: ($) => seq("typeof", "(", $.expression, ")"),
      
      // Union ::= [SimpleType {'?'}] {'|' SimpleType {'?'}}
      union_type: ($) => prec.left(1,
        seq(
          //optional(seq($._simple_type, repeat("?"))),
          //repeat1(seq("|", $._simple_type, repeat("?"))),
          optional($._type_operand),
          repeat1(seq("|", $._type_operand)),
        )
      ),
      // Intersection ::= [SimpleType] {'&' SimpleType}
      intersection_type: ($) => prec.left(2,
        seq(
          //optional($._simple_type),
          optional($._type_operand),
          repeat1(seq("&", $._simple_type)),
        )
      ),

      // GenericTypePackParameterWithDefault ::= NAME '...' '=' (TypePack | VariadicTypePack | GenericTypePack)
      generic_type_pack_parameter_with_default: $ => seq(
        field("name", $.identifier),
        "...",
        "=",
        field("default",
          choice(
            $.type_pack,
            $.variadic_type_pack,
            $.generic_type_pack,
          )
        ),
      ),

      _generic_type_with_default: $ => seq(
        $.identifier,
        optional(seq("=", $.type)),
      ),

      // GenericTypeListWithDefaults ::=
      generic_type_list_with_defaults: $ => choice(
        // NAME ['=' Type] [',' GenericTypeListWithDefaults]
        seq(
          field("parameter", $._generic_type_with_default),
          optional(seq(
            ",",
            $.generic_type_list_with_defaults,
          )),
        ),

        // GenericTypePackParameterWithDefault
        // {',' GenericTypePackParameterWithDefault}
        seq(
          field("parameter", $.generic_type_pack_parameter_with_default),
          repeat(seq(
            ",",
            field("parameter", $.generic_type_pack_parameter_with_default),
          )),
        ),
      ),

      // GenericTypePackParameter ::= NAME '...'
      _generic_type_pack_param: ($) =>
        seq($.identifier, "..."),

      // GenericTypeList ::= NAME [',' GenericTypeList]
      //  | GenericTypePackParameter {',' GenericTypePackParameter}
      generic_type_list: ($) =>
        choice(
          list_seq($.identifier, ","),
          list_seq($._generic_type_pack_param, ","),
        ),

      // GenericTypePack ::= NAME '...'
      generic_type_pack: ($) =>
        seq($.identifier, "..."),
      // VariadicTypePack ::= '...' Type
      variadic_type_pack: ($) =>
        prec.right(seq("...", $.type)),

      // ReturnType ::= Type | TypePack | GenericTypePack | VariadicTypePack
      _return_type: ($) =>
        choice(
          $.type,
          $.type_pack,
          $.generic_type_pack,
          $.variadic_type_pack,
        ),
      
      _type_table_read_write: ($) => choice("read", "write"),
      // TableIndexer ::= ['read' | 'write'] '[' Type ']' ':' Type
      _type_table_indexer: ($) =>
        seq(
          optional($._type_table_read_write),
          "[", $.type, "]", ":", $.type,
        ),
      // TableProp ::= ['read' | 'write'] NAME ':' Type
      _type_table_prop: ($) =>
        seq(
          optional($._type_table_read_write),
          $.identifier, ":", $.type,
        ),
      // PropList ::= TableProp [fieldsep PropList]
      // | TableIndexer {fieldsep TableProp}
      _type_table_prop_list: ($) =>
        choice(
          seq(
            $._type_table_prop,
            optional(seq($._field_sep, $._type_table_prop_list)),
          ),
          seq(
            $._type_table_indexer,
            repeat(seq($._field_sep, $._type_table_prop)),
          ),
        ),

      // TypePack ::= '(' [TypeList] ')'
      type_pack: ($) =>
        seq("(", optional($._type_list), ")"),


      // TypeList ::= Type [',' TypeList] | '...' Type
      _type_list: ($) =>
        choice(
          seq(
            $.type,
            optional( repeat(seq(",", $.type)) )
          ),
          $.variadic_type_pack, // reduced '...' Type
          //seq("...", $.type),
        ),
      // BoundTypeList ::= [NAME ':'] Type [',' BoundTypeList]
      // | GenericTypePack | VariadicTypePack
      _bound_type_list: ($) =>
        choice(
          seq(
            optional(seq($.identifier, ":")),
            $.type,
            optional(seq(",", $._bound_type_list)),
          ),
          $.generic_type_pack,
          $.variadic_type_pack,
        ),

      // TypeParams ::= (Type | TypePack | VariadicTypePack | GenericTypePack)
      // [',' TypeParams]
      type_params: ($) =>
        list_seq(
          choice(
            $.type,
            $.type_pack,
            $.variadic_type_pack,
            $.generic_type_pack,
          ),
          ",",
        ),


      // TableType ::= '{' Type '}' | '{' [PropList] '}'
      table_type: ($) =>
        choice(
          seq("{", $.type, "}"),
          seq("{", optional($._type_table_prop_list), "}")
        ),

      // FunctionType ::= ['<' GenericTypeList '>'] '(' [BoundTypeList] ')' '->' ReturnType
      function_type: ($) =>
        prec.right(1, seq(
          optional($.genericTypeList_angle_wrapper),
          "(", optional($._bound_type_list), ")",
          "->",
          field("return_type", $._return_type),
        )),


      
      // ['export'] 'type' NAME ['<' GenericTypeListWithDefaults '>'] '=' Type
      type_definition_stat: $ => seq(
        optional("export"),
        "type",
        field("name", $.identifier),
        optional(seq(
          "<", $.generic_type_list_with_defaults, ">",
        )),
        "=",
        field("definition", $.type),
      ),
      // ['export'] 'type' 'function' NAME funcbody
      type_function_stat: $ => seq(
        optional("export"),
        "type",
        "function",
        field("name", $.identifier),
        $._function_body,
      ),
    },

    /**
     * Other
     */

    ...{
      // littable ::= '{' [litfieldlist] '}'
      littable: ($) =>
        seq(
          "{", optional($.litfieldlist), "}"
        ),
      // litfieldlist ::= litfield {fieldsep litfield} [fieldsep]
      litfieldlist: ($) =>
        list_seq(
          $.litfield,
          $._field_sep,
          true
        ),
      // litfield ::= [NAME '='] literal
      litfield: ($) =>
        choice(
          seq(
            field("name", $.identifier), "=", field("value", $.literal)
          ),
          field("value", $.literal)
        ),

      // literal ::= 'nil' | 'false' | 'true' | NUMBER | STRING | littable
      literal: ($) =>
        choice(
          $.nil,
          $.boolean,
          $.number,
          $.string,
          $.littable
        ),
      // litlist ::= literal {',' literal}
      litlist: ($) =>
        list_seq($.literal, ","),

      // pars ::= '(' [litlist] ')' | littable | STRING
      pars: ($) =>
        choice(
          seq(
            "(", optional($.litlist), ")"
          ),
          $.littable,
          $.string
        ),

      // parattr ::= NAME [pars]
      parattr: ($) =>
        seq(
          field("name", $.identifier),
          optional(field("parameters", $.pars))
        ),
      
      // attribute ::= '@' NAME | '@[' parattr {',' parattr} ']'
      attribute: ($) =>
        choice(
          seq( "@", field("name", $.identifier) ),
          seq("@[", $.attribute_list, "]")
        ),
      attribute_list: ($) => list_seq($.parattr, ",", true),

      // attributes ::= {attribute}
      attributes: ($) =>
        repeat1($.attribute),
    },



    // only `global` for now
    _contextual_keyword: (_) => prec(1, "global"),
    
    // Name
    // also excludes @ and ? due to attributes
    identifier: (_) => {
      const identifier_start =
        // @ts-ignore
        /[^\p{Control}\s+\-*/%^#&~|<>=(){}\[\];:,.\\'"`@?\d]/;
      const identifier_continue =
        // @ts-ignore
        /[^\p{Control}\s+\-*/%^#&~|<>=(){}\[\];:,.\\'"`@?]*/;
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
