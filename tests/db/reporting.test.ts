import { randomBytes, randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { RUN_STATUSES, signScope } from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALICE, BOB, FAMILY, monthStart, OTHER, prepareDatabase } from './fixtures';
import { dockerAvailable, type TestDatabase } from './harness';

/** Thrown to roll a transaction back while handing a value out of it. */
class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('rollback');
  }
}

async function rolledBack(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
  throw new Error('expected the transaction to roll back');
}

describe.skipIf(!dockerAvailable())('migrations 0001-0008 on a local Postgres 17.6', () => {
  let db: TestDatabase;
  let reader: postgres.Sql;
  let applied: string[] = [];
  let scopeKey = '';

  beforeAll(async () => {
    const prepared = await prepareDatabase();
    ({ db, applied, scopeKey } = prepared);
    reader = postgres(prepared.readerUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
  }, 240_000);

  afterAll(async () => {
    await reader?.end({ timeout: 5 });
    await db?.stop();
  });

  const scopeFor = (
    tenantId: string,
    options: { key?: string; ttlSeconds?: number; now?: Date } = {},
  ) =>
    signScope({
      tenantId,
      runId: randomUUID(),
      key: options.key ?? scopeKey,
      ttlSeconds: options.ttlSeconds ?? 300,
      now: options.now,
    });

  /** One read-only report transaction, opened the way the executor will. */
  const asReader = <T>(scope: string | null, run: (tx: postgres.TransactionSql) => Promise<T>) =>
    reader.begin('read only', async (tx) => {
      await tx`set local role reports_reader`;
      if (scope !== null) await tx`select set_config('reports.scope', ${scope}, true)`;
      return run(tx);
    });

  /** A signed-in app user, the way the Data API runs their requests. */
  const asUser = <T>(userId: string, run: (tx: postgres.TransactionSql) => Promise<T>) =>
    db.admin.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
      await tx`set local role authenticated`;
      return run(tx);
    });

  it('applies every migration in order', () => {
    expect(applied).toContain('0007_tighten_table_grants.sql');
    expect(applied).toContain('0008_reporting.sql');
    expect(applied.at(-1)).toBe('0009_reporting_hardening.sql');
  });

  describe('the reporting login', () => {
    it('reads nothing until it becomes reports_reader', async () => {
      await expect(reader`select count(*) from reporting.spendings`).rejects.toThrow(/permission denied/);
    });

    it('applies its session defaults', async () => {
      const [settings] = await reader`
        select current_setting('default_transaction_read_only') as read_only,
               current_setting('statement_timeout') as statement_timeout,
               current_setting('idle_in_transaction_session_timeout') as idle_timeout`;
      expect(settings).toEqual({ read_only: 'on', statement_timeout: '5s', idle_timeout: '15s' });
    });

    it('cannot become any other role', async () => {
      for (const role of ['authenticated', 'service_role', 'postgres']) {
        await expect(
          reader.begin('read only', (tx) => tx.unsafe(`set local role ${role}`)),
          role,
        ).rejects.toThrow(/permission denied/);
      }
    });

    it('sees exactly one household under a valid signed scope', async () => {
      const family = await asReader(scopeFor(FAMILY), (tx) => tx`
        select reporting.scope_group_id() as scope, member_name, amount::float8 as amount
        from reporting.spendings
        order by amount`);
      expect(family.map((r) => [r.scope, r.member_name, r.amount])).toEqual([
        [FAMILY, 'Alice', 12.5],
        [FAMILY, 'Alice', 30],
      ]);

      const other = await asReader(scopeFor(OTHER), (tx) => tx`
        select member_name, category_label from reporting.spendings`);
      expect(other.map((r) => [r.member_name, r.category_label])).toEqual([['Bob', 'Groceries']]);
    });

    it('scopes every other view to the signed household too', async () => {
      const other = await asReader(scopeFor(OTHER), async (tx) => ({
        household: await tx`select name from reporting.household`,
        members: await tx`select member_name from reporting.members`,
        categories: await tx`select key from reporting.categories order by key`,
        targets: await tx`select count(*)::int as n from reporting.bucket_targets`,
      }));
      expect(other.household.map((r) => r.name)).toEqual(['Other household']);
      expect(other.members.map((r) => r.member_name)).toEqual(['Bob']);
      expect(other.categories.map((r) => r.key)).toEqual(['groceries', 'salary']);
      expect(other.targets[0]?.n).toBe(0);

      const family = await asReader(scopeFor(FAMILY), async (tx) => ({
        household: await tx`select name from reporting.household`,
        members: await tx`select member_name from reporting.members`,
        targets: await tx`select count(*)::int as n from reporting.bucket_targets`,
      }));
      expect(family.household.map((r) => r.name)).toEqual(['Family']);
      expect(family.members.map((r) => r.member_name)).toEqual(['Alice']);
      expect(family.targets[0]?.n).toBeGreaterThan(0);
    });

    it('sees every reporting view empty without a scope', async () => {
      const views = await db.admin`
        select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'reporting' and c.relkind = 'v'
        order by c.relname`;
      expect(views.length).toBeGreaterThan(0);
      for (const { relname } of views) {
        const [row] = await asReader(null, (tx) =>
          tx.unsafe(`select count(*)::int as n from reporting.${relname}`),
        );
        expect(row?.n, relname).toBe(0);
      }
    });

    it('sees nothing under a tampered, expired, foreign or missing scope', async () => {
      const valid = scopeFor(FAMILY);
      const lastDigit = valid.at(-1) === '0' ? '1' : '0';
      const scopes: Array<[string, string | null]> = [
        ['household swapped', valid.replace(FAMILY, OTHER)],
        ['signature altered', `${valid.slice(0, -1)}${lastDigit}`],
        ['expired', scopeFor(FAMILY, { now: new Date(Date.now() - 3_600_000), ttlSeconds: 60 })],
        ['other key', scopeFor(FAMILY, { key: randomBytes(32).toString('hex') })],
        ['garbage', 'not-a-scope'],
        ['missing', null],
      ];
      for (const [label, scope] of scopes) {
        const [row] = await asReader(scope, (tx) => tx`select count(*)::int as n from reporting.spendings`);
        expect(row?.n, label).toBe(0);
      }
    });

    it('ignores JWT claims, even forged ones', async () => {
      const rows = await asReader(scopeFor(FAMILY), async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: BOB, role: 'authenticated' })}, true)`;
        return tx`select distinct member_name from reporting.spendings`;
      });
      expect(rows.map((r) => r.member_name)).toEqual(['Alice']);
    });

    it('fails closed when the Vault key is missing', async () => {
      const scope = scopeFor(FAMILY);
      const count = await rolledBack(
        db.admin.begin(async (tx) => {
          await tx`delete from vault.secrets where name = 'reports_scope_key'`;
          await tx`set local role reports_reader`;
          await tx`select set_config('reports.scope', ${scope}, true)`;
          const [row] = await tx`select count(*)::int as n from reporting.spendings`;
          throw new Rollback(row?.n);
        }),
      );
      expect(count).toBe(0);
    });

    it('cannot read emails, auth, the vault or the run logs', async () => {
      const forbidden = [
        'select email from public.profiles',
        'select * from public.profiles',
        'select * from public.allowed_emails',
        'select * from auth.users',
        'select * from vault.decrypted_secrets',
        'select * from public.report_runs',
      ];
      for (const query of forbidden) {
        await expect(asReader(scopeFor(FAMILY), (tx) => tx.unsafe(query)), query).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it('cannot reach base tables by name while the public schema grants it nothing', async () => {
      await expect(
        asReader(scopeFor(OTHER), (tx) => tx`select display_name from public.profiles`),
      ).rejects.toThrow(/permission denied for schema public/);
    });

    it('stays inside its scope and granted columns where the public schema is open', async () => {
      // Postgres lets every role use the public schema by default, and Supabase
      // may keep that default. The grant happens inside a rolled-back
      // transaction, so other tests don't see it.
      const withOpenSchema = (run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
        rolledBack(
          db.admin.begin(async (tx) => {
            await tx`grant usage on schema public to reports_reader`;
            await tx`set local role reports_reader`;
            await tx`select set_config('reports.scope', ${scopeFor(OTHER)}, true)`;
            throw new Rollback(await run(tx));
          }),
        );

      const names = (await withOpenSchema((tx) => tx`select display_name from public.profiles`)) as Array<{
        display_name: string;
      }>;
      expect(names.map((r) => r.display_name)).toEqual(['Bob']);
      await expect(withOpenSchema((tx) => tx`select email from public.profiles`)).rejects.toThrow(
        /permission denied for table profiles/,
      );
    });

    it('cannot write, even in a read-write transaction', async () => {
      await expect(
        asReader(scopeFor(FAMILY), (tx) => tx`update public.spendings set amount = 1`),
      ).rejects.toThrow(/read-only transaction|permission denied/);
      await expect(
        reader.begin('read write', async (tx) => {
          await tx`set local role reports_reader`;
          return tx`delete from public.spendings`;
        }),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('the reporting views', () => {
    it('are all security_invoker', async () => {
      const views = await db.admin`
        select c.relname, coalesce(c.reloptions, '{}') as options
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'reporting' and c.relkind = 'v'
        order by c.relname`;
      expect(views.map((v) => v.relname)).toEqual([
        'bucket_targets',
        'categories',
        'household',
        'members',
        'monthly_income',
        'spendings',
      ]);
      for (const view of views) expect(view.options, view.relname).toContain('security_invoker=true');
    });

    it('read only tables that have row-level security on', async () => {
      const tables = await db.admin`
        select distinct t.relname, t.relrowsecurity
        from pg_rewrite r
        join pg_class v on v.oid = r.ev_class
        join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid
        join pg_class t on t.oid = d.refobjid
        where v.relnamespace = 'reporting'::regnamespace
          and t.relkind = 'r'
        order by t.relname`;
      expect(tables.map((t) => t.relname)).toEqual([
        'bucket_targets',
        'categories',
        'groups',
        'income',
        'profiles',
        'spendings',
      ]);
      for (const table of tables) expect(table.relrowsecurity, table.relname).toBe(true);
    });

    it('carry each income category forward until a newer entry replaces it', async () => {
      const rows = await asReader(scopeFor(FAMILY), (tx) => tx`
        select month::text as month, amount::float8 as amount
        from reporting.monthly_income
        where category_key = 'salary'
          and month between ${monthStart(-8)}::date and ${monthStart(-3)}::date
        order by month`);
      expect(rows.map((r) => [r.month, r.amount])).toEqual([
        [monthStart(-8), 1000],
        [monthStart(-7), 1000],
        [monthStart(-6), 1000],
        [monthStart(-5), 1200],
        [monthStart(-4), 1200],
        [monthStart(-3), 1200],
      ]);
    });

    it('start income at the household\'s first entry and stop at the current month', async () => {
      const [range] = await asReader(scopeFor(OTHER), (tx) => tx`
        select min(month)::text as first, max(month)::text as last, count(*)::int as months
        from reporting.monthly_income`);
      expect(range).toEqual({ first: monthStart(-6), last: monthStart(0), months: 7 });
    });
  });

  describe('app access after 0007', () => {
    it('lets a user rename themselves but not change household', async () => {
      await expect(
        asUser(ALICE, (tx) => tx`update public.profiles set group_id = ${OTHER} where id = ${ALICE}`),
      ).rejects.toThrow(/permission denied/);
      const renamed = await asUser(ALICE, (tx) => tx`
        update public.profiles set display_name = 'Alice' where id = ${ALICE} returning id`);
      expect(renamed).toHaveLength(1);
    });

    it('keeps the reporting schema away from app users', async () => {
      await expect(asUser(ALICE, (tx) => tx`select count(*) from reporting.spendings`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.admin.begin(async (tx) => {
          await tx`set local role anon`;
          return tx`select reporting.scope_group_id()`;
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('gives anon no table access', async () => {
      await expect(
        db.admin.begin(async (tx) => {
          await tx`set local role anon`;
          return tx`select count(*) from public.spendings`;
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('lets users read only their own report runs, and write none', async () => {
      await db.admin`
        insert into public.report_runs (owner_id, group_id, request)
        values (${ALICE}, ${FAMILY}, 'mine'), (${BOB}, ${OTHER}, 'not mine')`;
      const mine = await asUser(ALICE, (tx) => tx`select request from public.report_runs`);
      expect(mine.map((r) => r.request)).toEqual(['mine']);
      await expect(
        asUser(ALICE, (tx) => tx`
          insert into public.report_runs (owner_id, group_id, request)
          values (${ALICE}, ${FAMILY}, 'forged')`),
      ).rejects.toThrow(/permission denied/);
    });

    it('keeps report_runs.status in step with the engine', async () => {
      const [constraint] = await db.admin`
        select pg_get_constraintdef(oid) as def
        from pg_constraint
        where conrelid = 'public.report_runs'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%status%'`;
      const values = [...String(constraint?.def).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
      expect(values).toEqual([...RUN_STATUSES]);
    });
  });
});
