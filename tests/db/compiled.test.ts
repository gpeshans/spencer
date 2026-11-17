import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  buildVocabulary,
  compareResults,
  compileQuery,
  createPgExecutor,
  createSqlGuard,
  parseSemanticModel,
  signScope,
  todayIn,
  type AggregateQuery,
  type QueryOutcome,
  type RowsQuery,
  type StructuredQuery,
} from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildFixture, CATEGORIES, FAMILY, incomeIn, inMonth, largest, prepareEvalDatabase, spend, totalsBy, type EvalDatabase } from '../../evals/reports/fixture';
import { APP_TIMEZONE } from '../../lib/format';
import { reportsConfig } from '../../reports.config';
import { dockerAvailable } from './harness';

/**
 * The compiled SQL (M3) on a real database: each structured query compiles,
 * passes sql-guard, runs through the executor in the family's scope, and
 * returns what the eval fixture's plain-code answers say it should.
 */

const model = parseSemanticModel(JSON.parse(readFileSync(reportsConfig.model.path, 'utf8')));
const vocabulary = buildVocabulary(model);
const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });

describe.skipIf(!dockerAvailable())('compiled SQL on the eval fixture', () => {
  const fixture = buildFixture(todayIn(APP_TIMEZONE, new Date()));
  const last = { from: fixture.monthStart(-1), to: fixture.monthStart(0) };
  let prepared: EvalDatabase;
  let executor: ReturnType<typeof createPgExecutor>;

  beforeAll(async () => {
    prepared = await prepareEvalDatabase(fixture);
    executor = createPgExecutor({ url: prepared.readerUrl, role: reportsConfig.model.role, guard, timeZone: APP_TIMEZONE });
  }, 240_000);

  afterAll(async () => {
    await executor?.close();
    await prepared?.db.stop();
  });

  const run = async (queries: Array<{ id: string; sql: string; params: readonly unknown[] }>) => {
    const outcome = await executor.run({
      scope: {
        setting: reportsConfig.scope.setting,
        value: signScope({ tenantId: FAMILY, runId: randomUUID(), key: prepared.scopeKey }),
        verifySql: reportsConfig.scope.verifySql,
        expectedTenant: FAMILY,
      },
      queries: queries.map((query) => ({ id: query.id, sql: query.sql, params: [...query.params] as never })),
    });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.queries;
  };

  const compiled = async (query: StructuredQuery) => {
    const sql = compileQuery('q', query, vocabulary);
    const verdict = await guard.check(sql.sql, { paramCount: sql.params.length });
    expect(verdict.ok, sql.sql).toBe(true);
    const [outcome] = await run([{ id: 'q', ...sql }]);
    if (!outcome?.ok) throw new Error(`${sql.sql}: ${outcome && !outcome.ok ? outcome.error.message : 'no outcome'}`);
    return outcome;
  };

  const aggregate = (fields: Partial<AggregateQuery>): AggregateQuery => ({
    shape: 'aggregate',
    relation: 'reporting.spendings',
    metrics: ['spend'],
    dimensions: [],
    grain: null,
    filters: [],
    period: last,
    sort: [],
    limit: null,
    ...fields,
  });
  const money = (value: unknown) => Math.round(Number(value) * 100) / 100;

  it('totals, counts and averages a period', async () => {
    const outcome = await compiled(aggregate({ metrics: ['spend', 'expense_count', 'average_expense'] }));
    const expenses = inMonth(fixture, -1);
    const [row] = outcome.rows;
    expect(money(row!.spend)).toBe(spend(expenses));
    expect(Number(row!.expense_count)).toBe(expenses.length);
    expect(Number(row!.average_expense)).toBeCloseTo(spend(expenses) / expenses.length, 6);
  });

  it('breaks a period down by category, largest first', async () => {
    const outcome = await compiled(aggregate({ dimensions: ['category'], sort: [{ by: 'spend', direction: 'desc' }] }));
    const expected = Object.entries(totalsBy(inMonth(fixture, -1), (expense) => CATEGORIES[expense.category].label)).sort((a, b) => b[1] - a[1]);
    expect(outcome.rows.map((row) => [row.category, money(row.spend)])).toEqual(expected);
  });

  it('groups by month, ordered, across a range', async () => {
    const outcome = await compiled(aggregate({ grain: 'month', period: { from: fixture.monthStart(-6), to: fixture.monthStart(0) } }));
    const offsets = [-6, -5, -4, -3, -2, -1];
    expect(outcome.rows.map((row) => [row.spent_on, money(row.spend)])).toEqual(offsets.map((offset) => [fixture.monthStart(offset), spend(inMonth(fixture, offset))]));
  });

  it('filters dimensions in and out', async () => {
    const outcome = await compiled(
      aggregate({
        dimensions: ['member', 'category'],
        filters: [
          { dimension: 'category', op: 'in', values: ['Groceries', 'Dining'] },
          { dimension: 'member', op: 'not_in', values: ['Ben'] },
        ],
        sort: [{ by: 'category', direction: 'asc' }],
      }),
    );
    const alice = inMonth(fixture, -1, (expense) => expense.member === 'Alice');
    expect(outcome.rows.map((row) => [row.member, row.category, money(row.spend)])).toEqual([
      ['Alice', 'Dining', spend(alice.filter((expense) => expense.category === 'dining'))],
      ['Alice', 'Groceries', spend(alice.filter((expense) => expense.category === 'groceries'))],
    ]);
  });

  it('reads standing income month by month', async () => {
    const months = [-3, -2, -1];
    const outcome = await compiled(
      aggregate({ relation: 'reporting.monthly_income', metrics: ['monthly_income'], grain: 'month', period: { from: fixture.monthStart(-3), to: fixture.monthStart(0) } }),
    );
    expect(outcome.rows.map((row) => [row.income_month, money(row.monthly_income)])).toEqual(months.map((offset) => [fixture.monthStart(offset), incomeIn(fixture, offset)]));
  });

  it('lists rows with every kind of filter, sorted and cut', async () => {
    const listing: RowsQuery = {
      shape: 'rows',
      relation: 'reporting.spendings',
      columns: ['spent_on', 'description', 'amount'],
      filters: [
        { column: 'description', op: 'contains', values: ['MARKET'] },
        { column: 'amount', op: 'gt', values: [50] },
        { column: 'member_name', op: 'in', values: ['Alice', 'Ben'] },
      ],
      period: { from: fixture.monthStart(-12), to: fixture.monthStart(1) },
      sort: [{ by: 'amount', direction: 'desc' }],
      limit: 5,
    };
    const outcome = await compiled(listing);
    const expected = largest(fixture.expenses.filter((expense) => expense.description.toLowerCase().includes('market') && expense.amount > 50), 5);
    expect(outcome.rows.map((row) => [row.description, money(row.amount)])).toEqual(expected.map((expense) => [expense.description, expense.amount]));
  });

  it('agrees with hand-written SQL for the same question', async () => {
    const query = aggregate({ dimensions: ['category'], filters: [{ dimension: 'category', op: 'in', values: ['Groceries', 'Dining'] }] });
    const ours = compileQuery('food', query, vocabulary);
    const theirs = {
      id: 'llm',
      sql: 'select category_label as category, sum(amount) as spend from reporting.spendings where spent_on >= $1::date and spent_on < $2::date and category_label = any($3::text[]) group by category_label order by spend',
      params: [last.from, last.to, '{Groceries,Dining}'],
    };
    const [a, b] = (await run([theirs, { id: 'compiled', ...ours }])) as [QueryOutcome, QueryOutcome];
    if (!a.ok || !b.ok) throw new Error('a query failed');
    expect(compareResults(a, b)).toEqual({ verdict: 'match' });
    // The same question, the wrong month: the check catches it.
    const [wrong] = (await run([{ ...theirs, params: [fixture.monthStart(-2), fixture.monthStart(-1), '{Groceries,Dining}'] }])) as [QueryOutcome];
    if (!wrong.ok) throw new Error('the query failed');
    expect(compareResults(wrong, b).verdict).toBe('mismatch');
  });
});
