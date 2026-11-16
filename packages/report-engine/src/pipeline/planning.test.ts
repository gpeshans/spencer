import { describe, expect, it } from 'vitest';

import { priceOf } from '../llm';
import type { QueryOutcome, ReportQuery, RunOutcome } from '../pg';
import { buildVocabulary } from '../plan/vocabulary';
import { cachePrefix } from '../prompt/context';
import type { Intent } from '../stages/intent';
import type { PlanSection, ReportPlan } from '../stages/plan';
import { scriptedLlm, type ScriptedAnswer } from '../testing/llm';
import { testModel } from '../testing/model';
import { answerClarification, approvePlan, expireRun, planRun, rejectRun, todayIn, type PlanningDeps } from './planning';
import { newRun, RunStateError, type RunState } from './state';

const model = testModel();
const vocabulary = buildVocabulary(model);
const prefix = cachePrefix(model, vocabulary);
const NOW = new Date('2026-11-16T10:00:00Z');
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };

interface Data {
  values?: Record<string, string[]>;
  coverage?: Record<string, Record<string, unknown>>;
  broken?: boolean;
}

const HOUSEHOLD = { category: ['Groceries', 'Rent'], bucket: ['needs'], member: ['Alex'], income_category: ['Salary'] };
const COVERED = { first: '2026-01-02', last: '2026-11-15', rows: 12, comparison_rows: 8 };

/** Stands in for the executor: answers the value and coverage probes. */
function database(data: Data = {}) {
  const ran: string[][] = [];
  const query = async (queries: readonly ReportQuery[]): Promise<RunOutcome> => {
    ran.push(queries.map((query) => query.id));
    if (data.broken) return { ok: false, error: { code: 'scope_mismatch', message: 'Scope mismatch.' }, queries: [], durationMs: 1 };
    const outcomes = queries.map((query): QueryOutcome => {
      const [kind, ...rest] = query.id.split('.');
      const name = rest.join('.');
      const rows =
        kind === 'values'
          ? (data.values ?? HOUSEHOLD)[name as keyof typeof HOUSEHOLD]?.map((value) => ({ value })) ?? []
          : [data.coverage?.[name] ?? COVERED];
      return { id: query.id, ok: true, columns: [], rows, truncated: false, cost: 1, fingerprint: 'f', durationMs: 1 };
    });
    return { ok: true, queries: outcomes, durationMs: 1 };
  };
  return { query, ran };
}

function setup(answers: ScriptedAnswer[], data: Data = {}, overrides: Partial<PlanningDeps> = {}) {
  const { llm, requests } = scriptedLlm(answers);
  const db = database(data);
  const saved: RunState[] = [];
  const deps: PlanningDeps = {
    vocabulary,
    cachePrefix: prefix,
    llm,
    query: db.query,
    shareValues: true,
    timeZone: 'Europe/Berlin',
    now: () => NOW,
    remainingUsd: () => 0.45,
    price: priceOf('claude-opus-5-5'),
    save: async (state) => {
      saved.push(state);
    },
    ...overrides,
  };
  return { deps, requests, saved, ran: db.ran };
}

const intent = (fields: Partial<Intent> = {}): Intent => ({
  kind: 'breakdown',
  restated: 'Spending per category in October.',
  metrics: ['spend'],
  dimensions: ['category'],
  grain: null,
  filters: [],
  period: OCTOBER,
  comparison: null,
  assumptions: [],
  ambiguities: [],
  confidence: 'high',
  refusal: null,
  ...fields,
});

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

const plan = (sections = [section('by_category')]): ReportPlan => ({
  title: 'October spending',
  summary: 'Spending in October, by category.',
  sections,
  derived: [],
  crossChecks: [],
});

const run = () => newRun('run-1', '  How much did we spend per category in October?  ');

