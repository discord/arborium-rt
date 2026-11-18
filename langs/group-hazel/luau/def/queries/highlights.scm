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

(expr_function_definition
  [
    "function"
    "end"
  ] @keyword.function)



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

;(type_cast_expr "::" @operator)
("::" @operator)

(builtin_type) @type.builtin


(type_definition_stat
  name: (identifier) @type.definition)

(generic_type_list
  (identifier) @type)

(generic_type_list_with_defaults
  (identifier) @type)


; Classes
(stat_classDef
  [
    "class"
    "end"
  ] @keyword)

(class_field
  [
    "public"
  ] @keyword)

(class_field
  (identifier) @property)


; Builtins
((identifier) @constant.builtin
  (#eq? @constant.builtin "_VERSION"))

"..." @variable.builtin

((identifier) @constant.builtin @module.builtin
  (#any-of? @module.builtin "_G" "debug" "io" "jit" "math" "os" "package" "string"
  "table" "utf8" "bit32" "buffer" "vector"))

((identifier) @constant.builtin
  (#eq? @constant.builtin "coroutine"))


; Tables
(field
  name: (identifier) @property)

(dot_index_expression
  field: (identifier) @property)

(table_type
  (identifier) @property)

(table_constructor
  [
    "{"
    "}"
  ] @constructor)

(table_type
  access: [
    "read"
    "write"
  ] @tag)


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
  name:
    (expr_type_instantiate (identifier) @function.call))


(function_call
  (identifier) @function.builtin
  ; format-ignore
  (#any-of? @function.builtin
    ; built-in functions
    "assert" "collectgarbage" "error" "gcinfo" "getfenv" "getmetatable"
    "load" "loadfile" "loadstring" "module" "next" "ipairs" "pairs" "pcall" "print"
    "rawequal" "rawset" "rawget" "rawlen" "require" "select" "setfenv" "setmetatable"
    "newproxy" "tonumber" "tostring" "type" "typeof" "unpack" "xpcall"
    "__add" "__call" "__concat" "__div" "__eq" "__gc"
    "__idiv" "__index" "__le" "__len" "__lt" "__metatable" "__mod" "__mode" "__mul" "__name" "__newindex"
    "__pairs" "__pow" "__shl" "__shr" "__sub" "__tostring" "__unm" "__iter"))




; Attributes
(attribute "@" @attribute)
(attribute "@[" @attribute)
(attribute name: (identifier) @attribute)
(parattr name: (identifier) @attribute)


; Punctuations
[
  ";"
  ":"
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


(genericTypeList_wrapper
  [
    "<"
    ">"
  ] @punctuation.bracket)

(type_definition_stat
  [
    "<"
    ">"
  ] @punctuation.bracket)

(type_instantiation
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
      (as_expr
        (string
          content: _ @string.regexp))))

; ("123"):match("%d+")
(function_call
  (namecall_index_expression
    method: (identifier) @_method
    (#any-of? @_method "find" "format" "match" "gmatch" "gsub"))
  arguments:
    (arguments
      .
      (as_expr
        (string
          content: _ @string.regexp))))




; Other

((identifier) @keyword
  (#eq? @keyword "self"))
