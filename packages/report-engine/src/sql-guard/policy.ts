/**
 * What LLM-written SQL may use, by default (docs/report-engine-spec.md §5.4).
 *
 * Everything here is read-only and free of side effects. Functions that can
 * allocate unbounded memory from a single call (repeat, lpad, rpad) are left
 * out on purpose: timeouts don't stop an allocation.
 */
export const DEFAULT_ALLOWED_FUNCTIONS: readonly string[] = [
  // Aggregates
  'count', 'sum', 'avg', 'min', 'max', 'bool_and', 'bool_or', 'every', 'string_agg', 'array_agg',
  'percentile_cont', 'percentile_disc', 'mode', 'stddev', 'stddev_pop', 'stddev_samp',
  'variance', 'var_pop', 'var_samp',
  // Window functions
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead',
  'first_value', 'last_value', 'nth_value',
  // Dates and times
  'now', 'date_trunc', 'date_part', 'extract', 'date_bin', 'age', 'make_date', 'make_time',
  'make_timestamp', 'make_interval', 'to_char', 'to_date', 'to_timestamp', 'timezone',
  'justify_days', 'justify_hours', 'justify_interval', 'isfinite',
  // Set-returning
  'generate_series', 'unnest',
  // Numbers
  'abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'mod', 'div', 'power', 'sqrt', 'cbrt',
  'sign', 'exp', 'ln', 'log', 'log10', 'width_bucket', 'to_number',
  // Text
  'lower', 'upper', 'initcap', 'length', 'char_length', 'character_length', 'substring', 'substr',
  'left', 'right', 'btrim', 'ltrim', 'rtrim', 'concat', 'concat_ws', 'replace', 'translate',
  'split_part', 'position', 'strpos', 'starts_with', 'overlay',
  // Emitted by the parser for LIKE ... ESCAPE and SIMILAR TO
  'like_escape', 'similar_to_escape',
];

/** Type names as the parser writes them (e.g. `::int` becomes int4, `::boolean` bool). */
export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  'text', 'varchar', 'bpchar',
  'int2', 'int4', 'int8', 'numeric', 'float4', 'float8',
  'bool',
  'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval',
  'uuid',
];

/** Operators, plus the names the parser gives BETWEEN forms. */
export const DEFAULT_ALLOWED_OPERATORS: readonly string[] = [
  '=', '<>', '!=', '<', '>', '<=', '>=',
  '+', '-', '*', '/', '%', '^', '||',
  '~~', '!~~', '~~*', '!~~*', // LIKE, NOT LIKE, ILIKE, NOT ILIKE
  '~', '~*', '!~', '!~*', // regular expressions
  'BETWEEN', 'NOT BETWEEN', 'BETWEEN SYMMETRIC', 'NOT BETWEEN SYMMETRIC',
];

/** CURRENT_DATE and friends. CURRENT_USER, SESSION_USER etc. are not allowed. */
export const ALLOWED_VALUE_FUNCTIONS: ReadonlySet<string> = new Set([
  'SVFOP_CURRENT_DATE',
  'SVFOP_CURRENT_TIME',
  'SVFOP_CURRENT_TIME_N',
  'SVFOP_CURRENT_TIMESTAMP',
  'SVFOP_CURRENT_TIMESTAMP_N',
  'SVFOP_LOCALTIME',
  'SVFOP_LOCALTIME_N',
  'SVFOP_LOCALTIMESTAMP',
  'SVFOP_LOCALTIMESTAMP_N',
]);

/** Expression kinds of A_Expr nodes that are allowed (their operator is checked too). */
export const ALLOWED_EXPRESSION_KINDS: ReadonlySet<string> = new Set([
  'AEXPR_OP',
  'AEXPR_OP_ANY',
  'AEXPR_OP_ALL',
  'AEXPR_DISTINCT',
  'AEXPR_NOT_DISTINCT',
  'AEXPR_NULLIF',
  'AEXPR_IN',
  'AEXPR_LIKE',
  'AEXPR_ILIKE',
  'AEXPR_SIMILAR',
  'AEXPR_BETWEEN',
  'AEXPR_NOT_BETWEEN',
  'AEXPR_BETWEEN_SYM',
  'AEXPR_NOT_BETWEEN_SYM',
]);

export const ALLOWED_SUBLINK_TYPES: ReadonlySet<string> = new Set([
  'EXISTS_SUBLINK',
  'ALL_SUBLINK',
  'ANY_SUBLINK',
  'EXPR_SUBLINK',
  'ARRAY_SUBLINK',
]);

/**
 * Parse-tree node types allowed anywhere in a statement. Anything else is
 * rejected, so constructs nobody thought about fail safe. SelectStmt is
 * handled separately, and so is CommonTableExpr, which is only valid inside
 * a WITH clause.
 */
export const ALLOWED_NODE_TYPES: ReadonlySet<string> = new Set([
  'SelectStmt',
  'ResTarget',
  'ColumnRef',
  'A_Star',
  'A_Const',
  'ParamRef',
  'A_Expr',
  'BoolExpr',
  'NullTest',
  'BooleanTest',
  'FuncCall',
  'NamedArgExpr',
  'TypeCast',
  'TypeName',
  'CoalesceExpr',
  'MinMaxExpr',
  'CaseExpr',
  'CaseWhen',
  'SubLink',
  'RangeVar',
  'RangeSubselect',
  'RangeFunction',
  'JoinExpr',
  'SortBy',
  'WindowDef',
  'A_Indirection',
  'A_Indices',
  'A_ArrayExpr',
  'RowExpr',
  'CollateClause',
  'GroupingSet',
  'GroupingFunc',
  'SQLValueFunction',
  'Alias',
  'List',
  'String',
  'Integer',
  'Float',
  'Boolean',
  'BitString',
]);

export interface SqlGuardLimits {
  /** Characters in the SQL text. */
  maxLength: number;
  /** Nesting depth of the parse tree (a safety net against deep recursion). */
  maxDepth: number;
  /** Parse-tree nodes in total. */
  maxNodes: number;
  maxCtes: number;
  maxJoins: number;
  maxSubqueries: number;
  maxSetOperations: number;
}

export const DEFAULT_LIMITS: SqlGuardLimits = {
  maxLength: 20_000,
  maxDepth: 200,
  maxNodes: 4_000,
  maxCtes: 8,
  maxJoins: 10,
  maxSubqueries: 16,
  maxSetOperations: 6,
};
