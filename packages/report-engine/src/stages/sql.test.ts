import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';

import type { QueryOutcome } from '../pg';
import type { AggregateQuery } from '../plan/query';
import { buildVocabulary } from '../plan/vocabulary';
import { createSqlGuard, DEFAULT_ALLOWED_FUNCTIONS } from '../sql-guard';
import { testModel } from '../testing/model';
import type { PlanSection, ReportPlan } from './plan';
import {
  checkOutcome,
  checkSql,
  describeQueryError,
  expectedColumns,
  renderRepairInput,
  renderSqlInput,
  repairRequest,
  sqlInstructions,
  sqlRequest,
  sqlSchema,
  type SectionSql,
} from './sql';

const model = testModel();
const vocabulary = buildVocabulary(model);
const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };

const query = (fields: Partial<AggregateQuery> = {}): AggregateQuery => ({
  shape: 'aggregate',
  relation: 'reporting.spendings',
  metrics: ['spend'],
  dimensions: ['category'],
  grain: null,
  filters: [],
  period: OCTOBER,
  sort: [{ by: 'spend', direction: 'desc' }],
  limit: null,
  ...fields,
});

const section = (id: string, fields: Partial<PlanSection> = {}): PlanSection => ({
  id,
  title: id,
  purpose: 'Shows it.',
  display: 'bar',
  query: query(),
  essential: true,
  ...fields,
});

const plan: ReportPlan = {
  title: 'October',
  summary: 'October spending.',
  sections: [section('by_category'), section('note', { display: 'text', query: null })],
  derived: [],
  crossChecks: [],
};

const BY_CATEGORY: SectionSql = {
  section: 'by_category',
  sql:
    'select category_label as category, sum(amount) as spend from reporting.spendings ' +
    'where spent_on >= $1::date and spent_on < $2::date group by category_label order by spend desc',
  params: ['2026-10-01', '2026-11-01'],
  summary: 'Spending per category in October.',
  columns: [
    { name: 'category', type: 'text' },
    { name: 'spend', type: 'number' },
  ],
};

const check = async (sql: Partial<SectionSql>, target: ReportPlan = plan) => {
  const result = await checkSql(new Map([['by_category', { ...BY_CATEGORY, ...sql }]]), target, vocabulary, guard);
  return result.problems.get('by_category') ?? [];
};

describe('the SQL prompt', () => {
  it('has one fixed schema for every plan', () => {
    const json = JSON.stringify(betaZodOutputFormat(sqlSchema()).schema);
    expect(json).not.toContain('by_category');
    expect(sqlSchema().safeParse({ sections: [BY_CATEGORY] }).success).toBe(true);
  });

  it('lists the allowed functions and asks for parameters and exact column names', () => {
    const text = sqlInstructions(DEFAULT_ALLOWED_FUNCTIONS);
    expect(text).toContain('date_trunc');
    expect(text).toContain('Never write such a value into the SQL text.');
    expect(text).toContain('each metric by its metric name');
  });

  it('fences the plan and names the sections that need SQL', () => {
    const text = renderSqlInput({ plan, today: '2026-11-16', timeZone: 'Europe/Berlin' }, 'e'.repeat(16));
    expect(text).toContain(`<untrusted-plan-${'e'.repeat(16)}>`);
    expect(text).toContain('Write a query for each of these sections: by_category.');
    expect(sqlRequest('PREFIX', ['sum'], { plan, today: '2026-11-16', timeZone: 'Europe/Berlin' })).toMatchObject({
      stage: 'sql',
      effort: 'high',
      cachePrefix: 'PREFIX',
    });
  });

  it('quotes the failed SQL, its problems and the view columns in a repair', () => {
    const input = {
      plan,
      today: '2026-11-16',
      timeZone: 'Europe/Berlin',
      model,
      failures: [{ section: plan.sections[0]!, previous: BY_CATEGORY, problems: ['undefined_column: column "categry" does not exist'] }],
    };
    const text = renderRepairInput(input, 'e'.repeat(16));
    expect(text).toContain('This is a repair.');
    expect(text).toContain(`<untrusted-failures-${'e'.repeat(16)}>\nSection by_category:\nPrevious SQL:\nselect category_label`);
    expect(text).toContain('- undefined_column: column "categry" does not exist');
    expect(text).toContain('Columns of reporting.spendings: id (uuid), spent_on (date)');
    expect(repairRequest('PREFIX', ['sum'], input).stage).toBe('sql_repair');
  });
});

