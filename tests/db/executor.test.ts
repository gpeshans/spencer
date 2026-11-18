import { randomBytes, randomUUID } from 'node:crypto';

import {
  createPgExecutor,
  createSqlGuard,
  DEFAULT_ALLOWED_FUNCTIONS,
  signScope,
  type ExecutorLimits,
  type QueryOutcome,
  type ReportExecutor,
  type ReportScope,
} from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALICE, FAMILY, monthStart, OTHER, prepareDatabase, type PreparedDatabase } from './fixtures';
import { dockerAvailable } from './harness';

const RELATIONS = [
  'reporting.spendings',
  'reporting.monthly_income',
  'reporting.categories',
  'reporting.members',
  'reporting.household',
  'reporting.bucket_targets',
];
const guard = createSqlGuard({ relations: RELATIONS });

describe.skipIf(!dockerAvailable())('the report executor on a local Postgres 17.6', () => {
  let prepared: PreparedDatabase;
  let executor: ReportExecutor;
  const extra: ReportExecutor[] = [];

  beforeAll(async () => {
    prepared = await prepareDatabase();
    executor = createPgExecutor({ url: prepared.readerUrl, role: 'reports_reader', guard });
  }, 240_000);

  afterAll(async () => {
    await Promise.all([executor, ...extra].map((e) => e?.close()));
    await prepared?.db.stop();
  });

  /** An executor with its own limits (or guard), closed after the suite. */
  const executorWith = (limits: Partial<ExecutorLimits>, customGuard = guard) => {
    const e = createPgExecutor({ url: prepared.readerUrl, role: 'reports_reader', guard: customGuard, limits });
    extra.push(e);
    return e;
  };

  const scopeFor = (tenant: string, signedFor = tenant, key = prepared.scopeKey): ReportScope => ({
    setting: 'reports.scope',
    value: signScope({ tenantId: signedFor, runId: randomUUID(), key }),
    verifySql: 'select reporting.scope_group_id()::text as tenant_id',
    expectedTenant: tenant,
  });

  const one = async (sql: string, params: (string | number)[] = [], e = executor): Promise<QueryOutcome> => {
    const run = await e.run({ scope: scopeFor(FAMILY), queries: [{ id: 'q', sql, params }] });
    if (!run.ok) throw new Error(`run failed: ${JSON.stringify(run.error)}`);
    return run.queries[0]!;
  };

  it('runs approved queries for one household, with typed columns and values', async () => {
    const outcome = await one('select spent_on, amount, member_name from reporting.spendings order by amount');
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));

    expect(outcome.columns).toEqual([
      { name: 'spent_on', type: 'date' },
      { name: 'amount', type: 'number' },
      { name: 'member_name', type: 'text' },
    ]);
    expect(outcome.rows).toEqual([
      { spent_on: monthStart(-1), amount: 12.5, member_name: 'Alice' },
      { spent_on: monthStart(0), amount: 30, member_name: 'Alice' },
    ]);
    expect(outcome.truncated).toBe(false);
    expect(outcome.cost).toBeGreaterThan(0);
    expect(outcome.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('binds parameters', async () => {
    const outcome = await one('select count(*)::int as n from reporting.spendings where spent_on >= $1::date', [
      monthStart(0),
    ]);
    expect(outcome.ok && outcome.rows).toEqual([{ n: 1 }]);
  });

  it('returns timestamps as server text in the session time zone', async () => {
    const outcome = await one('select created_at from reporting.spendings limit 1');
    expect(outcome.ok && outcome.columns[0]?.type).toBe('timestamp');
    expect(outcome.ok && String(outcome.rows[0]?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.*\+00$/);
  });

  it('refuses SQL the guard rejects, without running it', async () => {
    const outcome = await one('select pg_sleep(5)');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('rejected');
    expect(outcome.error.issues?.map((issue) => issue.code)).toContain('function_not_allowed');
    expect(outcome.durationMs).toBeLessThan(1_000);
  });

  it('caps rows at the protocol level and keeps the query’s own order', async () => {
    const outcome = await one(
      'select n from generate_series(1, 50) as g(n) order by n desc',
      [],
      executorWith({ maxRows: 10 }),
    );
    expect(outcome.ok && outcome.rows.map((row) => row.n)).toEqual([50, 49, 48, 47, 46, 45, 44, 43, 42, 41]);
    expect(outcome.ok && outcome.truncated).toBe('rows');
  });

  it('caps the bytes returned', async () => {
    const filler = 'x'.repeat(60);
    const outcome = await one(
      `select n, '${filler}' as filler from generate_series(1, 20) as g(n) order by n`,
      [],
      executorWith({ maxBytes: 200 }),
    );
    expect(outcome.ok && outcome.rows.length).toBe(2);
    expect(outcome.ok && outcome.truncated).toBe('bytes');
  });

  it('stops expensive queries before they run', async () => {
    const outcome = await one(
      'select count(*) from generate_series(1, 100000000) as g(n)',
      [],
      executorWith({ maxCost: 1_000 }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('too_expensive');
    expect(outcome.durationMs).toBeLessThan(2_000);
  });

  it('times a slow query out and carries on with the next one', async () => {
    const run = await executorWith({ statementTimeoutMs: 300, maxCost: Number.POSITIVE_INFINITY }).run({
      scope: scopeFor(FAMILY),
      queries: [
        { id: 'slow', sql: 'select count(*) from generate_series(1, 400000000) as g(n)' },
        { id: 'next', sql: 'select 1 as one' },
      ],
    });
    expect(run.ok).toBe(true);
    const [slow, next] = run.queries;
    expect(slow?.ok === false && slow.error.code).toBe('timeout');
    expect(next?.ok && next.rows).toEqual([{ one: 1 }]);
  });

  it('never passes row data on in error messages', async () => {
    const outcome = await one('select description::int from reporting.spendings');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ code: 'invalid_value', sqlstate: '22P02' });
    for (const value of ['Coffee', 'Train', 'Bread']) expect(outcome.error.message).not.toContain(value);
  });

  it('keeps identifier hints for repairs, positioned in the SQL as written', async () => {
    const outcome = await one('select amout from reporting.spendings');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ code: 'undefined_column', position: 7 });
    expect(outcome.error.hint).toContain('spendings.amount');
  });

  it('refuses results with repeated column names, which would lose values', async () => {
    const outcome = await one('select 1 as a, 2 as a');
    expect(outcome.ok === false && outcome.error).toMatchObject({ code: 'invalid_query' });
  });

  it('reports a failed connection with its SQLSTATE and nothing else', async () => {
    const wrong = createPgExecutor({ url: prepared.db.url('reports_login', 'wrong-password'), role: 'reports_reader', guard });
    extra.push(wrong);
    const run = await wrong.run({ scope: scopeFor(FAMILY), queries: [{ id: 'q', sql: 'select 1 as one' }] });
    expect(run).toEqual({
      ok: false,
      error: { code: 'connection', message: 'Could not run the report on the database.', sqlstate: '28P01' },
      queries: [],
      durationMs: expect.any(Number),
    });
  });

  it('shows every query in a run the same snapshot', async () => {
    let inserted: string | undefined;
    const run = await executor.run({
      scope: scopeFor(FAMILY),
      queries: [
        { id: 'before', sql: 'select count(*)::int as n from reporting.spendings' },
        { id: 'after', sql: 'select count(*)::int as n from reporting.spendings' },
      ],
      onQuery: async (outcome) => {
        if (outcome.id !== 'before') return;
        const [row] = await prepared.db.admin`
          insert into public.spendings (group_id, user_id, description, amount, category, spent_on)
          values (${FAMILY}, ${ALICE}, 'Inserted mid-run', 1, 'groceries', current_date)
          returning id`;
        inserted = row?.id;
      },
    });
    try {
      const [before, after] = run.queries;
      expect(before?.ok && after?.ok && [before.rows, after.rows]).toEqual([[{ n: 2 }], [{ n: 2 }]]);
    } finally {
      if (inserted) await prepared.db.admin`delete from public.spendings where id = ${inserted}`;
    }
  });

  it('aborts when the scope does not resolve to the expected tenant', async () => {
    const queries = [{ id: 'q', sql: 'select count(*) from reporting.spendings' }];
    for (const scope of [
      scopeFor(FAMILY, OTHER), // signed for another household
      scopeFor(FAMILY, FAMILY, randomBytes(32).toString('hex')), // signed with another key
    ]) {
      const run = await executor.run({ scope, queries });
      expect(run).toMatchObject({ ok: false, error: { code: 'scope_mismatch' }, queries: [] });
    }
  });

  it('stops the run and discards every result when a query changes the session', async () => {
    const leaky = createSqlGuard({ relations: RELATIONS, functions: [...DEFAULT_ALLOWED_FUNCTIONS, 'set_config'] });
    const e = executorWith({}, leaky);
    for (const tamper of [
      "select set_config('search_path', 'public', true)",
      "select set_config('reports.scope', 'x', true)",
      "select set_config('statement_timeout', '0', true)",
    ]) {
      const run = await e.run({
        scope: scopeFor(FAMILY),
        queries: [
          { id: 'fine', sql: 'select 1 as one' },
          { id: 'tamper', sql: tamper },
        ],
      });
      expect(run, tamper).toMatchObject({ ok: false, error: { code: 'tripwire' }, queries: [] });
    }
  });

  it('reaches only side-effect-free catalog functions through the row-column form', async () => {
    // `alias.fn` (a ColumnRef) calls fn(row) when there is no such column; the
    // guard can't tell it from a column name, so it can only reach functions
    // that take the relation's row type. None of those in pg_catalog is volatile.
    const outcome = await one('select s.to_json from reporting.spendings s limit 1');
    expect(outcome.ok).toBe(true);
    const volatile = await prepared.db.admin`
      select p.proname
      from pg_proc p
      where p.pronamespace = 'pg_catalog'::regnamespace
        and p.pronargs = 1
        and p.provolatile = 'v'
        and p.proargtypes[0] in ('record'::regtype, 'anyelement'::regtype, 'anycompatible'::regtype,
                                 '"any"'::regtype, 'anynonarray'::regtype, 'anycompatiblenonarray'::regtype)`;
    expect(volatile.map((row) => row.proname)).toEqual([]);
  });

  it('rejects (expr).fn attribute notation before running it', async () => {
    // (expr).fn passes an arbitrary scalar to any 1-arg function, reaching past
    // the function allow-list (e.g. pg_sleep, current_setting). The guard now
    // rejects the field-selection form, so none of these ever runs.
    for (const sql of [
      'select (2).pg_sleep',
      "select ('reports.scope').current_setting",
      "select ('postgres').pg_database_size",
      'select (s).* from reporting.spendings s',
    ]) {
      const outcome = await one(sql);
      expect(outcome, sql).toMatchObject({ ok: false, error: { code: 'rejected' } });
    }
  });
});
