import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  buildVocabulary,
  cachePrefix,
  createPgExecutor,
  createSqlGuard,
  executeRun,
  newRun,
  parseSemanticModel,
  signScope,
  type GenerateRequest,
  type GenerateResult,
  type LlmProvider,
  type PlanSection,
  type ReportExecutor,
  type RunState,
  type SectionSql,
} from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportsConfig } from '../../reports.config';
import { FAMILY, monthStart, prepareDatabase, type PreparedDatabase } from './fixtures';
import { dockerAvailable } from './harness';

const model = parseSemanticModel(JSON.parse(readFileSync(reportsConfig.model.path, 'utf8')));
const vocabulary = buildVocabulary(model);
const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });
const period = { from: monthStart(-1), to: monthStart(1) };
const WHERE = 'where spent_on >= $1::date and spent_on < $2::date';

const sections: PlanSection[] = [
  {
    id: 'total',
    title: 'Total',
    purpose: 'Total spending.',
    display: 'figure',
    query: { shape: 'aggregate', relation: 'reporting.spendings', metrics: ['spend'], dimensions: [], grain: null, filters: [], period, sort: [], limit: null },
    essential: true,
  },
  {
    id: 'by_month',
    title: 'By month',
    purpose: 'Spending and count per month.',
    display: 'line',
    query: {
      shape: 'aggregate',
      relation: 'reporting.spendings',
      metrics: ['spend', 'expense_count'],
      dimensions: [],
      grain: 'month',
      filters: [],
      period,
      sort: [{ by: 'spent_on', direction: 'asc' }],
      limit: null,
    },
    essential: true,
  },
];

const totalSql: SectionSql = {
  section: 'total',
  sql: `select sum(amount) as spend from reporting.spendings ${WHERE}`,
  params: [period.from, period.to],
  summary: 'Total spending.',
  columns: [{ name: 'spend', type: 'number' }],
};
const byMonthSql = (column: string): SectionSql => ({
  section: 'by_month',
  sql:
    `select date_trunc('month', ${column})::date as spent_on, sum(amount) as spend, count(*)::int as expense_count ` +
    `from reporting.spendings ${WHERE} group by 1 order by 1`,
  params: [period.from, period.to],
  summary: 'Spending per month.',
  columns: [
    { name: 'spent_on', type: 'date' },
    { name: 'spend', type: 'number' },
    { name: 'expense_count', type: 'integer' },
  ],
});

/** Answers the SQL stage from a script, and the narrative with one cited figure; the prompts are kept for inspection. */
function scripted(answers: SectionSql[][]) {
  const inputs: string[] = [];
  const llm: LlmProvider = {
    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      inputs.push(request.input);
      const answer = request.stage === 'narrative' ? { headline: 'You spent {v1}.', insights: [] } : { sections: answers.shift() ?? [] };
      const output = request.schema.parse(answer);
      return { ok: true, output, calls: [] };
    },
  };
  return { llm, inputs };
}

describe.skipIf(!dockerAvailable())('stages 4-6 on a local Postgres 17.6', () => {
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

  async function execute(answers: SectionSql[][]) {
    const { llm, inputs } = scripted(answers);
    const runId = randomUUID();
    const ready: RunState = {
      ...newRun(runId, 'Spending this month and last'),
      status: 'executing',
      plan: { title: 'Spending', summary: 'Spending.', sections, derived: [], crossChecks: [] },
    };
    const state = await executeRun(ready, {
      model,
      vocabulary,
      cachePrefix: cachePrefix(model, vocabulary),
      llm,
      guard,
      query: (queries) =>
        executor.run({
          scope: {
            setting: reportsConfig.scope.setting,
            value: signScope({ tenantId: FAMILY, runId, key: prepared.scopeKey }),
            verifySql: reportsConfig.scope.verifySql,
            expectedTenant: FAMILY,
          },
          queries,
        }),
      timeZone: 'Europe/Berlin',
      now: () => new Date(),
      save: async () => {},
    });
    return { state, inputs };
  }

  it("runs each section's SQL in the household's scope, with typed results, and the compiled SQL agrees", async () => {
    const { state } = await execute([[totalSql, byMonthSql('spent_on')]]);

    expect(state.status).toBe('succeeded');
    expect(state.results!.map((result) => [result.section, result.source, result.check])).toEqual([
      ['total', 'llm', 'match'],
      ['by_month', 'llm', 'match'],
    ]);
    expect(state.narrative?.headline).toEqual(['You spent ', { value: 42.5, format: { kind: 'money' } }, '.']);
    const [total, byMonth] = state.results!;
    expect(total).toMatchObject({ status: 'ok', rows: [{ spend: 42.5 }], columns: [{ name: 'spend', type: 'number' }] });
    expect(byMonth).toMatchObject({
      status: 'ok',
      rows: [
        { spent_on: monthStart(-1), spend: 12.5, expense_count: 1 },
        { spent_on: monthStart(0), spend: 30, expense_count: 1 },
      ],
    });
  });

  it('repairs a query that Postgres rejects, quoting its error', async () => {
    const { state, inputs } = await execute([[totalSql, byMonthSql('spent_at')], [byMonthSql('spent_on')]]);

    expect(state.status).toBe('succeeded');
    expect(state.results!.find((result) => result.section === 'by_month')).toMatchObject({ status: 'ok', attempts: 2 });
    expect(inputs[1]).toContain('undefined_column');
    expect(inputs[1]).toContain('spent_at');
  });
});
