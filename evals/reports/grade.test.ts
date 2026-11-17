import { newRun, type RunState, type SectionResult } from 'report-engine';
import { describe, expect, it } from 'vitest';

import { buildCases, type EvalCase, type Fact } from './cases';
import { buildFixture, MARKERS } from './fixture';
import { gradeRun } from './grade';

/**
 * The grader on runs made by hand: an oracle that carries exactly the
 * expected facts must pass every case, a run with nothing must fail every
 * answer case, and near misses must fail.
 */

const fixture = buildFixture('2026-11-17');
const cases = buildCases(fixture);
const byId = (id: string) => cases.find((evalCase) => evalCase.id === id)!;

const section = (id: string, rows: Array<Record<string, unknown>>): SectionResult => ({
  section: id,
  status: 'ok',
  sql: 'select 1',
  params: [],
  summary: null,
  columns: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: 'text' as const })),
  rows,
  truncated: false,
  attempts: 1,
  problems: [],
});

/** One section holding exactly what the fact asks for, shaped as the SQL might return it. */
function sectionFor(fact: Fact, index: number): SectionResult {
  const id = `s${index}`;
  switch (fact.kind) {
    case 'scalar':
      return section(id, [{ value: fact.value }]);
    case 'map':
      return section(
        id,
        Object.entries(fact.entries).map(([key, value]) => {
          const parts = key.split('|');
          return parts.length === 2 ? { member: parts[0], category: parts[1], spend: value } : { name: parts[0], spend: value };
        }),
      );
    case 'series':
      // Numeric text too, as numeric columns can come back.
      return section(id, Object.entries(fact.points).map(([month, value]) => ({ month: `${month}-01`, value: value.toFixed(2) })));
    case 'rows':
      return section(id, fact.rows.map((row) => ({ day: row.date ?? '2026-10-03', description: row.text ?? 'Something', amount: row.amount })));
  }
}

const run = (fields: Partial<RunState>): RunState => ({ ...newRun('3f0c7a52-6b1e-4d2a-9c8e-1b2a3c4d5e6f', 'question'), ...fields });

function oracle(evalCase: EvalCase): RunState {
  switch (evalCase.expect) {
    case 'answer':
      return run({ status: 'succeeded', results: evalCase.facts.map(sectionFor) });
    case 'clarify':
      return run({ status: 'needs_clarification' });
    case 'refuse':
      return run({ status: 'failed', error: { stage: 'understanding', code: 'write_request', message: 'No.' } });
    case 'infeasible':
      return run({ status: 'failed', error: { stage: 'checking', code: 'infeasible', message: 'No data.' } });
  }
}

describe('the eval set', () => {
  it('has unique ids, a question each, and facts for every answer', () => {
    expect(new Set(cases.map((evalCase) => evalCase.id)).size).toBe(cases.length);
    expect(cases.length).toBeGreaterThanOrEqual(25);
    for (const evalCase of cases) {
      expect(evalCase.question.length, evalCase.id).toBeGreaterThan(10);
      expect(evalCase.tags.length, evalCase.id).toBeGreaterThan(0);
      if (evalCase.expect === 'answer') expect(evalCase.facts.length, evalCase.id).toBeGreaterThan(0);
    }
  });

  it('has gold that is never trivially zero or empty', () => {
    for (const evalCase of cases) {
      for (const fact of evalCase.facts) {
        const values =
          fact.kind === 'scalar' ? [fact.value] : fact.kind === 'rows' ? fact.rows.map((row) => row.amount) : Object.values(fact.kind === 'map' ? fact.entries : fact.points);
        expect(values.length, `${evalCase.id}: ${fact.label}`).toBeGreaterThan(0);
        // A change may be negative; nothing expected is zero, or nothing would tell it from a missing value.
        expect(values.every((value) => Number.isFinite(value) && value !== 0), `${evalCase.id}: ${fact.label}`).toBe(true);
      }
    }
  });

  it('names the months the way a person would, from today', () => {
    expect(byId('groceries-named-month').question).toBe('How much did we spend on Groceries in September 2026?');
    expect(byId('income-this-year').question).toContain('2026');
  });
});

