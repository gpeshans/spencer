import { z } from 'zod';

import type { GenerateRequest } from '../llm';
import type { ColumnType, ParamValue, QueryError, QueryOutcome } from '../pg';
import type { StructuredQuery } from '../plan/query';
import type { ColumnKind, Vocabulary } from '../plan/vocabulary';
import { fence, randomBoundary } from '../prompt/fence';
import type { SemanticModel } from '../semantic';
import type { SqlGuard, SqlGuardIssue } from '../sql-guard';
import type { PlanSection, ReportPlan } from './plan';

/**
 * Stages 4 and 5: write the SQL, then check it (docs/report-engine-spec.md §4).
 * The LLM writes one SELECT per section at high effort. Code checks each one
 * before it runs (sql-guard, parameters, output columns) and after (the
 * columns that came back), and asks for a repair with the exact errors.
 */

export const DECLARED_TYPES = ['text', 'integer', 'number', 'date', 'timestamp', 'boolean'] as const;
export type DeclaredType = (typeof DECLARED_TYPES)[number];

export interface SectionSql {
  section: string;
  sql: string;
  params: ParamValue[];
  summary: string;
  columns: Array<{ name: string; type: DeclaredType }>;
}

export interface SqlAnswer {
  sections: SectionSql[];
}

/** The same for every plan, so it compiles once and its prompt prefix stays cacheable. */
export function sqlSchema(): z.ZodType<SqlAnswer> {
  return z.object({
    sections: z.array(
      z.object({
        section: z.string().describe('The id of the plan section this query answers.'),
        sql: z.string().describe('One SELECT statement, optionally starting with WITH, without a semicolon.'),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe('The values of $1, $2, ... in order.'),
        summary: z.string().describe('What the query returns, in one plain sentence.'),
        columns: z
          .array(z.object({ name: z.string(), type: z.enum(DECLARED_TYPES) }))
          .describe('The output columns, in order.'),
      }),
    ),
  });
}

export function sqlInstructions(functions: readonly string[]): string {
  return `Stage 4: write the SQL for an approved report plan.

Write one PostgreSQL 17 query for every section of the plan whose display is not "text":
- One statement: a SELECT, optionally starting with WITH. No semicolon, no comments, nothing that writes, locks or changes settings.
- Read only the views in the schema block, always schema-qualified, e.g. reporting.spendings.
- Use only these functions: ${functions.join(', ')}. Operators and casts work as usual (::date, ::int, ::numeric, ::text).
- Every value that comes from the plan or the request (dates, names, amounts) goes in params. In the SQL it appears only as a placeholder: $1, $2, ... in order, each cast to its type, e.g. $1::date or $2::text. Never write such a value into the SQL text.
- Periods are half-open: the date column >= $1::date and < $2::date.
- Compute each metric with the expression the schema gives for it, and filter and group by each dimension's column.
- A grain groups the view's date with date_trunc('<grain>', <date column>)::date.
- Name the output columns exactly: each dimension by its dimension name, the grain column by the name of the view's time dimension, and each metric by its metric name. A listing uses the column names. Declare every output column with its type: text, integer, number, date, timestamp or boolean. count(*) is integer; sums and averages of amounts are number.
- Sort and limit as the section's structured query says.
- For a section without a structured query, do what its purpose says under the same rules, with plain snake_case column names.
- summary: one plain sentence saying what the query returns.`;
}

export const REPAIR_NOTE = `This is a repair. Some queries you wrote failed their checks or failed when they ran. Rewrite only the sections listed below, fixing every problem quoted for each. Keep everything that was right.`;

export interface SqlInput {
  plan: ReportPlan;
  today: string;
  timeZone: string;
}

const needsSql = (section: PlanSection) => section.display !== 'text';

export function renderSqlInput(input: SqlInput, boundary = randomBoundary()): string {
  const sections = input.plan.sections.filter(needsSql).map((section) => section.id);
  return [
    `Today is ${input.today}, in the time zone ${input.timeZone}.`,
    '',
    'The approved plan:',
    fence('plan', JSON.stringify(input.plan, null, 2), boundary),
    '',
    `Write a query for each of these sections: ${sections.join(', ')}.`,
  ].join('\n');
}

