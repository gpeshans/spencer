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

export const QUERY_SHAPES = ['aggregate', 'rows', 'none'] as const;
export type QueryShape = (typeof QUERY_SHAPES)[number];

/**
 * What the LLM writes for a plan section's query: one flat object, whatever
 * the shape. Structured outputs allow at most 16 union-typed fields per
 * request, and a union of one variant per shape and view grows with every
 * view. So every name is an enum (none can be invented), and code checks that
 * the names fit the view: `toStructuredQuery`, then `checkQuery`, whose
 * problems go back to the LLM for another try. Fields the shape doesn't use
 * are empty, `none` or 0.
 */
export interface QueryDraft {
  shape: QueryShape;
  relation: string;
  metrics: string[];
  dimensions: string[];
  grain: Grain | 'none';
  columns: string[];
  filters: Array<{ field: string; op: ColumnFilterOp; values: string[] }>;
  period: Period | null;
  sort: Sort[];
  /** 0 for no limit. */
  limit: number;
}

const unique = (values: readonly string[]) => [...new Set(values)];

export function queryDraftSchema(vocabulary: Vocabulary): z.ZodType<QueryDraft> {
  const metrics = vocabulary.metrics.map((metric) => metric.name);
  const dimensions = vocabulary.dimensions.map((dimension) => dimension.name);
  const columns = unique(vocabulary.relations.flatMap((relation) => relation.columns.map((column) => column.name)));
  const times = unique(vocabulary.relations.flatMap((relation) => (relation.time ? [relation.time.dimension] : [])));
  const schema = z.object({
    shape: z
      .enum(QUERY_SHAPES)
      .describe('aggregate: metrics by dimensions and a grain. rows: a listing of records. none: no query.'),
    relation: nameOf(['', ...vocabulary.relations.map((relation) => relation.name)]).describe(
      'The view the query reads; empty for shape none.',
    ),
    metrics: namesOf(metrics).describe('aggregate: metrics computed over the view. Otherwise empty.'),
    dimensions: namesOf(dimensions).describe('aggregate: dimensions of the view to group by. Otherwise empty.'),
    grain: z.enum(['none', ...GRAINS]).describe("aggregate: group the view's date by this period, or none."),
    columns: namesOf(columns).describe('rows: columns of the view to list, in order. Otherwise empty.'),
    filters: z.array(
      z.object({
        field: nameOf(unique([...dimensions, ...columns])).describe('aggregate: a dimension. rows: a column.'),
        op: z.enum(COLUMN_FILTER_OPS),
        values: z.array(z.string()).min(1).describe('As text, e.g. "Groceries", "100" or "true".'),
      }),
    ),
    period: PeriodSchema.nullable().describe("Applies to the view's date; null for all time."),
    sort: z.array(
      z.object({ by: nameOf(unique([...metrics, ...dimensions, ...times, ...columns])), direction: z.enum(DIRECTIONS) }),
    ),
    limit: z.number().int().min(0).describe('Most rows to return, 0 for no limit. A listing needs 1 to 200.'),
  });
  // Built from the model at run time; its output is a QueryDraft.
  return schema as z.ZodType<QueryDraft>;
}

export type DraftResult = { ok: true; query: StructuredQuery | null } | { ok: false; issues: string[] };

/** A listing's filter values arrive as text; numbers and booleans become what their column holds. */
function coerce(value: string, kind: ColumnKind | undefined): string | number | boolean {
  const trimmed = value.trim();
  if (kind === 'number' && trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  if (kind === 'boolean' && (trimmed.toLowerCase() === 'true' || trimmed.toLowerCase() === 'false')) {
    return trimmed.toLowerCase() === 'true';
  }
  return value;
}

/** Turns a draft into a structured query and checks it (null for shape none). */
export function toStructuredQuery(draft: QueryDraft, vocabulary: Vocabulary): DraftResult {
  if (draft.shape === 'none') return { ok: true, query: null };
  const relation = vocabulary.relation(draft.relation);
  if (!relation) return { ok: false, issues: [`unknown view ${draft.relation}`] };
  const issues: string[] = [];
  let query: StructuredQuery;
  if (draft.shape === 'aggregate') {
    if (draft.columns.length > 0) issues.push('an aggregate lists no columns; use metrics and dimensions');
    const filters = draft.filters.map((filter) => {
      if (!['eq', 'in', 'not_in'].includes(filter.op)) {
        issues.push(`${filter.op} can't filter the dimension ${filter.field}; use in or not_in`);
      }
      return { dimension: filter.field, op: filter.op === 'not_in' ? ('not_in' as const) : ('in' as const), values: filter.values };
    });
    query = {
      shape: 'aggregate',
      relation: relation.name,
      metrics: draft.metrics,
      dimensions: draft.dimensions,
      grain: draft.grain === 'none' ? null : draft.grain,
      filters,
      period: draft.period,
      sort: draft.sort,
      limit: draft.limit > 0 ? draft.limit : null,
    };
  } else {
    if (draft.metrics.length > 0 || draft.dimensions.length > 0) {
      issues.push('a listing has no metrics or dimensions; list columns instead');
    }
    if (draft.grain !== 'none') issues.push('a listing has no grain');
    const kinds = new Map(relation.columns.map((column) => [column.name, column.kind]));
    query = {
      shape: 'rows',
      relation: relation.name,
      columns: draft.columns,
      filters: draft.filters.map((filter) => ({
        column: filter.field,
        op: filter.op,
        values: filter.values.map((value) => coerce(value, kinds.get(filter.field))),
      })),
      period: draft.period,
      sort: draft.sort,
      limit: draft.limit,
    };
  }
  issues.push(...checkQuery(query, vocabulary));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, query };
}

/** The draft a structured query comes from: the inverse of toStructuredQuery. */
export function toQueryDraft(query: StructuredQuery | null): QueryDraft {
  const empty = { metrics: [], dimensions: [], columns: [], grain: 'none' as const };
  if (!query) return { ...empty, shape: 'none', relation: '', filters: [], period: null, sort: [], limit: 0 };
  if (query.shape === 'aggregate') {
    return {
      ...empty,
      shape: 'aggregate',
      relation: query.relation,
      metrics: [...query.metrics],
      dimensions: [...query.dimensions],
      grain: query.grain ?? 'none',
      filters: query.filters.map((filter) => ({ field: filter.dimension, op: filter.op, values: [...filter.values] })),
      period: query.period,
      sort: [...query.sort],
      limit: query.limit ?? 0,
    };
  }
  return {
    ...empty,
    shape: 'rows',
    relation: query.relation,
    columns: [...query.columns],
    filters: query.filters.map((filter) => ({ field: filter.column, op: filter.op, values: filter.values.map(String) })),
    period: query.period,
    sort: [...query.sort],
    limit: query.limit,
  };
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
