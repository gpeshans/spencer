import { quoteIdentifier, quoteQualified } from '../core/sql';
import type { ParamValue } from '../pg';
import type { AggregateQuery, ColumnFilterOp, Period, RowsQuery, StructuredQuery } from '../plan/query';
import type { ColumnKind, RelationVocabulary, Vocabulary } from '../plan/vocabulary';
import { dayBefore } from '../report/format';
import { expectedColumns, expectedTypes, type SectionSql } from './sql';

/**
 * The compiled SQL of a plan section (docs/report-engine-spec.md §4, stages 5
 * and 7): code turns the section's structured query into SQL, with the output
 * columns stage 4 must use too, so the two results line up column by column.
 * It checks the LLM's SQL (the cross-check) and stands in for it when it
 * keeps failing (the fallback). It is checked and run like any other SQL.
 *
 * Every identifier is quoted, every value is a parameter, and each metric is
 * its semantic-model expression, as the reviewed model file writes it.
 */

const CAST: Readonly<Record<ColumnKind, string>> = {
  text: 'text',
  number: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamptz',
};

class Params {
  readonly values: ParamValue[] = [];
  add(value: ParamValue, kind: ColumnKind): string {
    this.values.push(value);
    return `$${this.values.length}::${CAST[kind]}`;
  }
}

