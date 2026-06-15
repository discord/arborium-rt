; Prolog syntax highlighting (tree-sitter-prolog, MIT)

(line_comment) @comment
(block_comment) @comment

(variable) @variable
(number) @number
(string) @string
(back_quoted_string) @string
(cut) @keyword.control

; predicate / functor heads
(compound_term functor: (atom) @function)

; module-qualified calls, dict tags
(dict tag: (atom) @type)
(dict_pair key: (atom) @property)

(atom) @constant

[
  ":-"
  "-->"
  "?-"
  "::"
  ";"
  "|"
  "->"
  "*->"
  ","
] @keyword.operator

[
  "="
  "\\="
  "=="
  "\\=="
  "is"
  "@<"
  "@>"
  "@=<"
  "@>="
  "=.."
  "=:="
  "=\\="
  "<"
  ">"
  "=<"
  ">="
  "+"
  "-"
  "*"
  "/"
  "//"
  "mod"
  "rem"
  "div"
  "**"
  "^"
  "\\+"
] @operator

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

"." @punctuation.delimiter
