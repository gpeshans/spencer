import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  checkCurated,
  checkFreshness,
  createPgExecutor,
  createSqlGuard,
  introspect,
  parseSemanticModel,
  signScope,
  type Introspection,
  type ReportExecutor,
  type SemanticModel,
} from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportsConfig } from '../../reports.config';
import { FAMILY, prepareDatabase, type PreparedDatabase } from './fixtures';
import { dockerAvailable } from './harness';

const committed: SemanticModel = parseSemanticModel(
  JSON.parse(readFileSync(path.resolve(reportsConfig.model.path), 'utf8')),
);

describe.skipIf(!dockerAvailable())('the semantic model on a local Postgres 17.6', () => {
  let prepared: PreparedDatabase;
  let introspection: Introspection;
  let executor: ReportExecutor;

  beforeAll(async () => {
    prepared = await prepareDatabase();
    introspection = await introspect(prepared.db.admin, reportsConfig.model);
    executor = createPgExecutor({
      url: prepared.readerUrl,
      role: reportsConfig.model.role,
      guard: createSqlGuard({ relations: committed.relations.map((relation) => relation.name) }),
    });
  }, 240_000);

  afterAll(async () => {
    await executor?.close();
    await prepared?.db.stop();
  });

  it('sees the six reporting views, each one commented, with nothing that reads past RLS', () => {
    expect(introspection.relations.map((relation) => [relation.name, relation.kind])).toEqual([
      ['reporting.bucket_targets', 'view'],
      ['reporting.categories', 'view'],
      ['reporting.household', 'view'],
      ['reporting.members', 'view'],
      ['reporting.monthly_income', 'view'],
      ['reporting.spendings', 'view'],
    ]);
    for (const relation of introspection.relations) {
      expect(relation.description, relation.name).toBeTruthy();
      for (const column of relation.columns) expect(column.description, `${relation.name}.${column.name}`).toBeTruthy();
    }
    expect(introspection.warnings).toEqual([]);
  });

  it('matches the committed model, so the migrations and the model file agree', async () => {
    const freshness = checkFreshness(committed, introspection);
    expect(freshness.fresh, 'run npm run reports:model').toBe(true);
    expect(await checkCurated(committed)).toEqual([]);
  });

  it('runs every example and metric of the committed model for a household', async () => {
    const queries = [
      ...committed.examples.map((example, index) => ({ id: `example ${index + 1}`, sql: example.sql, params: example.params })),
      ...committed.metrics.map((metric) => ({
        id: `metric ${metric.name}`,
        sql: `select ${metric.expression} as value from ${metric.relation}`,
      })),
    ];
    const run = await executor.run({
      scope: {
        ...reportsConfig.scope,
        value: signScope({ tenantId: FAMILY, runId: randomUUID(), key: prepared.scopeKey }),
        expectedTenant: FAMILY,
      },
      queries,
    });
    expect(run.ok).toBe(true);
    for (const outcome of run.queries) {
      expect(outcome.ok, `${outcome.id}: ${outcome.ok ? '' : JSON.stringify(outcome.error)}`).toBe(true);
    }
    expect(run.queries).toHaveLength(queries.length);
  });

  it('flags every kind of object that would read past RLS', async () => {
    const admin = prepared.db.admin;
    await admin.unsafe(`
      create view reporting.leaky as select amount from public.spendings;
      create table reporting.raw (x int);
      create materialized view reporting.snapshot as select 1 as n;
      create table public.unprotected (x int);
      create view reporting.through with (security_invoker = true) as select x from public.unprotected;
      create view public.owner_rights as select amount from public.spendings;
      create view reporting.nested with (security_invoker = true) as select amount from public.owner_rights;
      create function reporting.elevated() returns int language sql security definer as 'select 1';
      grant select (x) on public.unprotected to reports_reader;
      create view reporting.columns_only with (security_invoker = true) as select x from public.unprotected;
      revoke all on reporting.columns_only from reports_reader;
      grant select (x) on reporting.columns_only to reports_reader;
      grant select on reporting.leaky, reporting.raw, reporting.snapshot, reporting.through, reporting.nested
        to reports_reader;
    `);
    try {
      const flagged = await introspect(admin, reportsConfig.model);
      // Granted only column by column, and still found.
      expect(flagged.relations.map((relation) => relation.name)).toContain('reporting.columns_only');
      expect(flagged.warnings).toEqual([
        "reporting.leaky is a view without security_invoker: it reads with its owner's rights, past RLS.",
        'reporting.raw has row-level security off.',
        'reporting.snapshot is a materialized view: it has no row-level security.',
        'reporting.columns_only reads public.unprotected, which has row-level security off.',
        "reporting.nested reads public.owner_rights, a view that runs with its owner's rights, past RLS.",
        'reporting.through reads public.unprotected, which has row-level security off.',
        "reporting.elevated is SECURITY DEFINER: it runs with its owner's rights.",
      ]);
    } finally {
      await admin.unsafe(`
        drop view reporting.leaky, reporting.through, reporting.nested, reporting.columns_only;
        drop table reporting.raw;
        drop materialized view reporting.snapshot;
        drop view public.owner_rights;
        drop table public.unprotected;
        drop function reporting.elevated();
      `);
    }
  });
});