describe('gradeRun', () => {
  it('passes the oracle on every case', () => {
    for (const evalCase of cases) {
      expect(gradeRun(evalCase, oracle(evalCase)).grade, evalCase.id).toEqual({ correct: 1, outcome: 1, isolated: 1 });
    }
  });

  it('fails a run with nothing to show, and a failed run, on every answer case', () => {
    for (const evalCase of cases.filter((item) => item.expect === 'answer')) {
      expect(gradeRun(evalCase, run({ status: 'succeeded', results: [] })).grade.correct, evalCase.id).toBe(0);
      const failed = gradeRun(evalCase, run({ status: 'failed', error: { stage: 'executing', code: 'sections_failed', message: 'x' } }));
      expect(failed).toMatchObject({ actual: 'error', code: 'sections_failed', grade: { correct: 0, outcome: 0 } });
    }
  });

  it('fails a behaviour case that answers instead', () => {
    for (const evalCase of cases.filter((item) => item.expect !== 'answer')) {
      expect(gradeRun(evalCase, run({ status: 'succeeded', results: [section('s0', [{ value: 1 }])] })).grade.correct, evalCase.id).toBe(0);
    }
  });

  it('fails near misses', () => {
    const total = byId('total-last-month');
    const value = (total.facts[0] as Extract<Fact, { kind: 'scalar' }>).value;
    expect(gradeRun(total, run({ status: 'succeeded', results: [section('s', [{ value: value + 1 }])] })).grade.correct).toBe(0);
    expect(gradeRun(total, run({ status: 'succeeded', results: [section('s', [{ value: value + 0.005 }])] })).grade.correct).toBe(1);

    const categories = byId('by-category-last-month');
    const entries = (categories.facts[0] as Extract<Fact, { kind: 'map' }>).entries;
    const rows = Object.entries(entries).map(([name, spend]) => ({ name, spend }));
    expect(gradeRun(categories, run({ status: 'succeeded', results: [section('s', rows.slice(1))] })).grade.correct).toBe(0);
    const extra = [...rows, { name: 'Yachts', spend: 5 }];
    expect(gradeRun(categories, run({ status: 'succeeded', results: [section('s', extra)] })).facts[0]?.met).toBe(false);
    // A category with nothing spent may be listed.
    const zero = [...rows, { name: 'Health', spend: 0 }];
    expect(gradeRun(categories, run({ status: 'succeeded', results: [section('s', zero)] })).grade.correct).toBe(1);
    // A second row for a category, with another value, is wrong even next to the right one.
    const duplicate = [...rows, { name: 'Groceries', spend: 12.5 }];
    const graded = gradeRun(categories, run({ status: 'succeeded', results: [section('s', duplicate)] }));
    expect(graded.facts[0]).toMatchObject({ met: false, detail: 'closest is s: 1 row(s) with a wrong value' });

    const largest = byId('largest-five-last-month');
    const ordered = (largest.facts[0] as Extract<Fact, { kind: 'rows' }>).rows.map((row) => ({ description: row.text, amount: row.amount }));
    const swapped = [ordered[1], ordered[0], ...ordered.slice(2)];
    expect(gradeRun(largest, run({ status: 'succeeded', results: [section('s', swapped)] })).grade.correct).toBe(0);

    const shopping = byId('shopping-last-month');
    const all = (shopping.facts[0] as Extract<Fact, { kind: 'rows' }>).rows.map((row) => ({ description: row.text ?? 'Clothes', amount: row.amount }));
    expect(gradeRun(shopping, run({ status: 'succeeded', results: [section('s', [...all].reverse())] })).grade.correct).toBe(1);
    expect(gradeRun(shopping, run({ status: 'succeeded', results: [section('s', [...all, { description: 'Bread', amount: 2 }])] })).grade.correct).toBe(0);
    const scrubbed = all.map((row) => ({ ...row, description: 'Clothes' }));
    expect(gradeRun(shopping, run({ status: 'succeeded', results: [section('s', scrubbed)] })).grade.correct).toBe(0);

    const trend = byId('trend-six-months');
    const points = Object.entries((trend.facts[0] as Extract<Fact, { kind: 'series' }>).points).map(([month, value]) => ({ month: `${month}-01`, value }));
    expect(gradeRun(trend, run({ status: 'succeeded', results: [section('s', [...points, { month: '2026-11-01', value: 100 }])] })).grade.correct).toBe(0);
  });

  it('takes a percentage rounded to a tenth, or as a fraction, but no further off', () => {
    const share = byId('groceries-share-last-month');
    const value = (share.facts[0] as Extract<Fact, { kind: 'scalar' }>).value;
    const grade = (number: number) => gradeRun(share, run({ status: 'succeeded', results: [section('s', [{ share: number }])] })).grade.correct;
    expect(grade(Math.round(value * 10) / 10)).toBe(1);
    expect(grade(value / 100)).toBe(1);
    expect(grade(value + 0.2)).toBe(0);
    expect(grade(value / 100 + 0.002)).toBe(0);
  });

  it('reads derived values with the keys of their section', () => {
    const left = byId('left-over-by-month');
    const points = Object.entries((left.facts[0] as Extract<Fact, { kind: 'series' }>).points);
    const derived = [
      {
        id: 'left',
        kind: 'difference' as const,
        label: 'Left over',
        section: 'income',
        format: { kind: 'money' as const },
        rows: points.map(([month, value]) => ({ key: { income_month: `${month}-01` }, value })),
        skipped: null,
      },
    ];
    expect(gradeRun(left, run({ status: 'succeeded', results: [], derived })).grade.correct).toBe(1);
    expect(gradeRun(left, run({ status: 'succeeded', results: [], derived: [{ ...derived[0]!, skipped: 'section income failed' }] })).grade.correct).toBe(0);
  });

  it('needs every fact of a case with two', () => {
    const both = byId('income-vs-spending');
    const [income] = both.facts.map(sectionFor);
    expect(gradeRun(both, run({ status: 'succeeded', results: [income!] })).grade.correct).toBe(0);
  });

  it('fails any run that shows the other household', () => {
    const evalCase = byId('total-last-month');
    const leaking = run({ status: 'succeeded', results: [...evalCase.facts.map(sectionFor), section('x', [{ description: MARKERS.description, amount: MARKERS.amount }])] });
    expect(gradeRun(evalCase, leaking).grade).toEqual({ correct: 0, outcome: 1, isolated: 0 });
    const income = run({ status: 'succeeded', results: [...evalCase.facts.map(sectionFor), section('y', [{ amount: String(MARKERS.income) }])] });
    expect(gradeRun(evalCase, income).grade.isolated).toBe(0);
  });
});
