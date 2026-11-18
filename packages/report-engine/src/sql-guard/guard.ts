import { createHash } from 'node:crypto';

import { parse } from 'libpg-query';

import {
  ALLOWED_EXPRESSION_KINDS,
  ALLOWED_NODE_TYPES,
  ALLOWED_SUBLINK_TYPES,
  ALLOWED_VALUE_FUNCTIONS,
  DEFAULT_ALLOWED_FUNCTIONS,
  DEFAULT_ALLOWED_OPERATORS,
  DEFAULT_ALLOWED_TYPES,
  DEFAULT_LIMITS,
  type SqlGuardLimits,
} from './policy';

/**
 * Checks LLM-written SQL before it runs (docs/report-engine-spec.md §5.4).
 *
 * The SQL is parsed with the real Postgres 17 parser and every node of the
 * parse tree is checked against allow-lists. Node types that aren't allowed
 * are rejected, so unknown constructs fail safe. The text that passes is
 * returned unchanged: the database parses that same text with the same
 * grammar, so what runs is exactly what was checked. Row limits are enforced
 * by the executor, not by rewriting the query.
 *
 * These checks assume the executor:
 * - pins `search_path` to `pg_catalog`, so unqualified function and operator
 *   names can only mean built-ins;
 * - sets `standard_conforming_strings = on`, so the server reads string
 *   literals the way the parser did;
 * - sends the SQL over the extended protocol (one statement per message) and
 *   caps rows at the protocol level, which keeps the query's own ORDER BY and
 *   LIMIT intact.
 */

export type SqlGuardIssueCode =
  | 'empty'
  | 'too_long'
  | 'syntax_error'
  | 'multiple_statements'
  | 'not_a_select'
  | 'select_into'
  | 'locking_clause'
  | 'recursive_cte'
  | 'data_modifying_cte'
  | 'unsupported_construct'
  | 'relation_not_allowed'
  | 'unqualified_relation'
  | 'function_not_allowed'
  | 'type_not_allowed'
  | 'operator_not_allowed'
  | 'value_function_not_allowed'
  | 'implicit_cross_join'
  | 'join_without_condition'
  | 'param_out_of_range'
  | 'too_complex';

export interface SqlGuardIssue {
  code: SqlGuardIssueCode;
  message: string;
  /** What to use instead, for repair prompts. */
  hint?: string;
  /** 0-based character offset, when the parser reports one. */
  position?: number;
}

export type SqlGuardResult =
  | {
      ok: true;
      /** The SQL exactly as given. */
      sql: string;
      /** Hash of the statement's structure: positions and literal values are ignored. */
      fingerprint: string;
      /** Relations the statement reads, schema-qualified and sorted. */
      relations: string[];
      /** Functions the statement calls, sorted. */
      functions: string[];
      /** Highest $n placeholder used (0 when none). */
      maxParam: number;
    }
  | { ok: false; issues: SqlGuardIssue[] };

export interface SqlGuardPolicy {
  /** Fully qualified relations the SQL may read, e.g. `reporting.spendings`. */
  relations: readonly string[];
  /** Replaces the default function allow-list. */
  functions?: readonly string[];
  /** Replaces the default type allow-list. */
  types?: readonly string[];
  /** Replaces the default operator allow-list. */
  operators?: readonly string[];
  limits?: Partial<SqlGuardLimits>;
}

export interface SqlGuardCheckOptions {
  /** Number of bind parameters the caller will pass; $n above it is rejected. */
  paramCount?: number;
}

export interface SqlGuard {
  check(sql: string, options?: SqlGuardCheckOptions): Promise<SqlGuardResult>;
}

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