describe('planRun', () => {
  it('goes from the request to a plan that is ready to run', async () => {
    const { deps, requests, saved, ran } = setup([{ output: intent() }, { output: plan() }]);
    const state = await planRun(run(), deps);

    expect(state).toMatchObject({
      status: 'executing',
      stage: null,
      request: 'How much did we spend per category in October?',
      intent: intent(),
      flags: [],
      feasibility: { status: 'ok' },
      plan: plan(),
      unchecked: [],
      approval: null,
      error: null,
      costUsd: 0.02,
      usage: { inputTokens: 200, outputTokens: 100 },
    });
    expect(state.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(state.stageTimings).sort()).toEqual(['checking', 'planning', 'understanding']);
    expect(saved.map((entry) => [entry.status, entry.stage])).toEqual([
      ['planning', 'understanding'],
      ['planning', 'checking'],
      ['planning', 'planning'],
      ['executing', null],
    ]);
    expect(ran).toEqual([
      ['values.category', 'values.bucket', 'values.member', 'values.income_category'],
      ['coverage.reporting.spendings'],
    ]);
    expect(requests.map((request) => [request.stage, request.effort, request.cachePrefix === prefix])).toEqual([
      ['intent', 'low', true],
      ['plan', 'high', true],
    ]);
    expect(requests[0]!.input).toContain('Today is 2026-11-16, a Monday, in the time zone Europe/Berlin.');
    expect(requests[0]!.input).toMatch(/<untrusted-values-[0-9a-f]{16}>\ncategory: \["Groceries","Rent"\]/);
  });

  it('keeps the household values from the LLM when they are not shared', async () => {
    const { deps, requests } = setup([{ output: intent() }, { output: plan() }], {}, { shareValues: false });
    await planRun(run(), deps);
    expect(requests.every((request) => !request.input.includes('untrusted-values'))).toBe(true);
  });

  it('asks a clarifying question, then plans with the answer', async () => {
    const question = { question: 'Which month?', options: ['October', 'November'] };
    const first = setup([{ output: intent({ ambiguities: [question] }) }]);
    const asked = await planRun(run(), first.deps);
    expect(asked).toMatchObject({
      status: 'needs_clarification',
      clarifications: [{ ...question, answer: null, askedAt: NOW.toISOString() }],
      pendingUntil: '2026-11-17T10:00:00.000Z',
      costUsd: 0.01,
    });

    const answered = answerClarification({ ...asked, intent: intent() }, '  October ', NOW);
    expect(answered).toMatchObject({
      status: 'planning',
      clarifications: [{ answer: 'October' }],
      intent: null,
      plan: null,
      pendingUntil: null,
    });
    const second = setup([{ output: intent() }, { output: plan() }]);
    const done = await planRun(answered, second.deps);
    expect(done).toMatchObject({ status: 'executing', costUsd: 0.03 });
    expect(second.requests[0]!.input).toMatch(/untrusted-clarifications-[0-9a-f]{16}>\nQuestion: Which month\?\nAnswer: October/);
  });

  it('gives up after two questions', async () => {
    const asked = (question: string) => ({ question, options: [], answer: 'something', askedAt: NOW.toISOString() });
    const state: RunState = { ...run(), status: 'planning', clarifications: [asked('One?'), asked('Two?')] };
    const { deps } = setup([{ output: intent({ ambiguities: [{ question: 'Three?', options: [] }] }) }]);
    expect(await planRun(state, deps)).toMatchObject({
      status: 'failed',
      error: { stage: 'understanding', code: 'unclear', details: ['Three?'] },
    });
  });

  it('refuses a request to change data', async () => {
    const { deps } = setup([{ output: intent({ kind: 'write_request', refusal: 'It asks to delete expenses.' }) }]);
    expect(await planRun(run(), deps)).toMatchObject({
      status: 'failed',
      error: { stage: 'understanding', code: 'write_request', message: 'It asks to delete expenses.' },
    });
  });

  it('retries an intent that breaks the rules once, with the problems listed', async () => {
    const bad = intent({ period: { from: '2026-11-01', to: '2026-10-01' } });
    const once = setup([{ output: bad }, { output: intent() }, { output: plan() }]);
    expect((await planRun(run(), once.deps)).status).toBe('executing');
    expect(once.requests[1]!.input).toMatch(/untrusted-issues-[0-9a-f]{16}>\n- period: "from" \(2026-11-01\) must be before/);

    const twice = setup([{ output: bad }, { output: bad }]);
    expect(await planRun(run(), twice.deps)).toMatchObject({
      status: 'failed',
      error: { stage: 'understanding', code: 'invalid_output', details: [expect.stringContaining('must be before')] },
    });
  });

  it('fails a stage when the LLM call fails', async () => {
    const { deps } = setup([{ output: intent() }, { fails: 'unavailable' }]);
    expect(await planRun(run(), deps)).toMatchObject({
      status: 'failed',
      error: { stage: 'planning', code: 'unavailable' },
      costUsd: 0.02,
    });
  });

  it('stops before planning when there is no data for the period', async () => {
    const empty = { first: '2026-03-01', last: '2026-08-31', rows: 0 };
    const { deps, requests } = setup([{ output: intent() }], { coverage: { 'reporting.spendings': empty } });
    const state = await planRun(run(), deps);
    expect(state).toMatchObject({
      status: 'failed',
      feasibility: { status: 'no' },
      error: {
        stage: 'checking',
        code: 'infeasible',
        details: ['Ask about 2026-03-01 to 2026-08-31, where reporting.spendings has data.'],
      },
    });
    expect(requests).toHaveLength(1);
  });

  it('stops when the semantic model is out of date, or the database run fails', async () => {
    const stale = setup([{ output: intent() }], {}, { modelFresh: async () => false });
    expect(await planRun(run(), stale.deps)).toMatchObject({ status: 'failed', error: { code: 'infeasible' } });
    const broken = setup([], { broken: true });
    expect(await planRun(run(), broken.deps)).toMatchObject({
      status: 'failed',
      error: { stage: 'understanding', code: 'database', message: 'Scope mismatch.' },
    });
  });

  it('asks for approval when stage 2 found a gap, and the approved plan can run', async () => {
    const late = { first: '2026-10-12', last: '2026-11-15', rows: 9 };
    const { deps } = setup([{ output: intent() }, { output: plan() }], { coverage: { 'reporting.spendings': late } });
    const state = await planRun(run(), deps);
    expect(state).toMatchObject({
      status: 'awaiting_approval',
      approval: { reasons: ['reporting.spendings has data only from 2026-10-12, so the period is covered from then on.'] },
      pendingUntil: '2026-11-17T10:00:00.000Z',
    });

    expect(() => approvePlan(state, 'f'.repeat(64), NOW)).toThrow(RunStateError);
    expect(approvePlan(state, state.planHash!, NOW)).toMatchObject({ status: 'executing', pendingUntil: null });
    expect(() => approvePlan(state, state.planHash!, new Date('2026-11-17T10:00:00Z'))).toThrow('expired');
  });

  it('asks for approval for a large plan or one that may cost more than the budget left', async () => {
    const five = plan(['a', 'b', 'c', 'd', 'e'].map((id) => section(id)));
    const large = setup([{ output: intent() }, { output: five }]);
    expect((await planRun(run(), large.deps)).approval?.reasons).toEqual(['The plan has 5 sections, more than 4.']);

    const poor = setup([{ output: intent() }, { output: plan() }], {}, { remainingUsd: () => 0.05 });
    expect((await planRun(run(), poor.deps)).approval?.reasons).toEqual([
      expect.stringMatching(/^The rest of the run is estimated at \$0\.\d\d, more than the \$0\.05 left in its budget\.$/),
    ]);
  });

  it('retries a plan that fails its checks once, with the problems listed', async () => {
    const figure = plan([section('total', { display: 'figure' })]);
    const { deps, requests } = setup([{ output: intent() }, { output: figure }, { output: plan() }]);
    expect((await planRun(run(), deps)).status).toBe('executing');
    expect(requests[2]!.input).toContain('- total: a figure is an aggregate with no dimensions and no grain');
  });

  it('only plans runs that are received or answered', async () => {
    const { deps } = setup([]);
    await expect(planRun({ ...run(), status: 'awaiting_approval' }, deps)).rejects.toThrow("can't be planned");
  });
});

