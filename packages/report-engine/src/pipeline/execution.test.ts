import { describe, expect, it } from 'vitest';

import type { QueryColumn, QueryOutcome, ReportQuery, RunOutcome } from '../pg';
import { buildVocabulary } from '../plan/vocabulary';
import { cachePrefix } from '../prompt/context';
import { createSqlGuard } from '../sql-guard';
import type { PlanSection, ReportPlan } from '../stages/plan';
import type { SectionSql } from '../stages/sql';
import { scriptedLlm, type ScriptedAnswer } from '../testing/llm';
import { testModel } from '../testing/model';
import { executeRun, type ExecutionDeps, type QueryAttempt } from './execution';
import { newRun, type RunState } from './state';

const model = testModel();
const vocabulary = buildVocabulary(model);
const prefix = cachePrefix(model, vocabulary);
const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };
const PERIOD = 'where spent_on >= $1::date and spent_on < $2::date';

const section = (id: string, fields: Partial<PlanSection> = {}): PlanSection => ({
  id,
  title: id,
  purpose: 'Shows it.',
  display: 'bar',
  query: {
    shape: 'aggregate',
    relation: 'reporting.spendings',
    metrics: ['spend'],
    dimensions: ['category'],
    grain: null,
    filters: [],
    period: OCTOBER,
    sort: [],
    limit: null,
  },
  essential: true,
  ...fields,
});

const TOTAL = section('total', {
  display: 'figure',
  query: { ...section('x').query!, dimensions: [] } as PlanSection['query'],
});
const BY_CATEGORY = section('by_category');

const plan = (sections: PlanSection[] = [TOTAL, BY_CATEGORY]): ReportPlan => ({
  title: 'October',
  summary: 'October spending.',
  sections,
  derived: [],
  crossChecks: [],
});

const totalSql: SectionSql = {
  section: 'total',
  sql: `select sum(amount) as spend from reporting.spendings ${PERIOD}`,
  params: [OCTOBER.from, OCTOBER.to],
  summary: 'Total spending in October.',
  columns: [{ name: 'spend', type: 'number' }],
};
const byCategorySql: SectionSql = {
  section: 'by_category',
  sql: `select category_label as category, sum(amount) as spend from reporting.spendings ${PERIOD} group by category_label`,
  params: [OCTOBER.from, OCTOBER.to],
  summary: 'Spending per category in October.',
  columns: [
    { name: 'category', type: 'text' },
    { name: 'spend', type: 'number' },
  ],
};
const answer = (...sections: SectionSql[]): ScriptedAnswer => ({ output: { sections } });

type Reply = { columns: QueryColumn[]; rows: Record<string, unknown>[] } | { error: string };
const COLUMNS: Record<string, QueryColumn[]> = {
  total: [{ name: 'spend', type: 'number' }],
  by_category: [
    { name: 'category', type: 'text' },
    { name: 'spend', type: 'number' },
  ],
};

/** Stands in for the executor; each run takes the next entry, by query id. */
function database(runs: Array<Record<string, Reply> | 'down'> = []) {
  const ran: string[][] = [];
  const query = async (queries: readonly ReportQuery[]): Promise<RunOutcome> => {
    ran.push(queries.map((entry) => entry.id));
    const script = runs.shift() ?? {};
    if (script === 'down') return { ok: false, error: { code: 'connection', message: 'Could not run the report.' }, queries: [], durationMs: 1 };
    const outcomes = queries.map((entry): QueryOutcome => {
      const reply = script[entry.id] ?? { columns: COLUMNS[entry.id] ?? [], rows: [{ spend: 42 }] };
      if ('error' in reply) {
        return { id: entry.id, ok: false, error: { code: 'undefined_column', message: reply.error }, durationMs: 3 };
      }
      return { id: entry.id, ok: true, ...reply, truncated: false, cost: 12, fingerprint: 'f', durationMs: 3 };
    });
    return { ok: true, queries: outcomes, durationMs: 5 };
  };
  return { query, ran };
}

function setup(answers: ScriptedAnswer[], runs: Array<Record<string, Reply> | 'down'> = [], overrides: Partial<ExecutionDeps> = {}) {
  const { llm, requests } = scriptedLlm(answers);
  const db = database(runs);
  const saved: RunState[] = [];
  const attempts: QueryAttempt[] = [];
  const deps: ExecutionDeps = {
    model,
    vocabulary,
    cachePrefix: prefix,
    llm,
    guard,
    query: db.query,
    timeZone: 'Europe/Berlin',
    now: () => new Date('2026-11-16T10:00:00Z'),
    save: async (state) => void saved.push(state),
    recordQuery: async (attempt) => void attempts.push(attempt),
    ...overrides,
  };
  return { deps, requests, saved, attempts, ran: db.ran };
}

const ready = (sections?: PlanSection[]): RunState => ({
  ...newRun('run-1', 'October spending by category'),
  status: 'executing',
  plan: plan(sections),
  planHash: 'a'.repeat(64),
});