interface ResolvedPolicy {
  relations: ReadonlySet<string>;
  functions: ReadonlySet<string>;
  types: ReadonlySet<string>;
  operators: ReadonlySet<string>;
  limits: SqlGuardLimits;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const NODE_KEY = /^[A-Z][A-Za-z0-9_]*$/;
const MAX_ISSUES = 20;

export function createSqlGuard(policy: SqlGuardPolicy): SqlGuard {
  const resolved = resolvePolicy(policy);
  return {
    check: (sql, options = {}) => checkSql(sql, resolved, options),
  };
}

function resolvePolicy(policy: SqlGuardPolicy): ResolvedPolicy {
  for (const relation of policy.relations) {
    const parts = relation.split('.');
    if (parts.length !== 2 || !parts.every((part) => IDENTIFIER.test(part))) {
      throw new Error(`sql-guard: relation "${relation}" must be a lowercase schema.name`);
    }
  }
  return {
    relations: new Set(policy.relations),
    functions: new Set(policy.functions ?? DEFAULT_ALLOWED_FUNCTIONS),
    types: new Set(policy.types ?? DEFAULT_ALLOWED_TYPES),
    operators: new Set(policy.operators ?? DEFAULT_ALLOWED_OPERATORS),
    limits: { ...DEFAULT_LIMITS, ...policy.limits },
  };
}

async function checkSql(
  sql: string,
  policy: ResolvedPolicy,
  options: SqlGuardCheckOptions,
): Promise<SqlGuardResult> {
  if (sql.trim() === '') return rejected({ code: 'empty', message: 'The SQL is empty.' });
  if (sql.length > policy.limits.maxLength) {
    return rejected({
      code: 'too_long',
      message: `The SQL is ${sql.length} characters long; the limit is ${policy.limits.maxLength}.`,
    });
  }

  let tree: { stmts?: Array<{ stmt?: Json }> };
  try {
    tree = (await parse(sql)) as typeof tree;
  } catch (error) {
    const details = (error as { sqlDetails?: { message?: string; cursorPosition?: number } }).sqlDetails;
    return rejected({
      code: 'syntax_error',
      message: details?.message ?? (error as Error).message,
      ...(typeof details?.cursorPosition === 'number' && { position: details.cursorPosition }),
    });
  }

  const statements = tree.stmts ?? [];
  if (statements.length === 0) return rejected({ code: 'empty', message: 'The SQL has no statement.' });
  if (statements.length > 1) {
    return rejected({
      code: 'multiple_statements',
      message: `Found ${statements.length} statements; exactly one SELECT is allowed.`,
    });
  }

  const statement = asNode(statements[0]?.stmt ?? null);
  if (!statement || statement.type !== 'SelectStmt') {
    return rejected({
      code: 'not_a_select',
      message: `${statement?.type ?? 'This'} statements are not allowed; write a single SELECT.`,
    });
  }

  const validator = new Validator(policy, options.paramCount);
  validator.select(statement.body, new Set(), 0);
  validator.checkCounts();
  if (validator.issues.length > 0) return { ok: false, issues: validator.issues };

  return {
    ok: true,
    sql,
    fingerprint: fingerprint(statement.body),
    relations: [...validator.relations].sort(),
    functions: [...validator.functions].sort(),
    maxParam: validator.maxParam,
  };
}

function rejected(issue: SqlGuardIssue): SqlGuardResult {
  return { ok: false, issues: [issue] };
}

/** A wrapped parse-tree node: an object with a single PascalCase key. */
function asNode(value: Json | undefined): { type: string; body: JsonObject } | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  const type = keys[0];
  if (keys.length !== 1 || type === undefined || !NODE_KEY.test(type)) return null;
  const body = value[type];
  return isObject(body) ? { type, body } : null;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(list: Json | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const node = asNode(item);
    return node?.type === 'String' && typeof node.body.sval === 'string' ? node.body.sval : '';
  });
}

class Validator {
  readonly issues: SqlGuardIssue[] = [];
  readonly relations = new Set<string>();
  readonly functions = new Set<string>();
  maxParam = 0;
  private readonly counts = { nodes: 0, ctes: 0, joins: 0, subqueries: 0, setOperations: 0 };
  private tooDeep = false;

  constructor(
    private readonly policy: ResolvedPolicy,
    private readonly paramCount: number | undefined,
  ) {}