describe('expectedColumns', () => {
  it('names dimensions, then the time dimension for a grain, then metrics', () => {
    expect(expectedColumns(query({ grain: 'month', metrics: ['spend', 'expense_count'] }), vocabulary)).toEqual([
      'category',
      'spent_on',
      'spend',
      'expense_count',
    ]);
    expect(
      expectedColumns(
        { shape: 'rows', relation: 'reporting.spendings', columns: ['spent_on', 'amount'], filters: [], period: null, sort: [], limit: 5 },
        vocabulary,
      ),
    ).toEqual(['spent_on', 'amount']);
  });
});

describe('checkSql', () => {
  it('passes SQL that the guard accepts and that matches the plan', async () => {
    const result = await checkSql(new Map([['by_category', BY_CATEGORY]]), plan, vocabulary, guard);
    expect(result.problems.size).toBe(0);
    expect(result.valid.get('by_category')?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reports a section with no SQL', async () => {
    const result = await checkSql(new Map(), plan, vocabulary, guard);
    expect(result.problems.get('by_category')).toEqual(['No SQL was written for this section.']);
    expect(result.problems.has('note')).toBe(false);
  });

  it("passes on the guard's findings", async () => {
    const problems = await check({ sql: 'select display_name from public.profiles' });
    expect(problems.join(' ')).toMatch(/public\.profiles/);
  });

  it('wants every parameter used, and plan values passed as parameters', async () => {
    expect(await check({ params: ['2026-10-01', '2026-11-01', 'extra'] })).toEqual([
      'params has 3 values, but the SQL uses $1 to $2.',
    ]);
    const inlined = BY_CATEGORY.sql.replace('$1::date', "'2026-10-01'::date").replace('$2', '$1');
    expect(await check({ sql: inlined, params: ['2026-11-01'] })).toEqual([
      "'2026-10-01' is written into the SQL; pass it as a $n parameter.",
    ]);
  });

  it('wants the output columns named and typed as the plan says', async () => {
    expect(await check({ columns: [{ name: 'category_label', type: 'text' }, { name: 'spend', type: 'number' }] })).toEqual([
      'The output columns must be exactly category, spend; missing category; not expected category_label.',
    ]);
    expect(await check({ columns: [{ name: 'category', type: 'text' }, { name: 'spend', type: 'text' }] })).toEqual([
      'spend should be number, not text.',
    ]);
    expect(
      await check({ columns: [{ name: 'category', type: 'text' }, { name: 'spend', type: 'number' }, { name: 'spend', type: 'number' }] }),
    ).toContain('Output columns are declared twice: spend.');
    expect(await check({ columns: [{ name: 'category', type: 'text' }, { name: 'spend', type: 'integer' }] })).toEqual([]);
  });

  it('checks only the guard and the parameters when a section has no structured query', async () => {
    const free = { ...plan, sections: [section('by_category', { display: 'table', query: null })] };
    expect(await check({ columns: [{ name: 'anything', type: 'text' }] }, free)).toEqual([]);
  });
});

describe('checkOutcome', () => {
  const ran = (columns: Extract<QueryOutcome, { ok: true }>['columns']): QueryOutcome => ({
    id: 'by_category',
    ok: true,
    columns,
    rows: [],
    truncated: false,
    cost: 1,
    fingerprint: 'f',
    durationMs: 1,
  });

  it('accepts the declared columns, with integer and number as one family', () => {
    expect(checkOutcome(BY_CATEGORY, ran([{ name: 'category', type: 'text' }, { name: 'spend', type: 'integer' }]))).toEqual([]);
  });

  it('reports other columns or types than declared', () => {
    expect(checkOutcome(BY_CATEGORY, ran([{ name: 'category', type: 'text' }]))).toEqual([
      'The query returned the columns category, but declared category, spend.',
    ]);
    expect(checkOutcome(BY_CATEGORY, ran([{ name: 'category', type: 'unknown' }, { name: 'spend', type: 'number' }]))).toEqual([
      'category came back as unknown, not text; cast it.',
    ]);
  });

  it('quotes errors with their hint and the guard issues', () => {
    const failed: QueryOutcome = {
      id: 'by_category',
      ok: false,
      error: { code: 'undefined_column', message: 'column "categry" does not exist', hint: 'Perhaps you meant "category_label".' },
      durationMs: 2,
    };
    expect(checkOutcome(BY_CATEGORY, failed)).toEqual([
      'undefined_column: column "categry" does not exist Perhaps you meant "category_label".',
    ]);
    expect(
      describeQueryError({ code: 'rejected', message: 'Rejected.', issues: [{ code: 'relation_not_allowed', message: 'Not allowed.', hint: 'Use reporting.spendings.' }] }),
    ).toEqual(['rejected: Rejected.', 'Not allowed. Use reporting.spendings.']);
  });
});