export function sqlRequest(cachePrefix: string, functions: readonly string[], input: SqlInput): GenerateRequest<SqlAnswer> {
  return {
    stage: 'sql',
    cachePrefix,
    system: sqlInstructions(functions),
    input: renderSqlInput(input),
    schema: sqlSchema(),
    effort: 'high',
    maxTokens: 16_000,
  };
}

export interface Failure {
  section: PlanSection;
  /** The SQL that failed; null when none was written. */
  previous: SectionSql | null;
  problems: string[];
}

export interface RepairInput extends SqlInput {
  failures: readonly Failure[];
  model: SemanticModel;
}

export function renderRepairInput(input: RepairInput, boundary = randomBoundary()): string {
  const failures = input.failures.map(({ section, previous, problems }) => {
    const relations = section.query
      ? input.model.relations.filter((relation) => relation.name === section.query!.relation)
      : input.model.relations;
    const columns = relations.map(
      (relation) => `Columns of ${relation.name}: ${relation.columns.map((column) => `${column.name} (${column.type})`).join(', ')}`,
    );
    return [
      `Section ${section.id}:`,
      previous ? `Previous SQL:\n${previous.sql}\nPrevious params: ${JSON.stringify(previous.params)}` : 'No SQL was written for it.',
      'Problems:',
      ...problems.map((problem) => `- ${problem}`),
      ...columns,
    ].join('\n');
  });
  return [
    renderSqlInput(input, boundary),
    '',
    `${REPAIR_NOTE} Only these: ${input.failures.map((failure) => failure.section.id).join(', ')}.`,
    fence('failures', failures.join('\n\n'), boundary),
  ].join('\n');
}

export function repairRequest(cachePrefix: string, functions: readonly string[], input: RepairInput): GenerateRequest<SqlAnswer> {
  return { ...sqlRequest(cachePrefix, functions, input), stage: 'sql_repair', input: renderRepairInput(input) };
}

/** The output columns a section's structured query asks for: dimensions, the time column, metrics. */
export function expectedColumns(query: StructuredQuery, vocabulary: Vocabulary): string[] {
  if (query.shape === 'rows') return [...query.columns];
  const time = query.grain ? vocabulary.relation(query.relation)?.time : null;
  return [...query.dimensions, ...(time ? [time.dimension] : []), ...query.metrics];
}

const NUMERIC = new Set<DeclaredType>(['integer', 'number']);
const sameFamily = (a: DeclaredType, b: DeclaredType) => a === b || (NUMERIC.has(a) && NUMERIC.has(b));

const TYPE_OF_KIND: Readonly<Record<ColumnKind, DeclaredType>> = {
  text: 'text',
  number: 'number',
  date: 'date',
  timestamp: 'timestamp',
  boolean: 'boolean',
};

/** The type each expected column should have, by name. */
export function expectedTypes(query: StructuredQuery, vocabulary: Vocabulary): Map<string, DeclaredType> {
  const relation = vocabulary.relation(query.relation);
  const kinds = new Map(relation?.columns.map((column) => [column.name, column.kind]));
  const types = new Map<string, DeclaredType>();
  if (query.shape === 'rows') {
    for (const name of query.columns) {
      const kind = kinds.get(name);
      if (kind) types.set(name, TYPE_OF_KIND[kind]);
    }
    return types;
  }
  for (const name of query.dimensions) {
    const kind = kinds.get(vocabulary.dimension(name)?.column ?? '');
    if (kind) types.set(name, TYPE_OF_KIND[kind]);
  }
  if (query.grain && relation?.time) types.set(relation.time.dimension, 'date');
  for (const name of query.metrics) types.set(name, 'number');
  return types;
}