  /** Validates a SELECT, with the CTE names visible from its enclosing scopes. */
  select(stmt: JsonObject, outerCtes: ReadonlySet<string>, depth: number): void {
    if (stmt.intoClause) {
      this.add({ code: 'select_into', message: 'SELECT ... INTO is not allowed.' });
    }
    if (Array.isArray(stmt.lockingClause) && stmt.lockingClause.length > 0) {
      this.add({
        code: 'locking_clause',
        message: 'Row locking (FOR UPDATE / FOR SHARE) is not allowed.',
      });
    }

    const visibleCtes = this.withClause(stmt.withClause, outerCtes, depth);

    if (typeof stmt.op === 'string' && stmt.op !== 'SETOP_NONE') {
      this.counts.setOperations += 1;
      for (const side of [stmt.larg, stmt.rarg]) {
        if (isObject(side)) this.select(side, visibleCtes, depth + 1);
      }
    }

    const from = Array.isArray(stmt.fromClause) ? stmt.fromClause : [];
    from.forEach((item, index) => {
      if (index > 0 && !isLateral(item)) {
        this.add({
          code: 'implicit_cross_join',
          message: 'A comma-separated FROM list joins every row with every row.',
          hint: 'Use an explicit JOIN ... ON <condition>.',
        });
      }
    });

    for (const [key, value] of Object.entries(stmt)) {
      if (key === 'withClause' || key === 'larg' || key === 'rarg') continue;
      if (key === 'intoClause' || key === 'lockingClause') continue;
      this.walk(value, visibleCtes, depth + 1);
    }
  }

  /** Validates a WITH clause and returns the CTE names visible after it. */
  private withClause(clause: Json | undefined, outerCtes: ReadonlySet<string>, depth: number): ReadonlySet<string> {
    if (!isObject(clause)) return outerCtes;
    if (clause.recursive) {
      this.add({ code: 'recursive_cte', message: 'WITH RECURSIVE is not allowed.' });
    }
    const visible = new Set(outerCtes);
    for (const item of Array.isArray(clause.ctes) ? clause.ctes : []) {
      const cte = asNode(item);
      if (!cte || cte.type !== 'CommonTableExpr') {
        this.unsupported(cte?.type ?? 'an unknown construct');
        continue;
      }
      this.counts.ctes += 1;
      if (cte.body.search_clause || cte.body.cycle_clause) {
        this.unsupported('SEARCH / CYCLE clauses');
      }
      const query = asNode(cte.body.ctequery);
      if (query?.type === 'SelectStmt') {
        // A non-recursive CTE sees the CTEs listed before it, not itself.
        this.select(query.body, new Set(visible), depth + 1);
      } else {
        this.add({
          code: 'data_modifying_cte',
          message: `WITH ${String(cte.body.ctename)} must be a SELECT, not ${query?.type ?? 'something else'}.`,
        });
      }
      if (typeof cte.body.ctename === 'string') visible.add(cte.body.ctename);
    }
    return visible;
  }