describe('executeRun', () => {
  it('writes, checks and runs the SQL, and keeps every section result', async () => {
    const { deps, requests, saved, attempts, ran } = setup([answer(totalSql, byCategorySql)]);
    const state = await executeRun(ready(), deps);

    expect(state).toMatchObject({ status: 'succeeded', stage: null, error: null, costUsd: 0.01 });
    expect(state.results).toEqual([
      expect.objectContaining({ section: 'total', status: 'ok', sql: totalSql.sql, rows: [{ spend: 42 }], attempts: 1, problems: [] }),
      expect.objectContaining({ section: 'by_category', status: 'ok', columns: COLUMNS.by_category, attempts: 1 }),
    ]);
    expect(saved.map((entry) => [entry.status, entry.stage])).toEqual([
      ['executing', 'writing_sql'],
      ['executing', 'validating'],
      ['executing', 'executing'],
      ['succeeded', null],
    ]);
    expect(Object.keys(state.stageTimings).sort()).toEqual(['executing', 'validating', 'writing_sql']);
    expect(ran).toEqual([['total', 'by_category']]);
    expect(requests.map((request) => [request.stage, request.effort])).toEqual([['sql', 'high']]);
    expect(attempts.map((attempt) => [attempt.section, attempt.attempt, attempt.verdict, attempt.rows, attempt.cost])).toEqual([
      ['total', 1, 'ok', 1, 12],
      ['by_category', 1, 'ok', 1, 12],
    ]);
    expect(attempts[0]!.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('repairs a query that fails its checks, without running anything first', async () => {
    const misnamed = { ...byCategorySql, columns: [{ name: 'category_label', type: 'text' as const }, { name: 'spend', type: 'number' as const }] };
    const { deps, requests, attempts, ran } = setup([answer(totalSql, misnamed), answer(byCategorySql)]);
    const state = await executeRun(ready(), deps);

    expect(state.status).toBe('succeeded');
    expect(ran).toEqual([['total', 'by_category']]);
    expect(requests.map((request) => request.stage)).toEqual(['sql', 'sql_repair']);
    expect(requests[1]!.input).toContain('Only these: by_category.');
    expect(requests[1]!.input).toContain('missing category; not expected category_label');
    expect(state.results?.find((result) => result.section === 'by_category')?.attempts).toBe(2);
    expect(attempts.map((attempt) => [attempt.section, attempt.attempt, attempt.verdict])).toEqual([
      ['by_category', 1, 'rejected'],
      ['total', 1, 'ok'],
      ['by_category', 2, 'ok'],
    ]);
  });

  it('repairs a query that fails when it runs, then runs every section again together', async () => {
    const { deps, requests, attempts, ran } = setup(
      [answer(totalSql, byCategorySql), answer(byCategorySql)],
      [{ by_category: { error: 'column "categry" does not exist' } }],
    );
    const state = await executeRun(ready(), deps);

    expect(state.status).toBe('succeeded');
    expect(ran).toEqual([
      ['total', 'by_category'],
      ['total', 'by_category'],
    ]);
    expect(requests[1]!.input).toContain('- undefined_column: column "categry" does not exist');
    expect(attempts.map((attempt) => [attempt.section, attempt.attempt, attempt.verdict])).toEqual([
      ['by_category', 1, 'failed'],
      ['total', 1, 'ok'],
      ['by_category', 2, 'ok'],
    ]);
  });

  it('marks a section failed after two repairs; the run is partial when it is not essential', async () => {
    const inlined = { ...byCategorySql, sql: byCategorySql.sql.replace('$1::date', "'2026-10-01'::date").replace('$2', '$1'), params: [OCTOBER.to] };
    const optional = { ...BY_CATEGORY, essential: false };
    const { deps, requests } = setup([answer(totalSql, inlined), answer(inlined), answer(inlined)]);
    const state = await executeRun(ready([TOTAL, optional]), deps);

    expect(requests.map((request) => request.stage)).toEqual(['sql', 'sql_repair', 'sql_repair']);
    expect(state.status).toBe('partial');
    expect(state.results?.find((result) => result.section === 'by_category')).toMatchObject({
      status: 'failed',
      attempts: 3,
      rows: [],
      problems: ["'2026-10-01' is written into the SQL; pass it as a $n parameter."],
    });
    expect(state.results?.find((result) => result.section === 'total')?.status).toBe('ok');
  });

  it('fails the run when an essential section fails', async () => {
    const { deps } = setup([answer(totalSql), answer(), answer()]);
    const state = await executeRun(ready(), deps);

    expect(state).toMatchObject({
      status: 'failed',
      error: {
        stage: 'executing',
        code: 'sections_failed',
        message: '1 of 2 sections failed, including an essential one.',
        details: ['by_category: No SQL was written for this section.'],
      },
    });
    expect(state.results).toHaveLength(2);
  });

  it('keeps going without the repair when the repair call fails', async () => {
    const optional = { ...BY_CATEGORY, essential: false };
    const { deps, requests } = setup([answer(totalSql), { fails: 'unavailable' }]);
    const state = await executeRun(ready([TOTAL, optional]), deps);

    expect(requests).toHaveLength(2);
    expect(state.status).toBe('partial');
    expect(state.costUsd).toBe(0.02);
  });

  it('fails when the first SQL call fails or the database is down', async () => {
    const down = setup([{ fails: 'budget_exceeded' }]);
    expect(await executeRun(ready(), down.deps)).toMatchObject({
      status: 'failed',
      error: { stage: 'writing_sql', code: 'budget_exceeded' },
    });
    const offline = setup([answer(totalSql, byCategorySql)], ['down']);
    expect(await executeRun(ready(), offline.deps)).toMatchObject({
      status: 'failed',
      error: { stage: 'executing', code: 'database', message: 'Could not run the report.' },
    });
  });

  it('finishes a text-only plan without writing SQL', async () => {
    const { deps, requests } = setup([]);
    const state = await executeRun(ready([section('note', { display: 'text', query: null })]), deps);
    expect(state).toMatchObject({ status: 'succeeded', results: [] });
    expect(requests).toHaveLength(0);
  });

  it('only executes a run with an approved plan', async () => {
    const { deps } = setup([]);
    await expect(executeRun({ ...ready(), status: 'awaiting_approval' }, deps)).rejects.toThrow('no approved plan');
    await expect(executeRun({ ...ready(), plan: null }, deps)).rejects.toThrow('no approved plan');
  });
});
