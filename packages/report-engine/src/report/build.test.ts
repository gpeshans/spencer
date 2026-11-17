import { describe, expect, it } from 'vitest';

import type { ColumnType } from '../pg/values';
import { newRun, type RunState, type SectionResult } from '../pipeline/state';
import type { AggregateQuery, RowsQuery } from '../plan/query';
import { buildVocabulary } from '../plan/vocabulary';
import type { PlanSection } from '../stages/plan';
import { testModel } from '../testing/model';
import { buildReport, DEFAULT_PALETTE } from './build';
import type { ChartSpec, ReportBlock, ReportStyles } from './document';

const model = testModel();
model.metrics.push({
  name: 'average_expense',
  description: 'Average expense.',
  relation: 'reporting.spendings',
  expression: 'avg(amount)',
  unit: 'currency',
});
const vocabulary = buildVocabulary(model);

const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };

const aggregate = (fields: Partial<AggregateQuery>): AggregateQuery => ({
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

const listing = (columns: string[]): RowsQuery => ({
  shape: 'rows',
  relation: 'reporting.spendings',
  columns,
  filters: [],
  period: OCTOBER,
  sort: [],
  limit: 10,
});

const section = (id: string, display: PlanSection['display'], query: PlanSection['query']): PlanSection => ({
  id,
  title: `Title ${id}`,
  purpose: `Purpose of ${id}.`,
  display,
  query,
  essential: false,
});

const result = (
  id: string,
  columns: Array<[string, ColumnType]>,
  rows: Array<Record<string, unknown>>,
  fields: Partial<SectionResult> = {},
): SectionResult => ({
  section: id,
  status: 'ok',
  sql: 'select secret_sql',
  params: ['2026-10-01'],
  summary: `Summary of ${id}.`,
  columns: columns.map(([name, type]) => ({ name, type })),
  rows,
  truncated: false,
  attempts: 1,
  problems: [],
  ...fields,
});

const finished = (sections: PlanSection[], results: SectionResult[], status: RunState['status'] = 'succeeded'): RunState => ({
  ...newRun('3f0c7a52-6b1e-4d2a-9c8e-1b2a3c4d5e6f', 'How much did we spend?'),
  status,
  plan: { title: 'October spending', summary: 'Where it went.', sections, derived: [], crossChecks: [] },
  results,
});

const STYLES: ReportStyles = {
  category: { Groceries: { color: '#2f9e44' }, Dining: { color: '#e8590c' } },
  bucket: { needs: { label: 'Needs', color: '#1971c2' }, wants: { label: 'Wants', color: '#f08c00' } },
  member: { Ada: { color: '#ae3ec9' }, Bob: { color: '#e8590c' } },
};

const build = (run: RunState, styles: ReportStyles = STYLES) => buildReport(run, vocabulary, { currency: 'EUR', styles })!;
const blockOf = (run: RunState, id: string): ReportBlock => build(run).sections.find((entry) => entry.id === id)!.block;
const chartOf = (run: RunState, id: string): ChartSpec => {
  const block = blockOf(run, id);
  if (block.kind !== 'chart') throw new Error(`${id} is a ${block.kind}, not a chart`);
  return block.chart;
};

/** One section drawn as `display`, with these result columns and rows. */
const single = (display: PlanSection['display'], query: PlanSection['query'], columns: Array<[string, ColumnType]>, rows: Array<Record<string, unknown>>) =>
  finished([section('s', display, query)], [result('s', columns, rows)]);

const days = (count: number) =>
  Array.from({ length: count }, (_, index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));

describe('buildReport', () => {
  it('is null until the run has results to show', () => {
    expect(buildReport({ ...finished([], []), status: 'executing' }, vocabulary, { currency: 'EUR' })).toBeNull();
    expect(buildReport({ ...finished([], []), status: 'failed' }, vocabulary, { currency: 'EUR' })).toBeNull();
    expect(buildReport({ ...finished([], []), plan: null }, vocabulary, { currency: 'EUR' })).toBeNull();
  });

  it("keeps the plan's order and words, the question and the currency", () => {
    const run = finished(
      [section('note', 'text', null), section('total', 'figure', aggregate({}))],
      [result('total', [['spend', 'number']], [{ spend: 1234.5 }])],
    );
    const document = build(run);
    expect(document).toMatchObject({
      version: 2,
      title: 'October spending',
      summary: 'Where it went.',
      request: 'How much did we spend?',
      status: 'succeeded',
      currency: 'EUR',
      period: null,
      comparison: null,
      assumptions: [],
      narrative: null,
      sources: [{ section: 'total', title: 'Title total', summary: 'Summary of total.' }],
    });
    expect(document.sections).toEqual([
      { id: 'note', title: 'Title note', description: null, block: { kind: 'text', text: 'Purpose of note.' }, verification: null },
      {
        id: 'total',
        title: 'Title total',
        description: 'Summary of total.',
        block: { kind: 'figures', figures: [{ label: 'Spend', value: 1234.5, format: { kind: 'money' } }] },
        // A run from before the checks: nothing to say.
        verification: null,
      },
    ]);
  });

  it('carries the period, the assumptions and the narrative', () => {
    const run: RunState = {
      ...finished([section('total', 'figure', aggregate({}))], [result('total', [['spend', 'number']], [{ spend: 1234.5 }])]),
      intent: {
        kind: 'figure',
        restated: 'Spending in October.',
        metrics: ['spend'],
        dimensions: [],
        grain: null,
        filters: [],
        period: OCTOBER,
        comparison: { from: '2025-10-01', to: '2025-11-01' },
        assumptions: ['October means October 2026.'],
        ambiguities: [],
        confidence: 'high',
        refusal: null,
      },
      narrative: { headline: ['You spent ', { value: 1234.5, format: { kind: 'money' } }, '.'], insights: [] },
    };
    expect(build(run)).toMatchObject({
      period: { first: '2026-10-01', last: '2026-10-31' },
      comparison: { first: '2025-10-01', last: '2025-10-31' },
      assumptions: ['October means October 2026.'],
      narrative: run.narrative,
    });
  });

  it('says how far each section is checked', () => {
    const query = aggregate({ dimensions: ['category'] });
    const columns: Array<[string, ColumnType]> = [['category', 'text'], ['spend', 'number']];
    const rows = [{ category: 'Groceries', spend: 3 }];
    const run: RunState = {
      ...finished(
        ['match', 'mismatch', 'fallback', 'unavailable', 'none', 'cut', 'summed', 'failed'].map((id) => section(id, 'table', query)),
        [
          result('match', columns, rows, { check: 'match' }),
          result('mismatch', columns, rows, { check: 'mismatch', source: 'compiled', summary: 'Spend by category, from 2026-10-01 to 2026-10-31.' }),
          result('fallback', columns, rows, { check: 'fallback', source: 'compiled' }),
          result('unavailable', columns, rows, { check: 'unavailable' }),
          result('none', columns, rows, { check: 'none' }),
          result('cut', columns, rows, { check: 'match', truncated: 'rows' }),
          result('summed', columns, rows, { check: 'match' }),
          result('failed', [], [], { status: 'failed', check: 'none' }),
        ],
        'partial',
      ),
      checks: [{ kind: 'sums_to', parts: 'summed', total: 'match', metric: 'spend', verdict: 'fail', detail: 'They differ.' }],
    };
    const document = build(run);
    expect(Object.fromEntries(document.sections.map((entry) => [entry.id, entry.verification]))).toEqual({
      match: 'unverified',
      mismatch: 'verified',
      fallback: 'verified',
      unavailable: 'unverified',
      none: 'unverified',
      cut: 'truncated',
      summed: 'unverified',
      failed: null,
    });
    // Compiled SQL's code-written summary goes in the sources, and the purpose describes the section.
    expect(document.sections.find((entry) => entry.id === 'mismatch')?.description).toBe('Purpose of mismatch.');
    expect(document.sources.find((source) => source.section === 'mismatch')?.summary).toBe('Spend by category, from 2026-10-01 to 2026-10-31.');
    expect(document.sources.some((source) => source.section === 'failed')).toBe(false);
  });

  it('puts derived values beside the rows they come from', () => {
    const run: RunState = {
      ...finished(
        [section('by_category', 'bar', aggregate({ dimensions: ['category'] })), section('total', 'figure', aggregate({}))],
        [
          result('by_category', [['category', 'text'], ['spend', 'number']], [{ category: 'Groceries', spend: 30 }, { category: 'Dining', spend: 10 }]),
          result('total', [['spend', 'number']], [{ spend: 40 }]),
        ],
      ),
      derived: [
        {
          id: 'share',
          kind: 'share_of_total',
          label: 'Share',
          section: 'by_category',
          format: { kind: 'percent' },
          rows: [
            { key: { category: 'Groceries' }, value: 75 },
            { key: { category: 'Dining' }, value: 25 },
          ],
          skipped: null,
        },
        { id: 'left', kind: 'difference', label: 'Left over', section: 'total', format: { kind: 'money' }, rows: [{ key: {}, value: 960 }], skipped: null },
        { id: 'skipped', kind: 'ratio', label: 'Ratio', section: 'total', format: { kind: 'number' }, rows: [], skipped: 'section x failed' },
      ],
    };
    const block = blockOf(run, 'by_category');
    if (block.kind !== 'chart') throw new Error(`expected a chart, not ${block.kind}`);
    expect(block.table.columns.at(-1)).toEqual({ key: 'derived:share', label: 'Share', format: { kind: 'percent' } });
    expect(block.table.rows.map((row) => row['derived:share'])).toEqual([75, 25]);
    // The chart shows the metric only.
    expect(block.chart.series.map((series) => series.label)).toEqual(['Spend']);
    expect(blockOf(run, 'total')).toEqual({
      kind: 'figures',
      figures: [
        { label: 'Spend', value: 40, format: { kind: 'money' } },
        { label: 'Left over', value: 960, format: { kind: 'money' } },
      ],
    });
  });

  it("formats a breakdown's columns by their metric and dimension", () => {
    const run = finished(
      [section('by_category', 'table', aggregate({ metrics: ['spend', 'expense_count'], dimensions: ['category'] }))],
      [
        result('by_category', [['category', 'text'], ['spend', 'number'], ['expense_count', 'integer']], [{ category: 'Groceries', spend: 300, expense_count: 12 }], {
          truncated: 'rows',
        }),
      ],
    );
    expect(blockOf(run, 'by_category')).toEqual({
      kind: 'table',
      table: {
        columns: [
          { key: 'category', label: 'Category', format: { kind: 'text' } },
          { key: 'spend', label: 'Spend', format: { kind: 'money' } },
          { key: 'expense_count', label: 'Expense count', format: { kind: 'count' } },
        ],
        rows: [{ category: 'Groceries', spend: 300, expense_count: 12 }],
        truncated: 'rows',
      },
    });
  });

  it("shows a listing's amounts as money, names columns after their dimensions, and labels buckets", () => {
    const columns: Array<[string, ColumnType]> = [
      ['spent_on', 'date'],
      ['description', 'text'],
      ['amount', 'number'],
      ['category_label', 'text'],
      ['bucket', 'text'],
      ['member_name', 'text'],
      ['created_at', 'timestamp'],
    ];
    const row = {
      spent_on: '2026-10-03',
      description: 'Market',
      amount: 42.5,
      category_label: 'Groceries',
      bucket: 'needs',
      member_name: 'Ada',
      created_at: '2026-10-03 10:00:00+02',
    };
    const block = blockOf(single('table', listing(columns.map(([name]) => name)), columns, [row]), 's');
    if (block.kind !== 'table') throw new Error(block.kind);
    expect(block.table.columns.map((column) => [column.key, column.label, column.format.kind])).toEqual([
      ['spent_on', 'Spent on', 'date'],
      ['description', 'Description', 'text'],
      ['amount', 'Amount', 'money'],
      ['category_label', 'Category', 'text'],
      ['bucket', 'Bucket', 'text'],
      ['member_name', 'Member', 'text'],
      ['created_at', 'Created at', 'timestamp'],
    ]);
    expect(block.table.rows).toEqual([{ ...row, bucket: 'Needs' }]);
  });

  it('works from the names when a section has no structured query', () => {
    const run = single(
      'table',
      null,
      [['month', 'date'], ['spend', 'number'], ['amount', 'number'], ['ratio', 'number'], ['n', 'integer'], ['bucket', 'text']],
      [{ month: '2026-10-01', spend: 10, amount: 5, ratio: 0.5, n: 3, bucket: 'wants' }],
    );
    const block = blockOf(run, 's');
    if (block.kind !== 'table') throw new Error(block.kind);
    expect(block.table.columns.map((column) => column.format)).toEqual([
      { kind: 'date', grain: null },
      { kind: 'money' },
      { kind: 'money' },
      { kind: 'number' },
      { kind: 'count' },
      { kind: 'text' },
    ]);
    expect(block.table.rows[0]).toMatchObject({ bucket: 'Wants' });
  });

  it('marks failed and empty sections, and keeps SQL and problems out of the document', () => {
    const query = aggregate({ dimensions: ['category'] });
    const run = finished(
      [section('a', 'table', query), section('b', 'table', query), section('c', 'bar', query)],
      [
        result('a', [['category', 'text'], ['spend', 'number']], [], { summary: null }),
        result('b', [], [], { status: 'failed', problems: ['column "boom" does not exist'] }),
      ],
      'partial',
    );
    const document = build(run);
    expect(document.status).toBe('partial');
    expect(document.sections.map((entry) => [entry.id, entry.block.kind, entry.description])).toEqual([
      ['a', 'empty', 'Purpose of a.'],
      ['b', 'failed', 'Summary of b.'],
      ['c', 'failed', 'Purpose of c.'],
    ]);
    expect(JSON.stringify(document)).not.toMatch(/secret_sql|boom|2026-10-01/);
  });
});

describe('charts', () => {
  it("draws a breakdown as sideways bars, each in its value's colour, with its table", () => {
    const run = single('bar', aggregate({ dimensions: ['category'] }), [['category', 'text'], ['spend', 'number']], [
      { category: 'Groceries', spend: 300 },
      { category: 'Dining', spend: 120 },
      { category: 'Travel', spend: 80 },
    ]);
    const chart = chartOf(run, 's');
    expect(chart).toMatchObject({
      type: 'bar',
      orientation: 'horizontal',
      stacked: false,
      x: { key: 'category', label: 'Category', format: { kind: 'text' } },
      value: { kind: 'money' },
      series: [{ key: 's0', label: 'Spend', color: DEFAULT_PALETTE[0] }],
    });
    expect(chart.points).toEqual([
      { x: 'Groceries', color: '#2f9e44', values: { s0: 300 } },
      { x: 'Dining', color: '#e8590c', values: { s0: 120 } },
      { x: 'Travel', values: { s0: 80 } },
    ]);
    expect(blockOf(run, 's')).toMatchObject({ kind: 'chart', table: { columns: [{ key: 'category' }, { key: 'spend' }] } });
  });

  it('draws time upright and in order, labelled by its grain', () => {
    const chart = chartOf(
      single('bar', aggregate({ grain: 'month' }), [['spent_on', 'date'], ['spend', 'number']], [
        { spent_on: '2026-10-01', spend: 5 },
        { spent_on: '2026-08-01', spend: 7 },
        { spent_on: '2026-09-01', spend: '6.50' },
      ]),
      's',
    );
    expect(chart).toMatchObject({
      type: 'bar',
      orientation: 'vertical',
      x: { key: 'spent_on', label: 'Month', format: { kind: 'date', grain: 'month' } },
    });
    expect(chart.points).toEqual([
      { x: '2026-08-01', values: { s0: 7 } },
      { x: '2026-09-01', values: { s0: 6.5 } },
      { x: '2026-10-01', values: { s0: 5 } },
    ]);
  });

  it("stacks a sum split by member, in the members' colours", () => {
    const chart = chartOf(
      single('bar', aggregate({ dimensions: ['member'], grain: 'month' }), [['member', 'text'], ['spent_on', 'date'], ['spend', 'number']], [
        { member: 'Ada', spent_on: '2026-09-01', spend: 10 },
        { member: 'Bob', spent_on: '2026-09-01', spend: 4 },
        { member: 'Ada', spent_on: '2026-10-01', spend: 6 },
      ]),
      's',
    );
    expect(chart).toMatchObject({ type: 'bar', orientation: 'vertical', stacked: true });
    expect(chart.series).toEqual([
      { key: 's0', label: 'Ada', color: '#ae3ec9' },
      { key: 's1', label: 'Bob', color: '#e8590c' },
    ]);
    expect(chart.points).toEqual([
      { x: '2026-09-01', values: { s0: 10, s1: 4 } },
      { x: '2026-10-01', values: { s0: 6, s1: null } },
    ]);
  });

  it('puts averages side by side rather than stacking them', () => {
    const chart = chartOf(
      single(
        'bar',
        aggregate({ metrics: ['average_expense'], dimensions: ['member'], grain: 'month' }),
        [['member', 'text'], ['spent_on', 'date'], ['average_expense', 'number']],
        [{ member: 'Ada', spent_on: '2026-09-01', average_expense: 10 }],
      ),
      's',
    );
    expect(chart.stacked).toBe(false);
  });

  it('splits a breakdown by its second dimension, in that dimension’s labels and colours', () => {
    const run = single('bar', aggregate({ dimensions: ['category', 'bucket'] }), [['category', 'text'], ['bucket', 'text'], ['spend', 'number']], [
      { category: 'Groceries', bucket: 'needs', spend: 3 },
      { category: 'Dining', bucket: 'wants', spend: 2 },
    ]);
    const chart = chartOf(run, 's');
    expect(chart).toMatchObject({ orientation: 'horizontal', stacked: true, x: { key: 'category' } });
    expect(chart.series).toEqual([
      { key: 's0', label: 'Needs', color: '#1971c2' },
      { key: 's1', label: 'Wants', color: '#f08c00' },
    ]);
    // Several series: the bars wear the series' colours, not their category's.
    expect(chart.points.every((point) => point.color === undefined)).toBe(true);
    expect(blockOf(run, 's')).toMatchObject({ table: { rows: [{ bucket: 'Needs' }, { bucket: 'Wants' }] } });
  });

  it('draws several metrics of one format side by side, and mixed formats as a table', () => {
    const columns: Array<[string, ColumnType]> = [['category', 'text'], ['spend', 'number'], ['average_expense', 'number']];
    const chart = chartOf(
      single('bar', aggregate({ metrics: ['spend', 'average_expense'], dimensions: ['category'] }), columns, [
        { category: 'Groceries', spend: 30, average_expense: 10 },
      ]),
      's',
    );
    expect(chart.stacked).toBe(false);
    expect(chart.series).toEqual([
      { key: 's0', label: 'Spend', color: DEFAULT_PALETTE[0] },
      { key: 's1', label: 'Average expense', color: DEFAULT_PALETTE[1] },
    ]);
    const mixed = single('bar', aggregate({ metrics: ['spend', 'expense_count'], dimensions: ['category'] }), [['category', 'text'], ['spend', 'number'], ['expense_count', 'integer']], [
      { category: 'Groceries', spend: 30, expense_count: 3 },
    ]);
    expect(blockOf(mixed, 's').kind).toBe('table');
  });

  it('draws a line per value over time', () => {
    const chart = chartOf(
      single('line', aggregate({ dimensions: ['category'], grain: 'month' }), [['category', 'text'], ['spent_on', 'date'], ['spend', 'number']], [
        { category: 'Dining', spent_on: '2026-10-01', spend: 2 },
        { category: 'Groceries', spent_on: '2026-09-01', spend: 3 },
      ]),
      's',
    );
    expect(chart).toMatchObject({ type: 'line', orientation: 'vertical', stacked: false });
    expect(chart.series.map((entry) => entry.color)).toEqual(['#e8590c', '#2f9e44']);
    expect(chart.points.map((point) => point.x)).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('cuts a pie into slices, each in a colour of its own', () => {
    const chart = chartOf(
      single('pie', aggregate({ dimensions: ['bucket'] }), [['bucket', 'text'], ['spend', 'number']], [
        { bucket: 'needs', spend: 300 },
        { bucket: 'wants', spend: 100 },
        { bucket: 'savings', spend: 50 },
      ]),
      's',
    );
    expect(chart.type).toBe('pie');
    expect(chart.points).toEqual([
      { x: 'needs', label: 'Needs', color: '#1971c2', values: { s0: 300 } },
      { x: 'wants', label: 'Wants', color: '#f08c00', values: { s0: 100 } },
      { x: 'savings', color: DEFAULT_PALETTE[2], values: { s0: 50 } },
    ]);
  });

  it("turns a pie that wouldn't read into bars", () => {
    const columns: Array<[string, ColumnType]> = [['category', 'text'], ['spend', 'number']];
    const many = Array.from({ length: 9 }, (_, index) => ({ category: `C${index}`, spend: index + 1 }));
    expect(chartOf(single('pie', aggregate({ dimensions: ['category'] }), columns, many), 's')).toMatchObject({
      type: 'bar',
      orientation: 'horizontal',
    });
    const negative = [{ category: 'Refunds', spend: -5 }, { category: 'Dining', spend: 10 }];
    const bars = chartOf(single('pie', aggregate({ dimensions: ['category'] }), columns, negative), 's');
    expect(bars.type).toBe('bar');
    // As bars, only values with a colour of their own keep one.
    expect(bars.points.map((point) => point.color)).toEqual([undefined, '#e8590c']);
  });

  it('gives up on a chart with too many bars or series, but keeps time as a line', () => {
    const categories = Array.from({ length: 41 }, (_, index) => ({ category: `C${index}`, spend: index }));
    expect(blockOf(single('bar', aggregate({ dimensions: ['category'] }), [['category', 'text'], ['spend', 'number']], categories), 's').kind).toBe('table');

    const daily = days(41).map((day, index) => ({ spent_on: day, spend: index }));
    expect(chartOf(single('bar', aggregate({ grain: 'day' }), [['spent_on', 'date'], ['spend', 'number']], daily), 's').type).toBe('line');

    const members = Array.from({ length: 11 }, (_, index) => ({ member: `M${index}`, spent_on: '2026-10-01', spend: 1 }));
    expect(
      blockOf(single('bar', aggregate({ dimensions: ['member'], grain: 'month' }), [['member', 'text'], ['spent_on', 'date'], ['spend', 'number']], members), 's').kind,
    ).toBe('table');
  });

  it('charts a section without a structured query from one name column and its numbers', () => {
    const chart = chartOf(single('bar', null, [['category', 'text'], ['spend', 'number']], [{ category: 'Groceries', spend: 3 }]), 's');
    expect(chart).toMatchObject({ orientation: 'horizontal', points: [{ x: 'Groceries', color: '#2f9e44' }] });
    const twoNames = single('bar', null, [['category', 'text'], ['member', 'text'], ['spend', 'number']], [{ category: 'Groceries', member: 'Ada', spend: 3 }]);
    expect(blockOf(twoNames, 's').kind).toBe('table');
  });

  it('takes only hex colours, from styles and palette alike', () => {
    const run = single('pie', aggregate({ dimensions: ['category'] }), [['category', 'text'], ['spend', 'number']], [
      { category: 'Groceries', spend: 2 },
      { category: 'Dining', spend: 1 },
    ]);
    const styles: ReportStyles = { category: { Groceries: { color: 'red;} body{display:none' }, Dining: { color: '#abc' } } };
    const chart = buildReport(run, vocabulary, { currency: 'EUR', styles, palette: ['url(x)', '#123456'] })!.sections[0]!.block;
    expect(chart).toMatchObject({ chart: { points: [{ color: '#123456' }, { color: '#abc' }] } });
  });

  it('never charts a listing, and uses the palette it is given', () => {
    const run = single('bar', listing(['category_label', 'amount']), [['category_label', 'text'], ['amount', 'number']], [{ category_label: 'Groceries', amount: 3 }]);
    expect(blockOf(run, 's').kind).toBe('table');

    const time = single('line', aggregate({ grain: 'month' }), [['spent_on', 'date'], ['spend', 'number']], [{ spent_on: '2026-10-01', spend: 1 }]);
    const document = buildReport(time, vocabulary, { currency: 'EUR', palette: ['#000000'] })!;
    expect(document.sections[0]!.block).toMatchObject({ chart: { series: [{ color: '#000000' }] } });
  });
});
