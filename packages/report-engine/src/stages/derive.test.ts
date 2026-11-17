import { describe, expect, it } from 'vitest';

import type { QueryColumn } from '../pg';
import type { AggregateQuery } from '../plan/query';
import { buildVocabulary } from '../plan/vocabulary';
import { testModel } from '../testing/model';
import { computeDerived, runCrossChecks, type ComputedSection } from './derive';
import type { DerivedValue, PlanSection, ReportPlan } from './plan';

const base = testModel();
const vocabulary = buildVocabulary({
  ...base,
  metrics: [
    ...base.metrics,
    { name: 'average_expense', description: 'Average expense.', relation: 'reporting.spendings', expression: 'avg(amount)', unit: 'currency' },
  ],
});
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };
const SEPTEMBER = { from: '2026-09-01', to: '2026-10-01' };

const query = (fields: Partial<AggregateQuery> = {}): AggregateQuery => ({
  shape: 'aggregate',
  relation: 'reporting.spendings',
  metrics: ['spend'],
  dimensions: [],
  grain: null,
  filters: [],
  period: OCTOBER,
  sort: [],
  limit: null,
  ...fields,
});
const section = (id: string, fields: Partial<AggregateQuery> = {}): PlanSection => ({
  id,
  title: id,
  purpose: 'Shows it.',
  display: 'table',
  query: query(fields),
  essential: true,
});
const plan = (sections: PlanSection[], derived: DerivedValue[] = [], crossChecks: ReportPlan['crossChecks'] = []): ReportPlan => ({
  title: 'T',
  summary: 'S',
  sections,
  derived,
  crossChecks,
});

const columnsOf = (rows: Array<Record<string, unknown>>): QueryColumn[] =>
  Object.keys(rows[0] ?? {}).map((name) => ({ name, type: typeof rows[0]![name] === 'number' ? 'number' : 'text' }));
const ok = (id: string, rows: Array<Record<string, unknown>>, fields: Partial<ComputedSection> = {}): [string, ComputedSection] => [
  id,
  { section: id, status: 'ok', columns: columnsOf(rows), rows, truncated: false, ...fields },
];
const value = (fields: Partial<DerivedValue> & Pick<DerivedValue, 'kind'>): DerivedValue => ({
  id: 'derived',
  label: 'Derived',
  section: 'a',
  metric: 'spend',
  against: null,
  ...fields,
});

