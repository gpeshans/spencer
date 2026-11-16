import { describe, expect, it } from 'vitest';

import type { QueryOutcome } from '../pg';
import { buildVocabulary } from '../plan/vocabulary';
import { createSqlGuard } from '../sql-guard';
import { testModel } from '../testing/model';
import { feasibilityQueries, judgeFeasibility, relationsFor } from './feasibility';
import type { Intent } from './intent';

const model = testModel();
const vocabulary = buildVocabulary(model);
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };

const intent = (fields: Partial<Intent> = {}): Intent => ({
  kind: 'breakdown',
  restated: 'Spending per category in October.',
  metrics: ['spend'],
  dimensions: ['category'],
  grain: null,
  filters: [],
  period: OCTOBER,
  comparison: null,
  assumptions: [],
  ambiguities: [],
  confidence: 'high',
  refusal: null,
  ...fields,
});

const coverage = (relation: string, row: Record<string, unknown>): QueryOutcome => ({
  id: `coverage.${relation}`,
  ok: true,
  columns: [],
  rows: [row],
  truncated: false,
  cost: 1,
  fingerprint: 'f',
  durationMs: 1,
});

const judge = (value: Intent, outcomes: QueryOutcome[], modelFresh = true) =>
  judgeFeasibility(value, vocabulary, outcomes, { modelFresh });

describe('feasibilityQueries', () => {
  it('reads the views of the metrics, or of the dimensions for a listing', () => {
    expect(relationsFor(intent(), vocabulary)).toEqual(['reporting.spendings']);
    expect(relationsFor(intent({ metrics: ['spend', 'monthly_income'] }), vocabulary)).toEqual([
      'reporting.monthly_income',
      'reporting.spendings',
    ]);
    expect(relationsFor(intent({ kind: 'listing', metrics: [], dimensions: ['income_category'] }), vocabulary)).toEqual([
      'reporting.monthly_income',
    ]);
  });

  it('counts rows in the period and the comparison period, with bound dates', () => {
    const [query] = feasibilityQueries(intent({ comparison: { from: '2026-09-01', to: '2026-10-01' } }), vocabulary);
    expect(query).toEqual({
      id: 'coverage.reporting.spendings',
      sql:
        'select min("spent_on")::text as first, max("spent_on")::text as last, ' +
        'count(*) filter (where "spent_on" >= $1::date and "spent_on" < $2::date)::int as rows, ' +
        'count(*) filter (where "spent_on" >= $3::date and "spent_on" < $4::date)::int as comparison_rows ' +
        'from "reporting"."spendings"',
      params: ['2026-10-01', '2026-11-01', '2026-09-01', '2026-10-01'],
    });
  });

  it('passes the same SQL guard as LLM-written SQL', async () => {
    const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });
    const queries = [
      ...feasibilityQueries(intent({ comparison: { from: '2026-09-01', to: '2026-10-01' } }), vocabulary),
      ...feasibilityQueries(intent({ period: null }), vocabulary),
    ];
    for (const query of queries) {
      expect(await guard.check(query.sql, { paramCount: query.params?.length ?? 0 }), query.sql).toMatchObject({ ok: true });
    }
  });
});

describe('judgeFeasibility', () => {
  it('is ok when every view has data in the period', () => {
    const result = judge(intent(), [coverage('reporting.spendings', { first: '2026-01-03', last: '2026-11-15', rows: 42 })]);
    expect(result).toEqual({
      status: 'ok',
      coverage: [{ relation: 'reporting.spendings', first: '2026-01-03', last: '2026-11-15', rows: 42, comparisonRows: null }],
      gaps: [],
      alternatives: [],
    });
  });

  it('is partial when data starts inside the period, or the comparison has none', () => {
    expect(judge(intent(), [coverage('reporting.spendings', { first: '2026-10-12', last: '2026-11-15', rows: 9 })])).toMatchObject({
      status: 'partial',
      gaps: ['reporting.spendings has data only from 2026-10-12, so the period is covered from then on.'],
    });
    const compared = intent({ comparison: { from: '2026-09-01', to: '2026-10-01' } });
    expect(
      judge(compared, [coverage('reporting.spendings', { first: '2026-01-03', last: '2026-11-15', rows: 9, comparison_rows: 0 })]),
    ).toMatchObject({
      status: 'partial',
      gaps: ['reporting.spendings has no data for the comparison period, 2026-09-01 to 2026-09-30.'],
    });
  });

  it('is no when the period has no data, and offers the range that has', () => {
    expect(judge(intent(), [coverage('reporting.spendings', { first: '2026-03-01', last: '2026-08-31', rows: 0 })])).toEqual({
      status: 'no',
      coverage: [{ relation: 'reporting.spendings', first: '2026-03-01', last: '2026-08-31', rows: 0, comparisonRows: null }],
      gaps: ['reporting.spendings has no data from 2026-10-01 to 2026-10-31.'],
      alternatives: ['Ask about 2026-03-01 to 2026-08-31, where reporting.spendings has data.'],
    });
    expect(judge(intent(), [coverage('reporting.spendings', { first: null, last: null, rows: 0 })])).toMatchObject({
      status: 'no',
      gaps: ['There is no data in reporting.spendings yet.'],
    });
  });

  it('is partial when only one of two views has data, or a view could not be checked', () => {
    const both = intent({ metrics: ['spend', 'monthly_income'], dimensions: [] });
    expect(
      judge(both, [
        coverage('reporting.spendings', { first: '2026-01-03', last: '2026-11-15', rows: 4 }),
        coverage('reporting.monthly_income', { first: null, last: null, rows: 0 }),
      ]).status,
    ).toBe('partial');
    expect(judge(intent(), [])).toMatchObject({
      status: 'partial',
      gaps: ["The data in reporting.spendings couldn't be checked."],
    });
  });

  it('is no when the semantic model is out of date', () => {
    expect(judge(intent(), [], false)).toMatchObject({ status: 'no', gaps: [expect.stringContaining('out of date')] });
  });
});
