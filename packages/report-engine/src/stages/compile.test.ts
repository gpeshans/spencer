import { describe, expect, it } from 'vitest';

import type { AggregateQuery, RowsQuery, StructuredQuery } from '../plan/query';
import { buildVocabulary } from '../plan/vocabulary';
import { createSqlGuard } from '../sql-guard';
import { testModel } from '../testing/model';
import { compileQuery, describeQuery } from './compile';
import type { PlanSection, ReportPlan } from './plan';
import { checkSql } from './sql';

const model = testModel();
const vocabulary = buildVocabulary(model);
const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };

const aggregate = (fields: Partial<AggregateQuery> = {}): AggregateQuery => ({
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

const rows = (fields: Partial<RowsQuery> = {}): RowsQuery => ({
  shape: 'rows',
  relation: 'reporting.spendings',
  columns: ['spent_on', 'description', 'amount'],
  filters: [],
  period: OCTOBER,
  sort: [{ by: 'amount', direction: 'desc' }],
  limit: 5,
  ...fields,
});

const section = (id: string, query: StructuredQuery): PlanSection => ({
  id,
  title: id,
  purpose: 'Shows it.',
  display: query.shape === 'rows' ? 'table' : query.dimensions.length > 0 || query.grain ? 'bar' : 'figure',
  query,
  essential: true,
});

describe('compileQuery', () => {
  it('compiles a total over a period', () => {
    expect(compileQuery('total', aggregate(), vocabulary)).toEqual({
      section: 'total',
      sql: 'select sum(amount) as "spend" from "reporting"."spendings" where "spent_on" >= $1::date and "spent_on" < $2::date',
      params: ['2026-10-01', '2026-11-01'],
      summary: 'Spend, from 2026-10-01 to 2026-10-31.',
      columns: [{ name: 'spend', type: 'number' }],
    });
  });

  it('compiles a breakdown by dimensions and a grain, with filters, sort and limit', () => {
    const query = aggregate({
      metrics: ['spend', 'expense_count'],
      dimensions: ['category', 'member'],
      grain: 'month',
      filters: [
        { dimension: 'category', op: 'in', values: ['Groceries', 'Dining'] },
        { dimension: 'member', op: 'not_in', values: ['Ben'] },
      ],
      sort: [{ by: 'spend', direction: 'desc' }],
      limit: 10,
    });
    expect(compileQuery('by_category', query, vocabulary)).toEqual({
      section: 'by_category',
      sql:
        'select "category_label" as "category", "member_name" as "member", ' +
        `date_trunc('month', "spent_on")::date as "spent_on", sum(amount) as "spend", count(*) as "expense_count" ` +
        'from "reporting"."spendings" where "spent_on" >= $1::date and "spent_on" < $2::date ' +
        'and "category_label" in ($3::text, $4::text) and "member_name" not in ($5::text) ' +
        'group by 1, 2, 3 order by "spend" desc limit 10',
      params: ['2026-10-01', '2026-11-01', 'Groceries', 'Dining', 'Ben'],
      summary: 'Spend, expense count by category, member per month, from 2026-10-01 to 2026-10-31, where category is Groceries or Dining and member is not Ben, sorted by spend (highest first), at most 10 rows.',
      columns: [
        { name: 'category', type: 'text' },
        { name: 'member', type: 'text' },
        { name: 'spent_on', type: 'date' },
        { name: 'spend', type: 'number' },
        { name: 'expense_count', type: 'number' },
      ],
    });
  });

  it('orders groups by default, and uses the time dimension of the view', () => {
    const income = aggregate({ relation: 'reporting.monthly_income', metrics: ['monthly_income'], grain: 'month', period: null });
    expect(compileQuery('income', income, vocabulary).sql).toBe(
      `select date_trunc('month', "month")::date as "income_month", sum(amount) as "monthly_income" from "reporting"."monthly_income" group by 1 order by 1`,
    );
  });

  it('compiles a listing with every filter operator', () => {
    const query = rows({
      filters: [
        { column: 'description', op: 'contains', values: ['market'] },
        { column: 'amount', op: 'gt', values: [20] },
        { column: 'amount', op: 'lte', values: [500] },
        { column: 'member_name', op: 'eq', values: ['Alice'] },
        { column: 'category_label', op: 'in', values: ['Groceries'] },
      ],
    });
    expect(compileQuery('largest', query, vocabulary)).toMatchObject({
      sql:
        'select "spent_on", "description", "amount" from "reporting"."spendings" ' +
        'where "spent_on" >= $1::date and "spent_on" < $2::date and strpos(lower("description"), lower($3::text)) > 0 ' +
        'and "amount" > $4::numeric and "amount" <= $5::numeric and "member_name" = $6::text and "category_label" in ($7::text) ' +
        'order by "amount" desc limit 5',
      params: ['2026-10-01', '2026-11-01', 'market', 20, 500, 'Alice', 'Groceries'],
      columns: [
        { name: 'spent_on', type: 'date' },
        { name: 'description', type: 'text' },
        { name: 'amount', type: 'number' },
      ],
    });
  });

  it('types filter values as their column holds them', () => {
    const listing = rows({ relation: 'reporting.categories', columns: ['label', 'sort'], period: null, sort: [], filters: [
      { column: 'active', op: 'eq', values: ['true'] },
      { column: 'sort', op: 'gte', values: ['2'] },
    ] });
    expect(compileQuery('categories', listing, vocabulary)).toMatchObject({
      sql: 'select "label", "sort" from "reporting"."categories" where "active" = $1::boolean and "sort" >= $2::numeric limit 5',
      params: [true, 2],
    });
  });

  it('throws on a name the model lacks: the plan was checked, so that is a bug', () => {
    expect(() => compileQuery('x', aggregate({ metrics: ['nope'] }), vocabulary)).toThrow('unknown metric nope');
    expect(() => compileQuery('x', aggregate({ relation: 'reporting.nope' }), vocabulary)).toThrow('unknown view');
  });

  it('passes the same checks as the SQL the LLM writes', async () => {
    const queries: Array<[string, StructuredQuery]> = [
      ['total', aggregate()],
      ['by_category', aggregate({ dimensions: ['category'], sort: [{ by: 'spend', direction: 'desc' }], limit: 3 })],
      ['by_month', aggregate({ metrics: ['spend', 'expense_count'], grain: 'month', filters: [{ dimension: 'bucket', op: 'not_in', values: ['needs'] }] })],
      ['income', aggregate({ relation: 'reporting.monthly_income', metrics: ['monthly_income'], dimensions: ['income_category'], grain: 'month' })],
      ['largest', rows({ filters: [{ column: 'description', op: 'contains', values: ["O'Brien's"] }] })],
    ];
    const plan: ReportPlan = {
      title: 'T',
      summary: 'S',
      sections: queries.map(([id, query]) => section(id, query)),
      derived: [],
      crossChecks: [],
    };
    const compiled = new Map(queries.map(([id, query]) => [id, compileQuery(id, query, vocabulary)]));
    const checked = await checkSql(compiled, plan, vocabulary, guard);
    expect(Object.fromEntries(checked.problems)).toEqual({});
    expect([...checked.valid.keys()]).toEqual(queries.map(([id]) => id));
  });
});

describe('describeQuery', () => {
  it('says what a listing returns', () => {
    expect(describeQuery(rows())).toBe('Spent on, description, amount of each row, from 2026-10-01 to 2026-10-31, sorted by amount (highest first), at most 5 rows.');
  });
});
