import { randomBytes, randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { RUN_STATUSES, signScope } from 'report-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyMigrations,
  applySupabaseStub,
  assertHex,
  dockerAvailable,
  startDatabase,
  type TestDatabase,
} from './harness';

/** The household seeded by migration 0001. */
const FAMILY = '00000000-0000-0000-0000-000000000001';
const OTHER = randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();

/** First day of the month `offset` months from now, as YYYY-MM-DD (UTC). */
function monthStart(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    .toISOString()
    .slice(0, 10);
}

describe.skipIf(!dockerAvailable())('migrations 0001-0008 on a local Postgres 17.6', () => {
  let db: TestDatabase;
  let reader: postgres.Sql;
  let applied: string[] = [];
  const scopeKey = randomBytes(32).toString('hex');
  const readerPassword = randomBytes(16).toString('hex');

  beforeAll(async () => {
    db = await startDatabase();
    const postgresPassword = randomBytes(16).toString('hex');
    await applySupabaseStub(db, postgresPassword);
    applied = await applyMigrations(db, postgresPassword);
    await seed(db.admin);

    assertHex(readerPassword);
    await db.admin.unsafe(`alter role reports_login password '${readerPassword}'`);
    await db.admin`select vault.create_secret(${scopeKey}, 'reports_scope_key')`;
    reader = postgres(db.url('reports_login', readerPassword), {
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
    expect(applied.at(-1)).toBe('0008_reporting.sql');
  });

  describe('the reporting login', () => {
    it('reads nothing until it becomes reports_reader', async () => {
      await expect(reader`select count(*) from reporting.spendings`).rejects.toThrow(/permission denied/);
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

    it('reads base tables only inside its scope and its granted columns', async () => {
      const rows = await asReader(scopeFor(OTHER), (tx) => tx`select display_name from public.profiles`);
      expect(rows.map((r) => r.display_name)).toEqual(['Bob']);
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

/** Two households with one member each, a few spendings and effective-dated income. */
async function seed(sql: postgres.Sql): Promise<void> {
  await sql`insert into public.allowed_emails (email) values ('alice@example.test'), ('bob@example.test')`;
  await sql`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${ALICE}, 'alice@example.test', ${sql.json({ full_name: 'Alice' })})`;
  await sql`insert into public.groups (id, name) values (${OTHER}, 'Other household')`;
  await sql`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${BOB}, 'bob@example.test', ${sql.json({ full_name: 'Bob' })})`;
  // Sign-up puts everyone in the oldest household; move Bob to the second one.
  await sql`update public.profiles set group_id = ${OTHER} where id = ${BOB}`;

  await sql`
    insert into public.categories (group_id, kind, key, label, bucket)
    values (${OTHER}, 'expense', 'groceries', 'Groceries', 'needs'),
           (${OTHER}, 'income', 'salary', 'Salary', null)`;
  const [familyCategory] = await sql`
    select key from public.categories
    where group_id = ${FAMILY} and kind = 'expense'
    order by sort
    limit 1`;

  await sql`
    insert into public.spendings (group_id, user_id, description, amount, category, spent_on)
    values (${FAMILY}, ${ALICE}, 'Coffee beans', 12.50, ${familyCategory?.key}, ${monthStart(-1)}::date),
           (${FAMILY}, ${ALICE}, 'Train ticket', 30.00, ${familyCategory?.key}, ${monthStart(0)}::date),
           (${OTHER}, ${BOB}, 'Bread', 7.25, 'groceries', ${monthStart(0)}::date)`;

  await sql`
    insert into public.income (group_id, category, amount, effective_from)
    values (${FAMILY}, 'salary', 1000, ${monthStart(-8)}::date),
           (${FAMILY}, 'salary', 1200, ${monthStart(-5)}::date),
           (${OTHER}, 'salary', 500, ${monthStart(-6)}::date)`;
}