describe('the explicit moves', () => {
  const pending = (status: 'needs_clarification' | 'awaiting_approval'): RunState => ({
    ...run(),
    status,
    planHash: 'a'.repeat(64),
    pendingUntil: '2026-11-17T10:00:00.000Z',
    clarifications: [{ question: 'Which?', options: [], answer: null, askedAt: NOW.toISOString() }],
  });

  it('checks answers', () => {
    expect(() => answerClarification(pending('awaiting_approval'), 'x', NOW)).toThrow('no open question');
    expect(() => answerClarification(pending('needs_clarification'), '   ', NOW)).toThrow('1 to 500');
    expect(() => answerClarification(pending('needs_clarification'), 'x', new Date('2026-11-18T00:00:00Z'))).toThrow('expired');
  });

  it('rejects and expires only what is pending', () => {
    expect(rejectRun(pending('needs_clarification')).status).toBe('rejected');
    expect(() => rejectRun({ ...run(), status: 'executing' })).toThrow("can't be rejected");
    expect(expireRun(pending('awaiting_approval'), new Date('2026-11-17T10:00:00Z')).status).toBe('expired');
    expect(expireRun(pending('awaiting_approval'), NOW).status).toBe('awaiting_approval');
    expect(expireRun({ ...run(), status: 'executing' }, new Date('2030-01-01')).status).toBe('executing');
  });

  it('checks new requests and works out today in the time zone', () => {
    expect(() => newRun('r', '  ')).toThrow('1 to 2000');
    expect(() => newRun('r', 'x'.repeat(2001))).toThrow('1 to 2000');
    expect(todayIn('Europe/Berlin', new Date('2026-11-16T23:30:00Z'))).toBe('2026-11-17');
    expect(todayIn('America/New_York', new Date('2026-11-16T03:00:00Z'))).toBe('2026-11-15');
  });
});
