import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  buildVocabulary,
  createPgExecutor,
  createSqlGuard,
  feasibilityQueries,
  judgeFeasibility,
  parseSemanticModel,
  readValues,
  signScope,
  valueQueries,
  type Intent,
  type ReportExecutor,
  type ReportQuery,
} from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportsConfig } from '../../reports.config';
import { FAMILY, monthStart, OTHER, prepareDatabase, type PreparedDatabase } from './fixtures';
import { dockerAvailable } from './harness';

const model = parseSemanticModel(JSON.parse(readFileSync(reportsConfig.model.path, 'utf8')));
const vocabulary = buildVocabulary(model);
const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });

describe.skipIf(!dockerAvailable())('the code-built probes of stages 1 and 2', () => {
  let prepared: PreparedDatabase;
  let executor: ReportExecutor;

  beforeAll(async () => {
    prepared = await prepareDatabase();
    executor = createPgExecutor({ url: prepared.readerUrl, role: reportsConfig.model.role, guard });
  }, 240_000);

  afterAll(async () => {
    await executor?.close();
    await prepared?.db.stop();
  });

  async function probe(household: string, queries: readonly ReportQuery[]) {
    const run = await executor.run({
      scope: {
        setting: reportsConfig.scope.setting,
        value: signScope({ tenantId: household, runId: randomUUID(), key: prepared.scopeKey }),
        verifySql: reportsConfig.scope.verifySql,
        expectedTenant: household,
      },
      queries,
    });
    if (!run.ok) throw new Error(`run failed: ${JSON.stringify(run.error)}`);
    for (const outcome of run.queries) expect(outcome, outcome.id).toMatchObject({ ok: true });
    return run.queries;
  }

  const valuesOf = async (household: string) =>
    readValues(vocabulary, await probe(household, valueQueries(vocabulary)));

  const intent = (period: Intent['period']): Intent => ({
    kind: 'comparison',
    restated: 'Spending against income.',
    metrics: ['spend', 'monthly_income'],
    dimensions: [],
    grain: 'month',
    filters: [],
    period,
    comparison: null,
    assumptions: [],
    ambiguities: [],
    confidence: 'high',
    refusal: null,
  });

  async function feasibilityOf(household: string, period: Intent['period']) {
    const outcomes = await probe(household, feasibilityQueries(intent(period), vocabulary));
    return judgeFeasibility(intent(period), vocabulary, outcomes, { modelFresh: true });
  }

  it('lists only the values of the household in scope', async () => {
    const [spent] = await prepared.db.admin`
      select distinct c.label, c.bucket
      from public.spendings s
      join public.categories c on c.group_id = s.group_id and c.kind = 'expense' and c.key = s.category
      where s.group_id = ${FAMILY}`;
    const [income] = await prepared.db.admin`
      select label from public.categories where group_id = ${FAMILY} and kind = 'income' and key = 'salary'`;

    expect(await valuesOf(FAMILY)).toEqual({
      category: [spent!.label],
      bucket: [spent!.bucket],
      member: ['Alice'],
      income_category: [income!.label],
    });
    expect(await valuesOf(OTHER)).toEqual({
      category: ['Groceries'],
      bucket: ['needs'],
      member: ['Bob'],
      income_category: ['Salary'],
    });
  });

  it('measures coverage in the period for the household in scope', async () => {
    const recent = await feasibilityOf(FAMILY, { from: monthStart(-1), to: monthStart(1) });
    expect(recent.status).toBe('ok');
    expect(recent.coverage).toEqual([
      { relation: 'reporting.monthly_income', first: monthStart(-8), last: monthStart(0), rows: 2, comparisonRows: null },
      { relation: 'reporting.spendings', first: monthStart(-1), last: monthStart(0), rows: 2, comparisonRows: null },
    ]);

    // Bob's household has one expense, this month.
    const other = await feasibilityOf(OTHER, { from: monthStart(-1), to: monthStart(1) });
    expect(other.coverage.find((entry) => entry.relation === 'reporting.spendings')).toMatchObject({ rows: 1 });

    const before = await feasibilityOf(FAMILY, { from: monthStart(-12), to: monthStart(-11) });
    expect(before).toMatchObject({ status: 'no' });
    expect(before.alternatives).toContain(
      `Ask about ${monthStart(-1)} to ${monthStart(0)}, where reporting.spendings has data.`,
    );
  });
});