/** Text values from the plan that must reach the SQL as parameters, never as literals. */
function planValues(query: StructuredQuery | null): string[] {
  if (!query) return [];
  const values: string[] = query.period ? [query.period.from, query.period.to] : [];
  for (const filter of query.filters) {
    for (const value of filter.values) if (typeof value === 'string' && value.length > 0) values.push(value);
  }
  return [...new Set(values)];
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const describeIssue = (issue: SqlGuardIssue) => `${issue.message}${issue.hint ? ` ${issue.hint}` : ''}`;

export interface CheckedSql extends SectionSql {
  fingerprint: string;
}

export interface StaticCheck {
  /** Sections whose SQL passed, ready to run. */
  valid: Map<string, CheckedSql>;
  /** Problems by section id, for sections that failed or got no SQL. */
  problems: Map<string, string[]>;
}

/** Stage 5's static checks for every section that needs SQL, in plan order. */
export async function checkSql(
  sqls: ReadonlyMap<string, SectionSql>,
  plan: ReportPlan,
  vocabulary: Vocabulary,
  guard: SqlGuard,
): Promise<StaticCheck> {
  const valid = new Map<string, CheckedSql>();
  const problems = new Map<string, string[]>();
  for (const section of plan.sections.filter(needsSql)) {
    const sql = sqls.get(section.id);
    if (!sql) {
      problems.set(section.id, ['No SQL was written for this section.']);
      continue;
    }
    const found: string[] = [];
    const verdict = await guard.check(sql.sql, { paramCount: sql.params.length });
    if (!verdict.ok) found.push(...verdict.issues.map(describeIssue));
    else if (verdict.maxParam !== sql.params.length) {
      found.push(`params has ${sql.params.length} values, but the SQL uses ${verdict.maxParam === 0 ? 'none' : `$1 to $${verdict.maxParam}`}.`);
    }
    for (const value of planValues(section.query)) {
      if (sql.sql.includes(literal(value))) found.push(`${literal(value)} is written into the SQL; pass it as a $n parameter.`);
    }
    const names = sql.columns.map((column) => column.name);
    const repeated = names.filter((name, index) => names.indexOf(name) !== index);
    if (repeated.length > 0) found.push(`Output columns are declared twice: ${[...new Set(repeated)].join(', ')}.`);
    if (section.query) {
      const expected = expectedColumns(section.query, vocabulary);
      const missing = expected.filter((name) => !names.includes(name));
      const extra = names.filter((name) => !expected.includes(name));
      if (missing.length > 0 || extra.length > 0) {
        found.push(
          `The output columns must be exactly ${expected.join(', ')}` +
            `${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}${extra.length > 0 ? `; not expected ${extra.join(', ')}` : ''}.`,
        );
      }
      const types = expectedTypes(section.query, vocabulary);
      for (const column of sql.columns) {
        const type = types.get(column.name);
        if (type && !sameFamily(type, column.type)) found.push(`${column.name} should be ${type}, not ${column.type}.`);
      }
    }
    if (found.length > 0 || !verdict.ok) problems.set(section.id, found);
    else valid.set(section.id, { ...sql, fingerprint: verdict.fingerprint });
  }
  return { valid, problems };
}

const DECLARED_OF: Partial<Record<ColumnType, DeclaredType>> = {
  text: 'text',
  integer: 'integer',
  number: 'number',
  date: 'date',
  timestamp: 'timestamp',
  boolean: 'boolean',
};

export function describeQueryError(error: QueryError): string[] {
  const head = `${error.code}: ${error.message}${error.hint ? ` ${error.hint}` : ''}`;
  return error.issues && error.issues.length > 0 ? [head, ...error.issues.map(describeIssue)] : [head];
}

/** Stage 6's check of what came back: an error, or columns other than the ones declared. */
export function checkOutcome(sql: SectionSql, outcome: QueryOutcome): string[] {
  if (!outcome.ok) return describeQueryError(outcome.error);
  const problems: string[] = [];
  const declared = new Map(sql.columns.map((column) => [column.name, column.type]));
  const returned = outcome.columns.map((column) => column.name);
  if (returned.length !== declared.size || returned.some((name) => !declared.has(name))) {
    problems.push(`The query returned the columns ${returned.join(', ')}, but declared ${[...declared.keys()].join(', ')}.`);
  }
  for (const column of outcome.columns) {
    const wanted = declared.get(column.name);
    const got = DECLARED_OF[column.type];
    if (wanted && (!got || !sameFamily(wanted, got))) {
      problems.push(`${column.name} came back as ${column.type}, not ${wanted}; cast it.`);
    }
  }
  return problems;
}
