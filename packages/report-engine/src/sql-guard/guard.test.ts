import { describe, expect, it } from 'vitest';

import { createSqlGuard, type SqlGuardIssueCode } from './guard';

const RELATIONS = [
  'reporting.spendings',
  'reporting.monthly_income',
  'reporting.categories',
  'reporting.members',
  'reporting.household',
  'reporting.bucket_targets',
];

const guard = createSqlGuard({ relations: RELATIONS });

async function issueCodes(sql: string, paramCount?: number): Promise<SqlGuardIssueCode[]> {
  const result = await guard.check(sql, { paramCount });
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

async function accept(sql: string, paramCount?: number) {
  const result = await guard.check(sql, { paramCount });
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result.issues)}`);
  return result;
}

describe('sql-guard accepts report queries', () => {
  it.each([
    [
      'an aggregate with parameters',
      `select category_label, sum(amount) as total
       from reporting.spendings
       where spent_on >= $1 and spent_on < $2
       group by category_label
       order by total desc`,
      2,
    ],
    [
      'a CTE with a window function',
      `with monthly as (
         select date_trunc('month', spent_on) as month, sum(amount) as total
         from reporting.spendings
         group by 1
       )
       select month, total, lag(total) over (order by month) as previous
       from monthly
       order by month`,
      0,
    ],
    [
      'a join between views',
      `select s.member_name, count(*) from reporting.spendings s
       join reporting.members m on m.member_id = s.member_id
       group by s.member_name`,
      0,
    ],
    [
      'a calendar from generate_series with a LEFT JOIN',
      `select g.month::date as month, coalesce(sum(s.amount), 0) as total
       from generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') as g(month)
       left join reporting.spendings s on date_trunc('month', s.spent_on) = g.month
       group by 1
       order by 1`,
      2,
    ],
    [
      'UNION ALL with ORDER BY and LIMIT',
      `select 'spend' as kind, sum(amount) as total from reporting.spendings
       union all
       select 'income', sum(amount) from reporting.monthly_income
       order by 2 desc
       limit 5`,
      0,
    ],
    [
      'CASE, COALESCE, NULLIF, GREATEST and casts',
      `select case when amount > 100 then 'large' else 'small' end as size,
              coalesce(description, ''), nullif(bucket, 'wants'), greatest(amount, 0)::numeric(12, 2),
              round(amount::float8 / 3, 2), id::text
       from reporting.spendings`,
      0,
    ],
    [
      'EXTRACT, AT TIME ZONE, intervals and CURRENT_DATE',
      `select extract(month from spent_on) as month,
              created_at at time zone 'UTC' as created_utc,
              current_date - interval '30 days' as since
       from reporting.spendings
       where spent_on > current_date - 30`,
      0,
    ],
    [
      'FILTER, WITHIN GROUP, DISTINCT and string_agg with ORDER BY',
      `select count(distinct member_id),
              sum(amount) filter (where bucket = 'needs') as needs,
              percentile_cont(0.5) within group (order by amount) as median,
              string_agg(distinct category_label, ', ' order by category_label) as categories
       from reporting.spendings`,
      0,
    ],
    [
      'LIKE, ILIKE, IN, BETWEEN and IS DISTINCT FROM',
      `select * from reporting.spendings
       where description ilike '%coffee%'
         and category_key like 'g%'
         and bucket in ('needs', 'wants')
         and amount between 1 and 50
         and member_name is distinct from 'Bob'`,
      0,
    ],
    [
      'EXISTS and scalar subqueries',
      `select c.label,
              (select sum(s.amount) from reporting.spendings s where s.category_key = c.key) as total
       from reporting.categories c
       where exists (select 1 from reporting.spendings s where s.category_key = c.key)`,
      0,
    ],
    [
      'a LATERAL subquery without a join condition',
      `select c.label, top.amount
       from reporting.categories c
       cross join lateral (
         select s.amount from reporting.spendings s
         where s.category_key = c.key
         order by s.amount desc
         limit 1
       ) as top`,
      0,
    ],
    ['a VALUES list', `select * from (values (1, 'a'), (2, 'b')) as v(n, label)`, 0],
    ['comments and a trailing semicolon', `-- monthly total\nselect /* all of it */ sum(amount) from reporting.spendings;`, 0],
    ['a pg_catalog-qualified function', `select pg_catalog.lower(category_label) from reporting.spendings`, 0],
    ['a CTE named like a view', `with spendings as (select 1 as n) select n from spendings`, 0],
    ['ORDER BY ... USING an allowed operator', `select amount from reporting.spendings order by amount using >`, 0],
    ['= ANY (subquery)', `select 1 where 1 = any (select 1)`, 0],
  ])('accepts %s', async (_label, sql, paramCount) => {
    await accept(sql, paramCount);
  });

  it('returns the SQL unchanged, with what it reads and calls', async () => {
    const sql = `select m.member_name, sum(s.amount) from reporting.spendings s
                 join reporting.members m on m.member_id = s.member_id
                 where s.spent_on >= $1 group by 1`;
    const result = await accept(sql, 1);

    expect(result.sql).toBe(sql);
    expect(result.relations).toEqual(['reporting.members', 'reporting.spendings']);
    expect(result.functions).toEqual(['sum']);
    expect(result.maxParam).toBe(1);
  });

  it('fingerprints structure, not layout or literal values', async () => {
    const a = await accept(`select sum(amount) from reporting.spendings where amount > 10`);
    const b = await accept(`-- note\nSELECT   sum(amount)\nFROM reporting.spendings WHERE amount > 99`);
    const c = await accept(`select max(amount) from reporting.spendings where amount > 10`);

    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });
});

describe('sql-guard rejects', () => {
  it.each<[string, string, SqlGuardIssueCode]>([
    // More than one statement, or not a SELECT
    ['stacked statements', 'select 1; select 2', 'multiple_statements'],
    ['a stacked transaction escape', 'select 1; commit; drop schema public cascade', 'multiple_statements'],
    ['DELETE', 'delete from reporting.spendings', 'not_a_select'],
    ['UPDATE', 'update reporting.spendings set amount = 0', 'not_a_select'],
    ['INSERT', 'insert into reporting.spendings default values', 'not_a_select'],
    ['COPY TO PROGRAM', "copy (select 1) to program 'id'", 'not_a_select'],
    ['SET ROLE', 'set role postgres', 'not_a_select'],
    ['SET statement_timeout', 'set statement_timeout = 0', 'not_a_select'],
    ['BEGIN', 'begin', 'not_a_select'],
    ['COMMIT', 'commit', 'not_a_select'],
    ['a DO block', 'do $$ begin perform pg_sleep(1); end $$', 'not_a_select'],
    ['EXPLAIN ANALYZE', 'explain analyze delete from reporting.spendings', 'not_a_select'],
    ['PREPARE', 'prepare p as select 1', 'not_a_select'],
    ['NOTIFY', "notify reports, 'x'", 'not_a_select'],
    // Writes hidden inside a SELECT
    ['a DELETE inside a CTE', 'with d as (delete from reporting.spendings returning *) select * from d', 'data_modifying_cte'],
    ['an UPDATE inside a CTE', 'with u as (update reporting.spendings set amount = 0 returning *) select 1', 'data_modifying_cte'],
    ['SELECT INTO', 'select * into stolen from reporting.spendings', 'select_into'],
    ['FOR UPDATE', 'select * from reporting.spendings for update', 'locking_clause'],
    ['FOR SHARE SKIP LOCKED', 'select * from reporting.spendings for share skip locked', 'locking_clause'],
    // Functions with side effects, or outside the allow-list
    ['pg_sleep', 'select pg_sleep(10)', 'function_not_allowed'],
    ['pg_catalog.pg_sleep', 'select pg_catalog.pg_sleep(10)', 'function_not_allowed'],
    ['a quoted function name', 'select "PG_SLEEP"(1)', 'function_not_allowed'],
    ['set_config (forging the scope)', "select set_config('reports.scope', 'x', true)", 'function_not_allowed'],
    ['current_setting', "select current_setting('reports.scope')", 'function_not_allowed'],
    ['pg_terminate_backend', 'select pg_terminate_backend(pg_backend_pid())', 'function_not_allowed'],
    ['pg_advisory_lock', 'select pg_advisory_lock(1)', 'function_not_allowed'],
    ['lo_import', "select lo_import('/etc/passwd')", 'function_not_allowed'],
    ['pg_read_file', "select pg_read_file('/etc/passwd')", 'function_not_allowed'],
    ['pg_read_file used as a table (CVE-2026-85620)', "select * from pg_read_file('/etc/passwd')", 'function_not_allowed'],
    ['pg_ls_dir used as a table', "select * from pg_ls_dir('.')", 'function_not_allowed'],
    ['query_to_xml', "select query_to_xml('select * from auth.users', true, true, '')", 'function_not_allowed'],
    ['dblink', "select dblink('host=example.com', 'select 1')", 'function_not_allowed'],
    ['nextval', "select nextval('s')", 'function_not_allowed'],
    ['a function in another schema', "select public.lower('x')", 'function_not_allowed'],
    ['the scope function itself', 'select reporting.scope_group_id()', 'function_not_allowed'],
    ['an unbounded allocation', "select lpad('x', 1000000000)", 'function_not_allowed'],
    // Relations outside the reporting views
    ['auth.users', 'select * from auth.users', 'relation_not_allowed'],
    ['public.profiles', 'select * from public.profiles', 'relation_not_allowed'],
    ['the vault', 'select * from vault.decrypted_secrets', 'relation_not_allowed'],
    ['pg_catalog.pg_authid', 'select * from pg_catalog.pg_authid', 'relation_not_allowed'],
    ['information_schema', 'select * from information_schema.tables', 'relation_not_allowed'],
    ['another database', 'select * from other.reporting.spendings', 'relation_not_allowed'],
    ['a quoted relation name', 'select * from "Reporting"."Spendings"', 'relation_not_allowed'],
    ['an unqualified catalog table', 'select * from pg_class', 'unqualified_relation'],
    ['an unqualified view name', 'select * from spendings', 'unqualified_relation'],
    [
      'a CTE name used outside its scope',
      `select c.relname
       from (with pg_class as (select 1 as n) select n from pg_class) as s
       join pg_class c on c.oid = s.n`,
      'unqualified_relation',
    ],
    // Types, XML, session functions
    ['a regclass cast', "select '1'::regclass", 'type_not_allowed'],
    ['an XML cast', "select 'x'::xml", 'type_not_allowed'],
    ['a qualified regproc cast', 'select null::pg_catalog.regproc', 'type_not_allowed'],
    ['XML construction', 'select xmlelement(name a)', 'unsupported_construct'],
    ['XMLTABLE', "select * from xmltable('/a' passing '<a/>' columns x int)", 'unsupported_construct'],
    ['CURRENT_USER', 'select current_user', 'value_function_not_allowed'],
    ['SESSION_USER', 'select session_user', 'value_function_not_allowed'],
    // Shapes that cost too much or join everything with everything
    ['WITH RECURSIVE', 'with recursive r(n) as (select 1 union all select n + 1 from r) select * from r', 'recursive_cte'],
    ['a comma join', 'select * from reporting.spendings, reporting.members', 'implicit_cross_join'],
    ['CROSS JOIN', 'select * from reporting.spendings cross join reporting.members', 'join_without_condition'],
    ['NATURAL JOIN', 'select * from reporting.spendings natural join reporting.members', 'join_without_condition'],
    ['JOIN ... ON true', 'select * from reporting.spendings join reporting.members on true', 'join_without_condition'],
    ['TABLESAMPLE', 'select * from reporting.spendings tablesample system (10)', 'unsupported_construct'],
    ['an operator from another schema', 'select 1 operator(public.+) 1', 'operator_not_allowed'],
    ['an operator outside the allow-list', 'select 1 # 2', 'operator_not_allowed'],
    [
      'a foreign operator in ORDER BY ... USING',
      'select amount from reporting.spendings order by amount using operator(public.<)',
      'operator_not_allowed',
    ],
    ['a foreign operator in ANY (subquery)', 'select 1 where 1 operator(public.=) any (select 1)', 'operator_not_allowed'],
    // Malformed input
    ['a syntax error', 'select from where', 'syntax_error'],
    ['empty SQL', '   ', 'empty'],
  ])('%s', async (_label, sql, code) => {
    expect(await issueCodes(sql)).toContain(code);
  });

  it('a placeholder with no value', async () => {
    expect(await issueCodes('select $3', 2)).toEqual(['param_out_of_range']);
  });

  it('SQL over the length limit', async () => {
    const long = `select 1 ${'+ 1 '.repeat(6_000)}`;
    expect(await issueCodes(long)).toEqual(['too_long']);
  });

  it('too many subqueries', async () => {
    let sql = 'select 1';
    for (let i = 0; i < 20; i += 1) sql = `select * from (${sql}) as s${i}`;
    expect(await issueCodes(sql)).toContain('too_complex');
  });

  it('too many joins', async () => {
    const joins = Array.from(
      { length: 12 },
      (_, i) => `join reporting.members m${i} on m${i}.member_id = s.member_id`,
    ).join(' ');
    expect(await issueCodes(`select 1 from reporting.spendings s ${joins}`)).toContain('too_complex');
  });
});

describe('sql-guard explains what to do instead', () => {
  it('reports every problem, not only the first', async () => {
    const codes = await issueCodes(`select pg_sleep(1), current_setting('x') from auth.users`);
    expect(codes.filter((code) => code === 'function_not_allowed')).toHaveLength(2);
    expect(codes).toContain('relation_not_allowed');
  });

  it('names the qualified view for an unqualified one', async () => {
    const result = await guard.check('select * from spendings');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.hint).toBe('Write reporting.spendings.');
  });

  it('lists the readable relations', async () => {
    const result = await guard.check('select * from auth.users');
    if (result.ok) throw new Error('expected a rejection');
    expect(result.issues[0]?.hint).toContain('reporting.monthly_income');
  });

  it('suggests close function names', async () => {
    const result = await guard.check('select summ(amount) from reporting.spendings');
    if (result.ok) throw new Error('expected a rejection');
    expect(result.issues[0]?.hint).toBe('Did you mean sum?');
  });

  it('gives the position of a syntax error', async () => {
    const result = await guard.check('select from where');
    if (result.ok) throw new Error('expected a rejection');
    expect(result.issues[0]?.position).toBe(12);
  });
});

describe('sql-guard policy', () => {
  it('requires schema-qualified, lowercase relations', () => {
    expect(() => createSqlGuard({ relations: ['spendings'] })).toThrow(/schema\.name/);
    expect(() => createSqlGuard({ relations: ['Reporting.Spendings'] })).toThrow(/schema\.name/);
  });

  it('can replace the function allow-list', async () => {
    const strict = createSqlGuard({ relations: RELATIONS, functions: ['count'] });
    expect((await strict.check('select count(*) from reporting.spendings')).ok).toBe(true);
    expect((await strict.check('select sum(amount) from reporting.spendings')).ok).toBe(false);
  });
});