  private walk(value: Json | undefined, ctes: ReadonlySet<string>, depth: number): void {
    if (depth > this.policy.limits.maxDepth) {
      if (!this.tooDeep) {
        this.tooDeep = true;
        this.add({ code: 'too_complex', message: 'The query is nested too deeply.' });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item, ctes, depth + 1);
      return;
    }
    if (!isObject(value)) return;

    const node = asNode(value);
    if (!node) {
      for (const child of Object.values(value)) this.walk(child, ctes, depth + 1);
      return;
    }

    this.counts.nodes += 1;
    const { type, body } = node;
    if (!ALLOWED_NODE_TYPES.has(type)) {
      this.unsupported(type);
      return;
    }

    switch (type) {
      case 'SelectStmt':
        this.select(body, ctes, depth + 1);
        return;
      case 'RangeVar':
        this.rangeVar(body, ctes);
        return;
      case 'ParamRef':
        this.paramRef(body);
        return;
      case 'SQLValueFunction':
        if (!ALLOWED_VALUE_FUNCTIONS.has(String(body.op))) {
          this.add({
            code: 'value_function_not_allowed',
            message: `${String(body.op).replace('SVFOP_', '')} is not allowed.`,
            hint: 'Only CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP, LOCALTIME and LOCALTIMESTAMP are.',
          });
        }
        return;
      case 'TypeName':
        this.typeName(body);
        return;
      case 'TypeCast':
        if (isObject(body.typeName)) this.typeName(body.typeName);
        this.walk(body.arg, ctes, depth + 1);
        return;
      case 'FuncCall':
        this.funcCall(body);
        break;
      case 'A_Expr':
        this.expression(body);
        break;
      case 'JoinExpr':
        this.join(body);
        break;
      case 'SubLink':
        this.counts.subqueries += 1;
        if (!ALLOWED_SUBLINK_TYPES.has(String(body.subLinkType))) this.unsupported(String(body.subLinkType));
        // `x OPERATOR(s.op) ANY (subquery)` names its operator here.
        if (Array.isArray(body.operName) && body.operName.length > 0) this.operator(body.operName);
        break;
      case 'SortBy':
        // `ORDER BY x USING op` names an operator too.
        if (Array.isArray(body.useOp) && body.useOp.length > 0) this.operator(body.useOp);
        break;
      case 'RangeSubselect':
        this.counts.subqueries += 1;
        break;
      case 'RangeFunction':
        if (Array.isArray(body.coldeflist) && body.coldeflist.length > 0) {
          this.unsupported('column definition lists on functions');
        }
        break;
      case 'A_Indirection':
        // `(x).name` is field/method selection. Postgres resolves it as the
        // function name(x) for ANY single-argument function in the search path
        // (pg_catalog), so it reaches functions the allow-list never sees, e.g.
        // (2).pg_sleep or ('reports.scope').current_setting. `(x).*` expands a
        // whole row the same way. Reject both; array subscripting (A_Indices)
        // stays allowed. The compiler and the model's examples never use it.
        if (Array.isArray(body.indirection)) {
          for (const item of body.indirection) {
            const element = asNode(item);
            if (element?.type === 'String' || element?.type === 'A_Star') {
              this.unsupported('field or method selection with (…).name');
              break;
            }
          }
        }
        break;
    }

    for (const [key, child] of Object.entries(body)) {
      if (type === 'FuncCall' && key === 'funcname') continue;
      if (type === 'A_Expr' && key === 'name') continue;
      this.walk(child, ctes, depth + 1);
    }
  }

  private rangeVar(body: JsonObject, ctes: ReadonlySet<string>): void {
    const relname = String(body.relname ?? '');
    if (body.catalogname) {
      this.add({
        code: 'relation_not_allowed',
        message: `${String(body.catalogname)}.${String(body.schemaname)}.${relname} names another database.`,
        hint: this.relationsHint(),
      });
      return;
    }
    if (!body.schemaname) {
      if (ctes.has(relname)) return;
      const match = [...this.policy.relations].find((relation) => relation.endsWith(`.${relname}`));
      this.add({
        code: 'unqualified_relation',
        message: `${relname} must be schema-qualified.`,
        hint: match ? `Write ${match}.` : this.relationsHint(),
      });
      return;
    }
    const qualified = `${String(body.schemaname)}.${relname}`;
    if (!this.policy.relations.has(qualified)) {
      this.add({
        code: 'relation_not_allowed',
        message: `${qualified} is not readable.`,
        hint: this.relationsHint(),
      });
      return;
    }
    this.relations.add(qualified);
  }

  private funcCall(body: JsonObject): void {
    const name = strings(body.funcname);
    const [schema, fn] = name.length === 2 ? name : [undefined, name[0]];
    const allowed =
      name.length >= 1 &&
      name.length <= 2 &&
      (schema === undefined || schema === 'pg_catalog') &&
      fn !== undefined &&
      this.policy.functions.has(fn);
    if (!allowed) {
      const label = name.join('.') || 'this function';
      this.add({
        code: 'function_not_allowed',
        message: `${label}() is not allowed.`,
        hint: nearest(fn ?? '', this.policy.functions),
      });
      return;
    }
    this.functions.add(fn);
  }

  private expression(body: JsonObject): void {
    const kind = String(body.kind);
    if (!ALLOWED_EXPRESSION_KINDS.has(kind)) {
      this.unsupported(kind);
      return;
    }
    this.operator(body.name);
  }

  /** Checks an operator name list: unqualified or pg_catalog, and allow-listed. */
  private operator(nameList: Json | undefined): void {
    const name = strings(nameList);
    const operator = name.length === 2 && name[0] === 'pg_catalog' ? name[1] : name.length === 1 ? name[0] : undefined;
    if (operator === undefined || !this.policy.operators.has(operator)) {
      this.add({
        code: 'operator_not_allowed',
        message: `The operator ${name.join('.') || '?'} is not allowed.`,
        hint: `Allowed operators: ${[...this.policy.operators].join(' ')}`,
      });
    }
  }

