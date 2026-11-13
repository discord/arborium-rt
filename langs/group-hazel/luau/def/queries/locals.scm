; Scopes
[
  (chunk)
  (stat_do)
  (stat_while)
  (stat_repeat)
  (stat_if)
  (stat_for)
  (function_declaration)
  (expr_function_definition)
  (stat_classDef)
] @local.scope

; References
(identifier) @local.reference

; Definitions
(stat_assignment
  (variable_list
    (identifier) @local.definition.var))

(stat_assignment
  (variable_list
    (dot_index_expression
      .
      (_) @local.definition.associated
      (identifier) @local.definition.var)))

((function_declaration
  name: (identifier) @local.definition.function)
  (#set! definition.function.scope "parent"))

((function_declaration
  name:
    (dot_index_expression
      .
      (_) @local.definition.associated
      (identifier) @local.definition.function))
  (#set! definition.method.scope "parent"))

((function_declaration
  name: (namecall_index_expression
    method: (identifier) @local.definition.method))
  (#set! definition.method.scope "parent"))

(for_generic_clause
  (variable_list
    (identifier) @local.definition.var))

(for_numeric_clause
  name: (identifier) @local.definition.var)

(parameter
  (identifier) @local.definition.parameter)
