import { z } from 'zod';

import { GRAINS, type ColumnKind, type Grain, type RelationVocabulary, type Vocabulary } from './vocabulary';

/**
 * The structured query of a plan section (docs/report-engine-spec.md §4,
 * stage 3). Two shapes, both naming only what the semantic model defines:
 * - `aggregate`: metrics grouped by dimensions and an optional time grain;
 * - `rows`: a listing of a relation's columns.
 * Code compiles it to SQL for the fallback and the cross-check. A question that
 * spans two relations (spend against income) is two sections combined in code.
 */

export const DIRECTIONS = ['asc', 'desc'] as const;
export const DIMENSION_FILTER_OPS = ['in', 'not_in'] as const;
export const COLUMN_FILTER_OPS = ['eq', 'in', 'not_in', 'contains', 'gt', 'gte', 'lt', 'lte'] as const;
export const MAX_AGGREGATE_LIMIT = 1000;
export const MAX_ROWS_LIMIT = 200;

export type Direction = (typeof DIRECTIONS)[number];
export type ColumnFilterOp = (typeof COLUMN_FILTER_OPS)[number];

export const PeriodSchema = z.object({
  from: z.iso.date().describe('First day included, YYYY-MM-DD.'),
  to: z.iso.date().describe('First day after the period, YYYY-MM-DD. Not included.'),
});
export type Period = z.output<typeof PeriodSchema>;

export interface Sort {
  by: string;
  direction: Direction;
}

export interface AggregateQuery {
  shape: 'aggregate';
  relation: string;
  metrics: string[];
  dimensions: string[];
  grain: Grain | null;
  filters: Array<{ dimension: string; op: (typeof DIMENSION_FILTER_OPS)[number]; values: string[] }>;
  period: Period | null;
  sort: Sort[];
  limit: number | null;
}

export interface RowsQuery {
  shape: 'rows';
  relation: string;
  columns: string[];
  filters: Array<{ column: string; op: ColumnFilterOp; values: Array<string | number | boolean> }>;
  period: Period | null;
  sort: Sort[];
  limit: number;
}

export type StructuredQuery = AggregateQuery | RowsQuery;

/** An enum of `values`, or any string (code rejects it) when there are none. */
export function nameOf(values: readonly string[]): z.ZodType<string> {
  return values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
}

/** A list of names from `values`; always empty when there are none. */
export function namesOf(values: readonly string[]) {
  return values.length > 0 ? z.array(nameOf(values)) : z.array(z.string()).max(0);
}

/** `list` when the relation has something to put in it; otherwise it must stay empty. */
function emptyUnless<T extends z.ZodArray<z.ZodType>>(allowed: boolean, list: T): T {
  return allowed ? list : list.max(0);
}

function aggregateVariant(relation: RelationVocabulary) {
  const time = relation.time;
  const sortable = [...relation.metrics, ...relation.dimensions, ...(time ? [time.dimension] : [])];
  return z.object({
    shape: z.literal('aggregate'),
    relation: z.literal(relation.name),
    metrics: z.array(nameOf(relation.metrics)).min(1).describe('Metrics to compute.'),
    dimensions: namesOf(relation.dimensions).describe('Dimensions to group by; empty for a single figure.'),
    grain: time
      ? z.enum(GRAINS).nullable().describe(`Groups ${time.dimension} into periods of this size, or null.`)
      : z.null(),
    filters: emptyUnless(
      relation.dimensions.length > 0,
      z.array(
        z.object({
          dimension: nameOf(relation.dimensions),
          op: z.enum(DIMENSION_FILTER_OPS),
          values: z.array(z.string()).min(1).describe('Exact values, spelled as in the household values.'),
        }),
      ),
    ),
    period: time ? PeriodSchema.nullable().describe(`Applies to ${time.dimension}; null for all time.`) : z.null(),
    sort: z.array(z.object({ by: nameOf(sortable), direction: z.enum(DIRECTIONS) })),
    limit: z.number().int().min(1).max(MAX_AGGREGATE_LIMIT).nullable(),
  });
}

function rowsVariant(relation: RelationVocabulary) {
  const names = relation.columns.map((column) => column.name);
  const filterable = relation.columns.filter((column) => !isTime(column.kind)).map((column) => column.name);
  return z.object({
    shape: z.literal('rows'),
    relation: z.literal(relation.name),
    columns: z.array(nameOf(names)).min(1).describe('Columns to show, in order.'),
    filters: emptyUnless(
      filterable.length > 0,
      z.array(
        z.object({
          column: nameOf(filterable),
          op: z.enum(COLUMN_FILTER_OPS),
          values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
        }),
      ),
    ),
    period: relation.time
      ? PeriodSchema.nullable().describe(`Applies to ${relation.time.column}; null for all time.`)
      : z.null(),
    sort: z.array(z.object({ by: nameOf(names), direction: z.enum(DIRECTIONS) })),
    limit: z.number().int().min(1).max(MAX_ROWS_LIMIT),
  });
}

