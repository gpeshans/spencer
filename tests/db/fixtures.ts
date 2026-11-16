import { randomBytes, randomUUID } from 'node:crypto';

import postgres from 'postgres';

import {
  applyMigrations,
  applySupabaseStub,
  assertHex,
  startDatabase,
  type TestDatabase,
} from './harness';

/** The household seeded by migration 0001. */
export const FAMILY = '00000000-0000-0000-0000-000000000001';
/** A second household, plus one member of each. Fresh ids for every test file. */
export const OTHER = randomUUID();
export const ALICE = randomUUID();
export const BOB = randomUUID();

/** First day of the month `offset` months from now, as YYYY-MM-DD (UTC). */
export function monthStart(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    .toISOString()
    .slice(0, 10);
}

export interface PreparedDatabase {
  db: TestDatabase;
  /** Migration files applied, in order. */
  applied: string[];
  /** Connection URL for the reporting login. */
  readerUrl: string;
  /** The key stored in Vault as reports_scope_key. */
  scopeKey: string;
}

/**
 * A throwaway Postgres 17.6 with Supabase's platform stubbed, every migration
 * applied, two seeded households, a reporting-login password and a Vault key.
 */
export async function prepareDatabase(): Promise<PreparedDatabase> {
  const db = await startDatabase();
  try {
    const postgresPassword = randomBytes(16).toString('hex');
    await applySupabaseStub(db, postgresPassword);
    const applied = await applyMigrations(db, postgresPassword);
    await seed(db.admin);

    const readerPassword = randomBytes(16).toString('hex');
    assertHex(readerPassword);
    await db.admin.unsafe(`alter role reports_login password '${readerPassword}'`);
    const scopeKey = randomBytes(32).toString('hex');
    await db.admin`select vault.create_secret(${scopeKey}, 'reports_scope_key')`;

    return { db, applied, readerUrl: db.url('reports_login', readerPassword), scopeKey };
  } catch (error) {
    await db.stop();
    throw error;
  }
}

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
