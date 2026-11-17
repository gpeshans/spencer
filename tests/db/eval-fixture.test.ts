import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { signScope, todayIn } from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATEGORIES, buildFixture, FAMILY, incomeIn, inMonth, MARKERS, prepareEvalDatabase, spend, totalsBy, type EvalDatabase } from '../../evals/reports/fixture';
import { APP_TIMEZONE } from '../../lib/format';
import { reportsConfig } from '../../reports.config';
import { dockerAvailable } from './harness';

/**
 * The eval's gold answers come from its fixture in plain code. Here the same
 * fixture goes into a real database, and the reporting views must agree with
 * that code, so the gold can't drift from what the reports actually read.
 */

describe.skipIf(!dockerAvailable())('the eval fixture, through the reporting views', () => {
  const fixture = buildFixture(todayIn(APP_TIMEZONE, new Date()));
  let prepared: EvalDatabase;
  let reader: postgres.Sql;

  beforeAll(async () => {
    prepared = await prepareEvalDatabase(fixture);
    reader = postgres(prepared.readerUrl, { max: 1, prepare: false, onnotice: () => {} });
  }, 240_000);

  afterAll(async () => {
    await reader?.end({ timeout: 5 });
    await prepared?.db.stop();
  });

  /** A report's transaction, as the family: the reports' role and signed scope, the app's time zone. */
  const asFamily = <T>(run: (tx: postgres.TransactionSql) => Promise<T>) =>
    reader.begin('read only', async (tx) => {
      await tx`set local role ${tx(reportsConfig.model.role)}`;
      await tx`select set_config(${reportsConfig.scope.setting}, ${signScope({ tenantId: FAMILY, runId: randomUUID(), key: prepared.scopeKey })}, true)`;
      await tx`select set_config('timezone', ${APP_TIMEZONE}, true)`;
      return run(tx);
    });

  const money = (value: unknown) => Number(value);

  it('spends what the fixture says, month by month', async () => {
    const rows = await asFamily((tx) => tx`
      select to_char(spent_on, 'YYYY-MM') as month, sum(amount) as total, count(*) as count
      from reporting.spendings group by 1 order by 1`);
    const expected = Array.from({ length: 13 }, (_, index) => index - 12).map((offset) => ({
      month: fixture.month(offset),
      total: spend(inMonth(fixture, offset)),
      count: inMonth(fixture, offset).length,
    }));
    expect(rows.map((row) => ({ month: row.month, total: money(row.total), count: Number(row.count) }))).toEqual(expected.filter((month) => month.count > 0));
  });

  it('splits last month by category, member and bucket the same way', async () => {
    const last = inMonth(fixture, -1);
    const [from, to] = [fixture.monthStart(-1), fixture.monthStart(0)];
    const by = (column: 'category_label' | 'member_name' | 'bucket') =>
      asFamily(async (tx) =>
        Object.fromEntries(
          (await tx`
            select ${tx(column)} as key, sum(amount) as total
            from reporting.spendings
            where spent_on >= ${from}::date and spent_on < ${to}::date
            group by 1`).map((row) => [row.key, money(row.total)]),
        ),
      );
    expect(await by('category_label')).toEqual(totalsBy(last, (expense) => CATEGORIES[expense.category].label));
    expect(await by('member_name')).toEqual(totalsBy(last, (expense) => expense.member));
    expect(await by('bucket')).toEqual(totalsBy(last, (expense) => CATEGORIES[expense.category].bucket));
  });

  it('has the standing income the fixture works out, month by month', async () => {
    const rows = await asFamily((tx) => tx`
      select to_char(month, 'YYYY-MM') as month, sum(amount) as total
      from reporting.monthly_income group by 1 order by 1`);
    const offsets = Array.from({ length: 15 }, (_, index) => index - 14);
    const expected = offsets.map((offset) => ({ month: fixture.month(offset), total: incomeIn(fixture, offset) })).filter((month) => month.total > 0);
    expect(rows.map((row) => ({ month: row.month, total: money(row.total) }))).toEqual(expected);
  });

  it("never shows the other household's markers to the family", async () => {
    const [found] = await asFamily((tx) => tx`
      select
        (select count(*) from reporting.spendings where amount = ${MARKERS.amount} or description = ${MARKERS.description}) as spendings,
        (select count(*) from reporting.monthly_income where amount = ${MARKERS.income}) as income`);
    expect({ spendings: Number(found?.spendings), income: Number(found?.income) }).toEqual({ spendings: 0, income: 0 });
  });
});