/** The schema for one structured query: one variant per shape and relation. */
export function structuredQuerySchema(vocabulary: Vocabulary): z.ZodType<StructuredQuery> {
  const variants: z.ZodType[] = [];
  for (const relation of vocabulary.relations) {
    if (relation.metrics.length > 0) variants.push(aggregateVariant(relation));
    if (relation.columns.length > 0) variants.push(rowsVariant(relation));
  }
  const [first, ...rest] = variants;
  if (!first) throw new Error('The semantic model has no relation a query could read.');
  const schema = rest.length === 0 ? first : z.union([first, ...rest] as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  // The variants are built at run time from the model, so their exact type is
  // only known here: each one is a StructuredQuery for its relation.
  return schema as z.ZodType<StructuredQuery>;
}

const isTime = (kind: ColumnKind) => kind === 'date' || kind === 'timestamp';

/** Whether `value` is a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function checkPeriod(period: Period, label = 'period'): string[] {
  if (!isIsoDate(period.from) || !isIsoDate(period.to)) return [`${label}: dates must be real days, YYYY-MM-DD`];
  return period.from < period.to ? [] : [`${label}: "from" (${period.from}) must be before "to" (${period.to})`];
}

const OPS_BY_KIND: Readonly<Record<ColumnKind, readonly ColumnFilterOp[]>> = {
  text: ['eq', 'in', 'not_in', 'contains'],
  number: ['eq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['eq'],
  date: [],
  timestamp: [],
};

const duplicates = (values: readonly string[]) => values.filter((value, index) => values.indexOf(value) !== index);

/**
 * Checks what the schema can't: that names belong together, that periods are
 * real, and that filters fit their columns. Returns readable issues; none means
 * the query is valid.
 */
export function checkQuery(query: StructuredQuery, vocabulary: Vocabulary): string[] {
  const relation = vocabulary.relation(query.relation);
  if (!relation) return [`unknown view ${query.relation}`];
  const issues: string[] = [];
  if (query.period) {
    if (!relation.time) issues.push(`${relation.name} has no date to apply a period to`);
    else issues.push(...checkPeriod(query.period));
  }
  return query.shape === 'aggregate'
    ? [...issues, ...checkAggregate(query, relation)]
    : [...issues, ...checkRows(query, relation)];
}

function checkAggregate(query: AggregateQuery, relation: RelationVocabulary): string[] {
  const issues: string[] = [];
  if (query.metrics.length === 0) issues.push('an aggregate needs at least one metric');
  for (const metric of query.metrics) {
    if (!relation.metrics.includes(metric)) issues.push(`metric ${metric} is not computed over ${relation.name}`);
  }
  for (const dimension of [...query.dimensions, ...query.filters.map((filter) => filter.dimension)]) {
    if (!relation.dimensions.includes(dimension)) issues.push(`dimension ${dimension} is not on ${relation.name}`);
  }
  for (const name of duplicates([...query.metrics, ...query.dimensions])) issues.push(`${name} is listed twice`);
  if (query.grain && !relation.time) issues.push(`${relation.name} has no date to group by ${query.grain}`);
  for (const filter of query.filters) {
    if (filter.values.length === 0) issues.push(`the filter on ${filter.dimension} has no values`);
  }
  const selected = new Set([...query.metrics, ...query.dimensions]);
  if (query.grain && relation.time) selected.add(relation.time.dimension);
  for (const sort of query.sort) {
    if (!selected.has(sort.by)) issues.push(`sort by ${sort.by}: only selected metrics and dimensions can be sorted by`);
  }
  if (query.limit !== null && !(Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= MAX_AGGREGATE_LIMIT)) {
    issues.push(`limit must be between 1 and ${MAX_AGGREGATE_LIMIT}`);
  }
  return issues;
}

function checkRows(query: RowsQuery, relation: RelationVocabulary): string[] {
  const issues: string[] = [];
  const columns = new Map(relation.columns.map((column) => [column.name, column.kind]));
  if (query.columns.length === 0) issues.push('a listing needs at least one column');
  for (const column of query.columns) {
    if (!columns.has(column)) issues.push(`column ${column} is not on ${relation.name}`);
  }
  for (const name of duplicates(query.columns)) issues.push(`${name} is listed twice`);
  for (const filter of query.filters) {
    const kind = columns.get(filter.column);
    if (!kind) {
      issues.push(`column ${filter.column} is not on ${relation.name}`);
      continue;
    }
    if (!OPS_BY_KIND[kind].includes(filter.op)) {
      issues.push(
        isTime(kind)
          ? `filter ${filter.column} with the period, not a filter`
          : `${filter.op} can't filter ${filter.column} (${kind}); use ${OPS_BY_KIND[kind].join(', ')}`,
      );
      continue;
    }
    const single = !['in', 'not_in'].includes(filter.op);
    if (filter.values.length === 0) issues.push(`the filter on ${filter.column} has no values`);
    else if (single && filter.values.length !== 1) issues.push(`${filter.op} on ${filter.column} takes exactly one value`);
    const expected = kind === 'number' ? 'number' : kind === 'boolean' ? 'boolean' : 'string';
    if (filter.values.some((value) => typeof value !== expected || (expected === 'number' && !Number.isFinite(value)))) {
      issues.push(`values for ${filter.column} must be ${expected}s`);
    }
  }
  for (const sort of query.sort) {
    if (!columns.has(sort.by)) issues.push(`sort by ${sort.by}: not a column of ${relation.name}`);
  }
  if (!(Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= MAX_ROWS_LIMIT)) {
    issues.push(`limit must be between 1 and ${MAX_ROWS_LIMIT}`);
  }
  return issues;
}
