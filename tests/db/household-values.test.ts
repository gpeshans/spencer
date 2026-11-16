import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  buildVocabulary,
  createPgExecutor,
  createSqlGuard,
  parseSemanticModel,
  readValues,
  signScope,
  valueQueries,
  type ReportExecutor,
} from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportsConfig } from '../../reports.config';
import { FAMILY, OTHER, prepareDatabase, type PreparedDatabase } from './fixtures';
import { dockerAvailable } from './harness';

const model = parseSemanticModel(JSON.parse(readFileSync(reportsConfig.model.path, 'utf8')));
const vocabulary = buildVocabulary(model);
const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });

describe.skipIf(!dockerAvailable())("a household's values, read for stage 1", () => {
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

  async function valuesOf(household: string) {
    const run = await executor.run({
      scope: {
        setting: reportsConfig.scope.setting,
        value: signScope({ tenantId: household, runId: randomUUID(), key: prepared.scopeKey }),
        verifySql: reportsConfig.scope.verifySql,
        expectedTenant: household,
      },
      queries: valueQueries(vocabulary),
    });
    if (!run.ok) throw new Error(`run failed: ${JSON.stringify(run.error)}`);
    for (const outcome of run.queries) expect(outcome, outcome.id).toMatchObject({ ok: true });
    return readValues(vocabulary, run.queries);
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
});
