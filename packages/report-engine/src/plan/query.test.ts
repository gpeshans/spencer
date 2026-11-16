import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';

import { testModel } from '../testing/model';
import { checkPeriod, checkQuery, isIsoDate, structuredQuerySchema, type StructuredQuery } from './query';
import { buildVocabulary, columnKind } from './vocabulary';

const vocabulary = buildVocabulary(testModel());

describe('buildVocabulary', () => {
  it('groups metrics and dimensions by relation and finds the date', () => {
    const spendings = vocabulary.relation('reporting.spendings')!;
    expect(spendings.metrics).toEqual(['spend', 'expense_count']);
    expect(spendings.dimensions).toEqual(['category', 'bucket', 'member']);
    expect(spendings.time).toEqual({ dimension: 'spent_on', column: 'spent_on' });
    expect(vocabulary.relation('reporting.monthly_income')!.time).toEqual({ dimension: 'income_month', column: 'month' });
    expect(vocabulary.relation('reporting.categories')!.time).toBeNull();
  });

  it('leaves identifiers and unsupported types out of listings, and time out of dimensions', () => {
    const columns = vocabulary.relation('reporting.spendings')!.columns.map((column) => column.name);
    expect(columns).not.toContain('id');
    expect(columns).not.toContain('tags');
    expect(columns).toContain('created_at');
    expect(vocabulary.dimensions.map((dimension) => dimension.name)).toEqual(['category', 'bucket', 'member', 'income_category']);
  });

  it('classifies column types', () => {
    expect(columnKind('numeric(12,2)')).toBe('number');
    expect(columnKind('character varying(40)')).toBe('text');
    expect(columnKind('timestamp with time zone')).toBe('timestamp');
    expect(columnKind('uuid')).toBeNull();
    expect(columnKind('jsonb')).toBeNull();
  });

  it('needs a metric', () => {
    expect(() => buildVocabulary({ ...testModel(), metrics: [] })).toThrow('at least one metric');
  });
});

const aggregate = (fields: Partial<Extract<StructuredQuery, { shape: 'aggregate' }>> = {}): StructuredQuery => ({
  shape: 'aggregate',
  relation: 'reporting.spendings',
  metrics: ['spend'],
  dimensions: ['category'],
  grain: null,
  filters: [],
  period: { from: '2026-10-01', to: '2026-11-01' },
  sort: [{ by: 'spend', direction: 'desc' }],
  limit: null,
  ...fields,
});

const rows = (fields: Partial<Extract<StructuredQuery, { shape: 'rows' }>> = {}): StructuredQuery => ({
  shape: 'rows',
  relation: 'reporting.spendings',
  columns: ['spent_on', 'description', 'amount'],
  filters: [],
  period: null,
  sort: [{ by: 'amount', direction: 'desc' }],
  limit: 10,
  ...fields,
});

describe('structuredQuerySchema', () => {
  const schema = structuredQuerySchema(vocabulary);

  it('accepts both shapes', () => {
    expect(schema.safeParse(aggregate()).success).toBe(true);
    expect(schema.safeParse(rows()).success).toBe(true);
    expect(
      schema.safeParse(aggregate({ relation: 'reporting.monthly_income', metrics: ['monthly_income'], dimensions: [], sort: [] }))
        .success,
    ).toBe(true);
  });

  it('only accepts names from the model, for the right relation', () => {
    expect(schema.safeParse(aggregate({ metrics: ['profit'] })).success).toBe(false);
    expect(schema.safeParse(aggregate({ metrics: ['monthly_income'] })).success).toBe(false);
    expect(schema.safeParse(aggregate({ relation: 'reporting.categories' })).success).toBe(false);
    expect(schema.safeParse(rows({ columns: ['id'] })).success).toBe(false);
    expect(schema.safeParse(rows({ relation: 'public.profiles' })).success).toBe(false);
    expect(schema.safeParse(rows({ limit: 500 })).success).toBe(false);
  });

  it('becomes a JSON schema with an enum for every name', () => {
    const json = JSON.stringify(betaZodOutputFormat(schema).schema);
    expect(json).toContain('"enum":["spend","expense_count"]');
    expect(json).toContain('"const":"reporting.spendings"');
    expect(json).not.toContain('"id"');
  });
});

describe('checkQuery', () => {
  it('accepts valid queries', () => {
    expect(checkQuery(aggregate(), vocabulary)).toEqual([]);
    expect(checkQuery(aggregate({ grain: 'month', dimensions: [], sort: [{ by: 'spent_on', direction: 'asc' }] }), vocabulary)).toEqual([]);
    expect(checkQuery(rows({ filters: [{ column: 'description', op: 'contains', values: ['dentist'] }] }), vocabulary)).toEqual([]);
  });

  it('rejects names from another relation, duplicates, and sorting by what is not selected', () => {
    expect(checkQuery(aggregate({ metrics: ['monthly_income'] }), vocabulary)).toContain(
      'metric monthly_income is not computed over reporting.spendings',
    );
    expect(checkQuery(aggregate({ dimensions: ['category', 'category'] }), vocabulary)).toContain('category is listed twice');
    expect(checkQuery(aggregate({ sort: [{ by: 'bucket', direction: 'asc' }] }), vocabulary)).toEqual([
      'sort by bucket: only selected metrics and dimensions can be sorted by',
    ]);
    expect(checkQuery(aggregate({ sort: [{ by: 'spent_on', direction: 'asc' }] }), vocabulary)).toHaveLength(1);
  });

  it('checks periods and grain against the relation', () => {
    expect(checkQuery(aggregate({ period: { from: '2026-11-01', to: '2026-10-01' } }), vocabulary)).toEqual([
      'period: "from" (2026-11-01) must be before "to" (2026-10-01)',
    ]);
    expect(checkQuery(rows({ relation: 'reporting.categories', columns: ['label'], sort: [], period: { from: '2026-01-01', to: '2026-02-01' } }), vocabulary)).toEqual([
      'reporting.categories has no date to apply a period to',
    ]);
  });

  it('checks that filters fit their columns', () => {
    const issues = (filter: Extract<StructuredQuery, { shape: 'rows' }>['filters'][number]) =>
      checkQuery(rows({ filters: [filter] }), vocabulary);
    expect(issues({ column: 'amount', op: 'contains', values: ['5'] })).toEqual([
      "contains can't filter amount (number); use eq, in, not_in, gt, gte, lt, lte",
    ]);
    expect(issues({ column: 'amount', op: 'gt', values: ['100'] })).toEqual(['values for amount must be numbers']);
    expect(issues({ column: 'amount', op: 'gt', values: [1, 2] })).toEqual(['gt on amount takes exactly one value']);
    expect(issues({ column: 'spent_on', op: 'gte', values: ['2026-01-01'] })).toEqual([
      'filter spent_on with the period, not a filter',
    ]);
    expect(issues({ column: 'amount', op: 'eq', values: [] })).toEqual(['the filter on amount has no values']);
    expect(issues({ column: 'category_label', op: 'in', values: ['Rent', 'Groceries'] })).toEqual([]);
  });
});

describe('dates', () => {
  it('accepts only real calendar days', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-01-01')).toBe(false);
    expect(checkPeriod({ from: '2026-02-30', to: '2026-03-01' })).toEqual(['period: dates must be real days, YYYY-MM-DD']);
  });
});
