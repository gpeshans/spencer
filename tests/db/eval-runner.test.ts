import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { todayIn, toPlanDraft, type ReportPlan } from 'report-engine';
import { afterAll, describe, expect, it } from 'vitest';

import { buildFixture } from '../../evals/reports/fixture';
import { fakeLlm, offlineLlm, runEval, summarize, type EvalRow, type Turn } from '../../evals/reports/runner';
import { dockerAvailable } from './harness';

/**
 * The eval's harness end to end, without the API. First the fake LLM refuses
 * every question at stage 1, after the household-values query has run
 * through the executor and the signed scope: what lands on disk, a lost
 * attempt kept out of the scores, a rerun that resumes, the report. Then a
 * scripted LLM answers every stage, so a run plans, writes SQL, runs it
 * against the fixture database and gets graded on what came back.
 */

const lines = <T>(file: string): T[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as T) : [];

const TIME_ZONE = 'Europe/Berlin';
const NOW = new Date();

describe.skipIf(!dockerAvailable())('the eval runner, offline', () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'report-eval-'));
  const options = { outDir, reps: 1, concurrency: 2, maxUsd: 1, timeZone: TIME_ZONE, now: () => NOW, log: () => {} };

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('grades each attempt, keeps a lost one out of the scores, then resumes', async () => {
    const dir = path.join(outDir, 'baseline');
    const caseIds = ['total-last-month', 'refuse-weather', 'count-last-month'];
    const first = await runEval({ ...options, variant: 'baseline', caseIds, llm: fakeLlm('count-last-month') });
    expect(first.errors).toBe(1);
    const scored = Object.fromEntries(first.rows.map((row) => [row.prompt_id, row]));
    // A question refused is wrong for an answer case, right for a refusal case.
    expect(scored['total-last-month']).toMatchObject({
      grade: { correct: 0, outcome: 0, isolated: 1 },
      actual: { outcome: 'refuse', code: 'out_of_scope' },
      llm_calls: 1,
      model: 'offline',
    });
    expect(scored['refuse-weather']).toMatchObject({ grade: { correct: 1, outcome: 1, isolated: 1 } });
    expect(lines<{ class: string; prompt_id: string }>(path.join(dir, 'errors.jsonl'))).toMatchObject([{ class: 'harness', prompt_id: 'count-last-month' }]);
    expect(readdirSync(path.join(dir, 'traces')).sort()).toEqual(['count-last-month_rep0.json', 'refuse-weather_rep0.json', 'total-last-month_rep0.json']);
    expect(JSON.parse(readFileSync(path.join(outDir, '_state.json'), 'utf8')).metrics[0]).toMatchObject({ id: 'correct', kind: 'binary' });

    const trace = JSON.parse(readFileSync(path.join(dir, 'traces', 'total-last-month_rep0.json'), 'utf8')) as Turn[];
    expect(trace[0]).toMatchObject({ role: 'system' });
    expect(trace[1]).toEqual({ role: 'user', content: 'How much did we spend last month?' });
    expect(trace.some((turn) => turn.role === 'assistant' && turn.name === 'intent' && turn.content.includes('out_of_scope'))).toBe(true);

    // The rerun runs only the lost attempt, and its success supersedes the error.
    const second = await runEval({ ...options, variant: 'baseline', caseIds, llm: fakeLlm() });
    expect(lines<EvalRow>(path.join(dir, 'results.jsonl')).map((row) => row.prompt_id).sort()).toEqual([...caseIds].sort());
    expect(second.errors).toBe(0);
    expect(summarize(second)).toContain('**Correct: 1/3');
  }, 240_000);

  it('runs a scripted answer through every stage and grades what the database returned', async () => {
    const fixture = buildFixture(todayIn(TIME_ZONE, NOW));
    const lastMonth = { from: fixture.monthStart(-1), to: fixture.monthStart(0) };
    // Answers the wrong month, consistently: a well-formed run that is wrong.
    const monthBefore = { from: fixture.monthStart(-2), to: fixture.monthStart(-1) };
    const where = 'where spent_on >= $1::date and spent_on < $2::date';

    const script = (period: { from: string; to: string }, dimension: 'member' | null) => {
      const id = dimension ? `by_${dimension}` : 'total';
      const plan: ReportPlan = {
        title: 'Last month',
        summary: 'Spending last month.',
        sections: [
          {
            id,
            title: id,
            purpose: 'Shows it.',
            display: dimension ? 'bar' : 'figure',
            query: {
              shape: 'aggregate',
              relation: 'reporting.spendings',
              metrics: ['spend'],
              dimensions: dimension ? [dimension] : [],
              grain: null,
              filters: [],
              period,
              sort: [],
              limit: null,
            },
            essential: true,
          },
        ],
        derived: [],
        crossChecks: [],
      };
      return {
        intent: {
          kind: dimension ? 'breakdown' : 'figure',
          restated: 'Spending last month.',
          metrics: ['spend'],
          dimensions: dimension ? [dimension] : [],
          grain: null,
          filters: [],
          period,
          comparison: null,
          assumptions: [],
          ambiguities: [],
          confidence: 'high',
          refusal: null,
        },
        plan: toPlanDraft(plan),
        sql: {
          sections: [
            dimension
              ? {
                  section: id,
                  sql: `select member_name as member, sum(amount) as spend from reporting.spendings ${where} group by member_name`,
                  params: [period.from, period.to],
                  summary: 'Spending per member.',
                  columns: [
                    { name: 'member', type: 'text' },
                    { name: 'spend', type: 'number' },
                  ],
                }
              : {
                  section: id,
                  sql: `select sum(amount) as spend from reporting.spendings ${where}`,
                  params: [period.from, period.to],
                  summary: 'Total spending.',
                  columns: [{ name: 'spend', type: 'number' }],
                },
          ],
        },
      };
    };
    const scripts: Record<string, Record<string, unknown>> = {
      'total-last-month': script(lastMonth, null),
      'by-member-last-month': script(monthBefore, 'member'),
    };
    const llm = offlineLlm((evalCase, stage) => {
      const answer = scripts[evalCase.id]?.[stage];
      if (answer === undefined) throw new Error(`no scripted ${stage} answer for ${evalCase.id}`);
      return answer;
    });

    const summary = await runEval({ ...options, variant: 'v1', caseIds: Object.keys(scripts), llm });
    expect(summary.errors).toBe(0);
    const rows = Object.fromEntries(summary.rows.map((row) => [row.prompt_id, row]));
    expect(rows['total-last-month']).toMatchObject({
      grade: { correct: 1, outcome: 1, isolated: 1 },
      actual: { outcome: 'answer', code: null, facts: [{ met: true, detail: 'in total' }] },
      llm_calls: 3,
      repairs: 0,
      meta: { run_status: 'succeeded' },
    });
    expect(rows['by-member-last-month']).toMatchObject({
      grade: { correct: 0, outcome: 1, isolated: 1 },
      actual: { outcome: 'answer', facts: [{ met: false }] },
    });
    expect(rows['by-member-last-month']!.actual.facts[0]!.detail).toMatch(/^closest is by_member: missing (Alice|Ben) = /);

    const trace = JSON.parse(readFileSync(path.join(outDir, 'v1', 'traces', 'total-last-month_rep0.json'), 'utf8')) as Turn[];
    expect(trace.map((turn) => turn.name ?? turn.role)).toEqual(expect.arrayContaining(['intent', 'plan', 'sql', 'sql total', 'outcome']));
    const result = trace.find((turn) => turn.role === 'tool_result');
    expect(result?.content).toContain('"spend"');
  }, 240_000);

  it('builds the report from what it wrote', () => {
    execFileSync(process.execPath, [path.resolve('evals/reports/build-report-lite.mjs'), outDir], { stdio: 'pipe' });
    const html = readFileSync(path.join(outDir, 'report.html'), 'utf8');
    for (const id of ['total-last-month', 'refuse-weather', 'by-member-last-month']) expect(html).toContain(id);
  });
});