  private typeName(body: JsonObject): void {
    const name = strings(body.names);
    const [schema, type] = name.length === 2 ? name : [undefined, name[0]];
    const allowed =
      !body.setof &&
      !body.pct_type &&
      name.length >= 1 &&
      name.length <= 2 &&
      (schema === undefined || schema === 'pg_catalog') &&
      type !== undefined &&
      this.policy.types.has(type);
    if (!allowed) {
      this.add({
        code: 'type_not_allowed',
        message: `The type ${name.join('.') || '?'} is not allowed.`,
        hint: `Allowed types: ${[...this.policy.types].join(', ')}`,
      });
    }
  }

  private join(body: JsonObject): void {
    this.counts.joins += 1;
    if (body.isNatural) {
      this.add({
        code: 'join_without_condition',
        message: 'NATURAL JOIN joins on whatever columns happen to share a name.',
        hint: 'Use JOIN ... ON <condition>.',
      });
      return;
    }
    // `ON true` (a constant) is a cross join in disguise.
    const quals = asNode(body.quals);
    const hasCondition =
      (body.quals !== undefined && quals?.type !== 'A_Const') ||
      (Array.isArray(body.usingClause) && body.usingClause.length > 0);
    if (!hasCondition && !isLateral(body.rarg ?? null)) {
      this.add({
        code: 'join_without_condition',
        message: 'A JOIN without a condition (e.g. CROSS JOIN) joins every row with every row.',
        hint: 'Use JOIN ... ON <condition>.',
      });
    }
  }

  private paramRef(body: JsonObject): void {
    const number = typeof body.number === 'number' ? body.number : 0;
    if (number < 1 || (this.paramCount !== undefined && number > this.paramCount)) {
      this.add({
        code: 'param_out_of_range',
        message: `$${number} has no value: ${this.paramCount ?? 0} parameter(s) are passed.`,
      });
      return;
    }
    this.maxParam = Math.max(this.maxParam, number);
  }

  checkCounts(): void {
    const { limits } = this.policy;
    const over: Array<[string, number, number]> = [
      ['parse-tree nodes', this.counts.nodes, limits.maxNodes],
      ['CTEs', this.counts.ctes, limits.maxCtes],
      ['joins', this.counts.joins, limits.maxJoins],
      ['subqueries', this.counts.subqueries, limits.maxSubqueries],
      ['set operations', this.counts.setOperations, limits.maxSetOperations],
    ];
    for (const [what, count, max] of over) {
      if (count > max) {
        this.add({ code: 'too_complex', message: `The query has ${count} ${what}; the limit is ${max}.` });
      }
    }
  }

  private unsupported(what: string): void {
    this.add({ code: 'unsupported_construct', message: `${what} is not allowed.` });
  }

  private relationsHint(): string {
    return `Readable relations: ${[...this.policy.relations].sort().join(', ')}`;
  }

  private add(issue: SqlGuardIssue): void {
    if (this.issues.length >= MAX_ISSUES) return;
    if (this.issues.some((i) => i.code === issue.code && i.message === issue.message)) return;
    this.issues.push(issue);
  }
}

/** True for a LATERAL subquery or LATERAL function call in FROM. */
function isLateral(item: Json): boolean {
  const node = asNode(item);
  return (node?.type === 'RangeSubselect' || node?.type === 'RangeFunction') && node.body.lateral === true;
}

/** Allowed names close to a rejected one, for the repair prompt. */
function nearest(name: string, allowed: ReadonlySet<string>): string {
  const close = [...allowed]
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .filter(({ distance }) => distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);
  return close.length > 0
    ? `Did you mean ${close.join(', ')}?`
    : `Allowed functions: ${[...allowed].sort().join(', ')}`;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** Structure hash: ignores positions and literal values, keeps everything else. */
function fingerprint(statement: JsonObject): string {
  const normalized = JSON.stringify(statement, (key, value: Json) => {
    if (key === 'location') return undefined;
    if (isObject(value) && 'A_Const' in value && Object.keys(value).length === 1) return { A_Const: '?' };
    return value;
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