describe('computeDerived', () => {
  const byCategory = section('a', { dimensions: ['category'] });

  it("computes each row's share of the section's total, in percent", () => {
    const results = new Map([ok('a', [{ category: 'Groceries', spend: 300 }, { category: 'Dining', spend: '100.00' }])]);
    expect(computeDerived(plan([byCategory], [value({ kind: 'share_of_total' })]), results, vocabulary)).toEqual([
      {
        id: 'derived',
        kind: 'share_of_total',
        label: 'Derived',
        section: 'a',
        format: { kind: 'percent' },
        rows: [
          { key: { category: 'Groceries' }, value: 75 },
          { key: { category: 'Dining' }, value: 25 },
        ],
        skipped: null,
      },
    ]);
    const nothing = new Map([ok('a', [{ category: 'Groceries', spend: null }])]);
    expect(computeDerived(plan([byCategory], [value({ kind: 'share_of_total' })]), nothing, vocabulary)[0]!.rows).toEqual([
      { key: { category: 'Groceries' }, value: null },
    ]);
  });

  it('takes one section from another, row by row, a missing row being nothing', () => {
    const income = section('income', { relation: 'reporting.monthly_income', metrics: ['monthly_income'], grain: 'month' });
    const spend = section('spend', { grain: 'month' });
    const results = new Map([
      ok('income', [
        { income_month: '2026-09-01', monthly_income: 4050 },
        { income_month: '2026-10-01', monthly_income: 4050 },
      ]),
      ok('spend', [{ spent_on: '2026-10-01', spend: 2329.22 }]),
    ]);
    // The views name their months differently (income_month, spent_on); the months still line up.
    const difference = value({ kind: 'difference', section: 'income', metric: 'monthly_income', against: { section: 'spend', metric: 'spend' } });
    const [result] = computeDerived(plan([income, spend], [difference]), results, vocabulary);
    expect(result).toEqual({
      id: 'derived',
      kind: 'difference',
      label: 'Derived',
      section: 'income',
      format: { kind: 'money' },
      rows: [
        { key: { income_month: '2026-09-01' }, value: 4050 },
        { key: { income_month: '2026-10-01' }, value: 4050 - 2329.22 },
      ],
      skipped: null,
    });
  });

  it('divides one total by another, with nothing for a zero', () => {
    const results = new Map([ok('a', [{ spend: 50 }]), ok('b', [{ spend: 200 }]), ok('zero', [{ spend: 0 }])]);
    const sections = [section('a'), section('b'), section('zero')];
    const ratio = (against: string) => value({ kind: 'ratio', against: { section: against, metric: 'spend' } });
    expect(computeDerived(plan(sections, [ratio('b')]), results, vocabulary)[0]).toMatchObject({ format: { kind: 'number' }, rows: [{ key: {}, value: 0.25 }] });
    expect(computeDerived(plan(sections, [ratio('zero')]), results, vocabulary)[0]!.rows).toEqual([{ key: {}, value: null }]);
  });

  it('computes the change in percent, month by month in order when the periods differ', () => {
    const now = section('now', { grain: 'month', period: OCTOBER });
    const before = section('before', { grain: 'month', period: { from: '2025-10-01', to: '2025-11-01' } });
    const results = new Map([
      ok('now', [{ spent_on: '2026-10-01', spend: 150 }]),
      ok('before', [{ spent_on: '2025-10-01', spend: 100 }]),
    ]);
    const change = value({ kind: 'change', section: 'now', against: { section: 'before', metric: 'spend' } });
    expect(computeDerived(plan([now, before], [change]), results, vocabulary)[0]).toMatchObject({
      format: { kind: 'percent' },
      rows: [{ key: { spent_on: '2026-10-01' }, value: 50 }],
    });

    // Without a grain, rows match by their dimensions.
    const thisMonth = section('now', { dimensions: ['category'] });
    const lastMonth = section('before', { dimensions: ['category'], period: SEPTEMBER });
    const byCategory = new Map([
      ok('now', [{ category: 'Groceries', spend: 90 }, { category: 'Travel', spend: 10 }]),
      ok('before', [{ category: 'Travel', spend: 20 }, { category: 'Groceries', spend: 120 }]),
    ]);
    expect(computeDerived(plan([thisMonth, lastMonth], [change]), byCategory, vocabulary)[0]!.rows).toEqual([
      { key: { category: 'Groceries' }, value: -25 },
      { key: { category: 'Travel' }, value: -50 },
    ]);
  });

  it("is skipped, saying why, when a section can't be used", () => {
    const share = value({ kind: 'share_of_total' });
    const failed = new Map<string, ComputedSection>([['a', { section: 'a', status: 'failed', columns: [], rows: [], truncated: false }]]);
    expect(computeDerived(plan([byCategory], [share]), failed, vocabulary)[0]).toMatchObject({ rows: [], skipped: "section a couldn't be computed" });
    const cut = new Map([ok('a', [{ category: 'Groceries', spend: 1 }], { truncated: 'rows' })]);
    expect(computeDerived(plan([byCategory], [share]), cut, vocabulary)[0]!.skipped).toBe('section a was cut short, so its totals are incomplete');
    const difference = value({ kind: 'difference', against: { section: 'b', metric: 'spend' } });
    const onlyOne = new Map([ok('a', [{ category: 'Groceries', spend: 1 }])]);
    expect(computeDerived(plan([byCategory, section('b')], [difference]), onlyOne, vocabulary)[0]!.skipped).toBe("section b couldn't be computed");
  });
});

describe('runCrossChecks', () => {
  const parts = section('parts', { dimensions: ['category'] });
  const total = section('total');
  const check = { kind: 'sums_to' as const, parts: 'parts', total: 'total', metric: 'spend' };

  it('passes when the parts add up to the total, to the cent', () => {
    const results = new Map([ok('parts', [{ category: 'Groceries', spend: '516.45' }, { category: 'Dining', spend: 144.5 }]), ok('total', [{ spend: 660.95 }])]);
    expect(runCrossChecks(plan([parts, total], [], [check]), results, vocabulary)).toEqual([
      { ...check, verdict: 'pass', detail: 'The parts of parts add up to 660.95; the total in total is 660.95.' },
    ]);
  });

  it("fails when they don't", () => {
    const results = new Map([ok('parts', [{ category: 'Groceries', spend: 516.45 }]), ok('total', [{ spend: 660.95 }])]);
    expect(runCrossChecks(plan([parts, total], [], [check]), results, vocabulary)[0]).toMatchObject({ verdict: 'fail' });
  });

  it("is skipped for an average, a cut breakdown, or a section that failed", () => {
    const results = new Map([ok('parts', [{ category: 'Groceries', average_expense: 5 }]), ok('total', [{ average_expense: 5 }])]);
    const average = { ...check, metric: 'average_expense' };
    expect(runCrossChecks(plan([parts, total], [], [average]), results, vocabulary)[0]).toMatchObject({
      verdict: 'skipped',
      detail: "average_expense is not a sum or a count, so its parts don't add up to it",
    });
    const cut = new Map([ok('parts', [{ category: 'Groceries', spend: 1 }], { truncated: 'bytes' }), ok('total', [{ spend: 1 }])]);
    expect(runCrossChecks(plan([parts, total], [], [check]), cut, vocabulary)[0]!.verdict).toBe('skipped');
    expect(runCrossChecks(plan([parts, total], [], [check]), new Map([ok('total', [{ spend: 1 }])]), vocabulary)[0]).toMatchObject({
      verdict: 'skipped',
      detail: "section parts couldn't be computed",
    });
  });
});
