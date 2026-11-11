; Keywords
"return" @keyword.return

[
    "local"
    "const"
    "type"
    "export"
] @keyword


; Simple Expressions
(nil) @constant.builtin
(boolean) @boolean
(number) @number
(string) @string
(expr_vararg) @variable.builtin


; Statements
(stat_do
  [
    "do"
    "end"
  ] @keyword)

(stat_while
  [
    "while"
    "do"
    "end"
  ] @keyword.repeat)

(stat_repeat
  [
    "repeat"
    "until"
  ] @keyword.repeat)

[
  (stat_break)
  (stat_continue)
] @keyword.repeat

(stat_if
  [
    "if"
    "elseif"
    "else"
    "then"
    "end"
  ] @keyword.conditional)

(expr_ifConditional
  [
    "if"
    "then"
  ] @keyword.conditional)

(stat_elseif
  [
    "elseif"
    "then"
    "end"
  ] @keyword.conditional)

(elseif_clause
  [
    "elseif"
    "then"
  ] @keyword.conditional)

(stat_else
  [
    "else"
    "end"
  ] @keyword.conditional)

(else_clause
  "else" @keyword.conditional)

(stat_for
  [
    "for"
    "do"
    "end"
  ] @keyword.repeat)

(function_declaration
  [
    "function"
    "end"
  ] @keyword.function)

(function_definition
  [
    "function"
    "end"
  ] @keyword.function)

(stat_classDef
  [
    "open"
    "class"
    "extends"
    "end"
  ] @keyword)


; Operators
[
  "and"
  "not"
  "or"
  "in"
  "typeof"
] @keyword.operator

[
  "+"
  "-"
  "*"
  "/"
  "%"
  "^"
  "#"
  "=="
  "~="
  "<="
  ">="
  "<"
  ">"
  "="
  "&"
  "|"
  "?"
  "//"
  ".."
  "+="
  "-="
  "*="
  "/="
  "%="
  "^="
  "..="
  "//="
] @operator


; Variables
(identifier) @variable


; Types
(type
  (identifier) @type)

(type
  (generic_type
    (identifier) @type))

(builtin_type) @type.builtin

((identifier) @type
  (#lua-match? @type "^[A-Z]"))


; Typedefs
(type_definition
  "type"
  .
  (type) @type.definition
  "=")

; Constants
;((identifier) @constant
;  (#lua-match? @constant "^[A-Z][A-Z_0-9]+$"))

; Builtins
((identifier) @constant.builtin
  (#eq? @constant.builtin "_VERSION"))

((identifier) @variable.builtin
  (#eq? @variable.builtin "self"))

"..." @variable.builtin

((identifier) @module.builtin
  (#any-of? @module.builtin "_G" "debug" "io" "jit" "math" "os" "package" "string" "table" "utf8"))

((identifier) @keyword.coroutine
  (#eq? @keyword.coroutine "coroutine"))

; Tables
(field
  name: (identifier) @variable.member)

(dot_index_expression
  field: (identifier) @variable.member)

(table_type
  (identifier) @variable.member)

(table_constructor
  [
    "{"
    "}"
  ] @constructor)

; Functions
(parameter
  .
  (identifier) @variable.parameter)

(function_type
  (identifier) @variable.parameter)

(function_call
  name: (identifier) @function.call)

(function_declaration
  name: (identifier) @function)

(function_call
  name:
    (dot_index_expression
      field: (identifier) @function.call))

(function_declaration
  name:
    (dot_index_expression
      field: (identifier) @function))

(namecall_index_expression
  method: (identifier) @function.method.call)

(function_call
  (identifier) @function.builtin
  ; format-ignore
  (#any-of? @function.builtin
    ; built-in functions in Lua 5.1
    "assert" "collectgarbage" "dofile" "error" "getfenv" "getmetatable" "ipairs"
    "load" "loadfile" "loadstring" "module" "next" "pairs" "pcall" "print"
    "rawequal" "rawget" "rawlen" "rawset" "require" "select" "setfenv" "setmetatable"
    "tonumber" "tostring" "type" "unpack" "xpcall" "typeof"
    "__add" "__band" "__bnot" "__bor" "__bxor" "__call" "__concat" "__div" "__eq" "__gc"
    "__idiv" "__index" "__le" "__len" "__lt" "__metatable" "__mod" "__mul" "__name" "__newindex"
    "__pairs" "__pow" "__shl" "__shr" "__sub" "__tostring" "__unm"))


; Punctuations
[
  ";"
  ":"
  "::"
  ","
  "."
  "->"
] @punctuation.delimiter

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

(variable_list
  attribute:
    (attribute
      ([
        "<"
        ">"
      ] @punctuation.bracket
        (identifier) @attribute)))

(generic_type
  [
    "<"
    ">"
  ] @punctuation.bracket)

(generic_type_list
  [
    "<"
    ">"
  ] @punctuation.bracket)

; Comments
(comment) @comment @spell

((comment) @comment.documentation
  (#lua-match? @comment.documentation "^[-][-][-]"))

((comment) @comment.documentation
  (#lua-match? @comment.documentation "^[-][-](%s?)@"))

; string.match("123", "%d+")
(function_call
  (dot_index_expression
    field: (identifier) @_method
    (#any-of? @_method "find" "format" "match" "gmatch" "gsub"))
  arguments:
    (arguments
      .
      (_)
      .
      (string
        content: _ @string.regexp)))

; ("123"):match("%d+")
(function_call
  (namecall_index_expression
    method: (identifier) @_method
    (#any-of? @_method "find" "format" "match" "gmatch" "gsub"))
  arguments:
    (arguments
      .
      (string
        content: _ @string.regexp)))