/** A filter value as its column holds it: plans write values as text. */
function typed(value: string | number | boolean, kind: ColumnKind): ParamValue {
  if (typeof value !== 'string') return value;
  if (kind === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (kind === 'boolean' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  return value;
}

function periodClause(period: Period | null, relation: RelationVocabulary, params: Params): string[] {
  if (!period || !relation.time) return [];
  const column = quoteIdentifier(relation.time.column);
  return [`${column} >= ${params.add(period.from, 'date')}`, `${column} < ${params.add(period.to, 'date')}`];
}

function filterClause(column: string, kind: ColumnKind, op: ColumnFilterOp, values: ReadonlyArray<string | number | boolean>, params: Params): string {
  const quoted = quoteIdentifier(column);
  const list = () => values.map((value) => params.add(typed(value, kind), kind)).join(', ');
  switch (op) {
    case 'in':
      return `${quoted} in (${list()})`;
    case 'not_in':
      return `${quoted} not in (${list()})`;
    case 'eq':
      return `${quoted} = ${params.add(typed(values[0]!, kind), kind)}`;
    case 'contains':
      return `strpos(lower(${quoted}), lower(${params.add(String(values[0]), 'text')})) > 0`;
    case 'gt':
      return `${quoted} > ${params.add(typed(values[0]!, kind), kind)}`;
    case 'gte':
      return `${quoted} >= ${params.add(typed(values[0]!, kind), kind)}`;
    case 'lt':
      return `${quoted} < ${params.add(typed(values[0]!, kind), kind)}`;
    case 'lte':
      return `${quoted} <= ${params.add(typed(values[0]!, kind), kind)}`;
  }
}

const kindOf = (relation: RelationVocabulary, column: string): ColumnKind =>
  relation.columns.find((candidate) => candidate.name === column)?.kind ?? 'text';

function compileAggregate(query: AggregateQuery, relation: RelationVocabulary, vocabulary: Vocabulary, params: Params): string {
  const select: string[] = [];
  for (const name of query.dimensions) {
    const dimension = vocabulary.dimension(name);
    if (!dimension) throw new Error(`compileQuery: unknown dimension ${name}`);
    select.push(`${quoteIdentifier(dimension.column)} as ${quoteIdentifier(name)}`);
  }
  if (query.grain) {
    if (!relation.time) throw new Error(`compileQuery: ${relation.name} has no date to group by`);
    select.push(`date_trunc('${query.grain}', ${quoteIdentifier(relation.time.column)})::date as ${quoteIdentifier(relation.time.dimension)}`);
  }
  const groups = select.length;
  for (const name of query.metrics) {
    const metric = vocabulary.metric(name);
    if (!metric) throw new Error(`compileQuery: unknown metric ${name}`);
    select.push(`${metric.expression} as ${quoteIdentifier(name)}`);
  }

  const where = periodClause(query.period, relation, params);
  for (const filter of query.filters) {
    const dimension = vocabulary.dimension(filter.dimension);
    if (!dimension) throw new Error(`compileQuery: unknown dimension ${filter.dimension}`);
    where.push(filterClause(dimension.column, kindOf(relation, dimension.column), filter.op, filter.values, params));
  }

  const positions = Array.from({ length: groups }, (_, index) => String(index + 1));
  // Without a sort, groups come in order, so a table reads the same every time.
  const order = query.sort.length > 0 ? query.sort.map((sort) => `${quoteIdentifier(sort.by)} ${sort.direction}`) : positions;
  return [
    `select ${select.join(', ')}`,
    `from ${quoteQualified(relation.name)}`,
    ...(where.length > 0 ? [`where ${where.join(' and ')}`] : []),
    ...(groups > 0 ? [`group by ${positions.join(', ')}`] : []),
    ...(order.length > 0 ? [`order by ${order.join(', ')}`] : []),
    ...(query.limit !== null ? [`limit ${query.limit}`] : []),
  ].join(' ');
}

function compileRows(query: RowsQuery, relation: RelationVocabulary, params: Params): string {
  const where = periodClause(query.period, relation, params);
  for (const filter of query.filters) {
    where.push(filterClause(filter.column, kindOf(relation, filter.column), filter.op, filter.values, params));
  }
  return [
    `select ${query.columns.map(quoteIdentifier).join(', ')}`,
    `from ${quoteQualified(relation.name)}`,
    ...(where.length > 0 ? [`where ${where.join(' and ')}`] : []),
    ...(query.sort.length > 0 ? [`order by ${query.sort.map((sort) => `${quoteIdentifier(sort.by)} ${sort.direction}`).join(', ')}`] : []),
    `limit ${query.limit}`,
  ].join(' ');
}

const words = (name: string) => name.replaceAll('_', ' ');
const list = (names: readonly string[]) => names.map(words).join(', ');

/** What the compiled query returns, in one plain sentence. */
export function describeQuery(query: StructuredQuery): string {
  const parts: string[] = [];
  if (query.shape === 'aggregate') {
    parts.push(
      `${list(query.metrics)}${query.dimensions.length > 0 ? ` by ${list(query.dimensions)}` : ''}${query.grain ? ` per ${query.grain}` : ''}`,
    );
  } else {
    parts.push(`${list(query.columns)} of each row`);
  }
  if (query.period) parts.push(`from ${query.period.from} to ${dayBefore(query.period.to)}`);
  const filters = query.shape === 'aggregate'
    ? query.filters.map((filter) => `${words(filter.dimension)} ${filter.op === 'in' ? 'is' : 'is not'} ${filter.values.join(' or ')}`)
    : query.filters.map((filter) => `${words(filter.column)} ${OP_WORDS[filter.op]} ${filter.values.join(' or ')}`);
  if (filters.length > 0) parts.push(`where ${filters.join(' and ')}`);
  if (query.sort.length > 0) parts.push(`sorted by ${query.sort.map((sort) => `${words(sort.by)}${sort.direction === 'desc' ? ' (highest first)' : ''}`).join(', ')}`);
  if (query.limit !== null) parts.push(`at most ${query.limit} rows`);
  const text = parts.join(', ');
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

const OP_WORDS: Readonly<Record<ColumnFilterOp, string>> = {
  eq: 'is',
  in: 'is',
  not_in: 'is not',
  contains: 'contains',
  gt: 'is over',
  gte: 'is at least',
  lt: 'is under',
  lte: 'is at most',
};

/**
 * The SQL for a section's structured query. The query has passed checkPlan,
 * so its names exist; a name that doesn't is a bug, and throws.
 */
export function compileQuery(section: string, query: StructuredQuery, vocabulary: Vocabulary): SectionSql {
  const relation = vocabulary.relation(query.relation);
  if (!relation) throw new Error(`compileQuery: unknown view ${query.relation}`);
  const params = new Params();
  const sql = query.shape === 'aggregate' ? compileAggregate(query, relation, vocabulary, params) : compileRows(query, relation, params);
  const types = expectedTypes(query, vocabulary);
  return {
    section,
    sql,
    params: params.values,
    summary: describeQuery(query),
    columns: expectedColumns(query, vocabulary).map((name) => ({ name, type: types.get(name) ?? 'text' })),
  };
}
