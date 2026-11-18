import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALICE, BOB, FAMILY, prepareDatabase, type PreparedDatabase } from './fixtures';
import { dockerAvailable } from './harness';

/**
 * Migration 0010: removing someone from public.allowed_emails ends their access
 * to every household row at once, even for a session that is already open, and
 * adding them back restores it. Before 0010 the allow-list only gated sign-up.
 */

const ALICE_EMAIL = 'alice@example.test';

/** Thrown to roll a scenario back once its result is captured. */
class Rollback extends Error {}

type Tx = postgres.TransactionSql;
type Attempt = { ok: true; rows: number } | { ok: false; code: string };

describe.skipIf(!dockerAvailable())('migration 0010: the allow-list gates all data access', () => {
  let prepared: PreparedDatabase;

  beforeAll(async () => {
    prepared = await prepareDatabase();
    const sql = prepared.db.admin;
    // One of everything the report tables' policies cover, owned by Alice.
    const [run] = await sql`
      insert into public.report_runs (owner_id, group_id, request)
      values (${ALICE}, ${FAMILY}, 'How much did we spend?') returning id`;
    await sql`insert into public.report_queries (run_id, section_id, source, sql) values (${run!.id}, 'total', 'llm', 'select 1')`;
    await sql`
      insert into public.report_llm_calls (run_id, owner_id, stage, model_requested)
      values (${run!.id}, ${ALICE}, 'plan', 'claude-opus-5-5')`;
    await sql`
      insert into public.report_events (actor_id, group_id, run_id, action)
      values (${ALICE}, ${FAMILY}, ${run!.id}, 'create')`;
    await sql`
      insert into public.report_templates (owner_id, group_id, title, request, plan, plan_hash, queries)
      values (${ALICE}, ${FAMILY}, 'Monthly', 'How much did we spend?', '{}'::jsonb, 'h', '[]'::jsonb)`;
  }, 240_000);

  afterAll(async () => {
    await prepared?.db.stop();
  });

  /**
   * One rolled-back transaction: `setup` runs as the platform (say, to drop an
   * allow-list entry), then `run` runs as `userId`, the way the Data API runs a
   * signed-in request.
   */
  async function scenario<T>(userId: string, run: (tx: Tx) => Promise<T>, setup?: (tx: Tx) => Promise<unknown>): Promise<T> {
    let result: T | undefined;
    await prepared.db.admin
      .begin(async (tx) => {
        await setup?.(tx);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
        await tx`set local role authenticated`;
        result = await run(tx);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    return result as T;
  }

  const removeAlice = (tx: Tx) => tx`delete from public.allowed_emails where lower(email) = ${ALICE_EMAIL}`;

  /** A statement in its own savepoint, so a refusal doesn't abort the scenario. */
  const attempt = (tx: Tx, statement: string): Promise<Attempt> =>
    tx
      .savepoint((sp) => sp.unsafe(statement))
      .then(
        (rows) => ({ ok: true as const, rows: rows.length }),
        (error: { code?: string }) => ({ ok: false as const, code: error.code ?? 'unknown' }),
      );

  /** Rows the user can see in every table a household member reads. */
  const visible = async (tx: Tx) => {
    const [counts] = await tx`
      select
        (select count(*) from public.spendings)::int as spendings,
        (select count(*) from public.income)::int as income,
        (select count(*) from public.categories)::int as categories,
        (select count(*) from public.bucket_targets)::int as bucket_targets,
        (select count(*) from public.groups)::int as groups,
        (select count(*) from public.profiles)::int as profiles,
        (select count(*) from public.report_runs)::int as report_runs,
        (select count(*) from public.report_queries)::int as report_queries,
        (select count(*) from public.report_llm_calls)::int as report_llm_calls,
        (select count(*) from public.report_events)::int as report_events,
        (select count(*) from public.report_templates)::int as report_templates`;
    return counts as Record<string, number>;
  };

  it('lets an allow-listed member read and write as before', async () => {
    const { counts, insert, rename } = await scenario(ALICE, async (tx) => ({
      counts: await visible(tx),
      insert: await attempt(tx, `insert into public.spendings (amount, category, description) values (1, 'groceries', 'x') returning id`),
      rename: await attempt(tx, `update public.profiles set display_name = 'Alice B.' where id = '${ALICE}' returning id`),
    }));
    for (const [table, rows] of Object.entries(counts)) expect(rows, table).toBeGreaterThan(0);
    expect(insert).toEqual({ ok: true, rows: 1 });
    expect(rename).toEqual({ ok: true, rows: 1 });
  });

  it('cuts a removed member off from every table, with the session they already hold', async () => {
    const counts = await scenario(ALICE, visible, removeAlice);
    expect(counts).toEqual(Object.fromEntries(Object.keys(counts).map((table) => [table, 0])));
  });

  it('refuses a removed member every write', async () => {
    const results = await scenario(
      ALICE,
      async (tx) => ({
        insertSpending: await attempt(tx, `insert into public.spendings (amount, category, description) values (1, 'groceries', 'x') returning id`),
        insertIncome: await attempt(tx, `insert into public.income (category, amount, effective_from) values ('salary', 1, '2001-01-01') returning id`),
        insertCategory: await attempt(tx, `insert into public.categories (kind, key, label, bucket) values ('expense', 'k', 'K', 'wants') returning id`),
        updateSpendings: await attempt(tx, 'update public.spendings set amount = 0.01 returning id'),
        deleteSpendings: await attempt(tx, 'delete from public.spendings returning id'),
        deleteIncome: await attempt(tx, 'delete from public.income returning id'),
        rename: await attempt(tx, `update public.profiles set display_name = 'Mallory' where id = '${ALICE}' returning id`),
      }),
      removeAlice,
    );
    expect(results).toEqual({
      insertSpending: { ok: false, code: '42501' },
      insertIncome: { ok: false, code: '42501' },
      insertCategory: { ok: false, code: '42501' },
      updateSpendings: { ok: true, rows: 0 },
      deleteSpendings: { ok: true, rows: 0 },
      deleteIncome: { ok: true, rows: 0 },
      rename: { ok: true, rows: 0 },
    });
  });

  it('leaves everyone else alone', async () => {
    const counts = await scenario(BOB, visible, removeAlice);
    expect(counts.spendings).toBeGreaterThan(0);
    expect(counts.income).toBeGreaterThan(0);
  });

  it('restores access when the address is added back, in any letter case', async () => {
    const counts = await scenario(ALICE, visible, async (tx) => {
      await removeAlice(tx);
      await tx`insert into public.allowed_emails (email) values ('ALICE@Example.Test')`;
    });
    for (const [table, rows] of Object.entries(counts)) expect(rows, table).toBeGreaterThan(0);
  });

  it('bounds what a member can write to their own profile', async () => {
    const results = await scenario(ALICE, async (tx) => ({
      longName: await attempt(tx, `update public.profiles set display_name = repeat('x', 300) where id = '${ALICE}' returning id`),
      httpAvatar: await attempt(tx, `update public.profiles set avatar_url = 'http://example.test/a.png' where id = '${ALICE}' returning id`),
      hugeAvatar: await attempt(tx, `update public.profiles set avatar_url = 'https://' || repeat('a', 3000) where id = '${ALICE}' returning id`),
      googleAvatar: await attempt(
        tx,
        `update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/a/ACg8ocK-example=s96-c' where id = '${ALICE}' returning id`,
      ),
    }));
    expect(results).toEqual({
      longName: { ok: false, code: '23514' },
      httpAvatar: { ok: false, code: '23514' },
      hugeAvatar: { ok: false, code: '23514' },
      googleAvatar: { ok: true, rows: 1 },
    });
  });

  it('still creates a profile from Google-style sign-up metadata', async () => {
    let profile: Record<string, unknown> | undefined;
    await prepared.db.admin
      .begin(async (tx) => {
        await tx`insert into public.allowed_emails (email) values ('carol@example.test')`;
        const [user] = await tx`
          insert into auth.users (id, email, raw_user_meta_data)
          values (gen_random_uuid(), 'carol@example.test', ${tx.json({
            full_name: 'Carol Example',
            avatar_url: 'https://lh3.googleusercontent.com/a/ACg8ocL-example=s96-c',
            email_verified: true,
          })})
          returning id`;
        [profile] = await tx`select display_name, avatar_url, group_id from public.profiles where id = ${user!.id}`;
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    expect(profile).toEqual({
      display_name: 'Carol Example',
      avatar_url: 'https://lh3.googleusercontent.com/a/ACg8ocL-example=s96-c',
      group_id: FAMILY,
    });
  });
});
