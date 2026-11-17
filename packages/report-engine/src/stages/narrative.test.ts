import { describe, expect, it } from 'vitest';

import { buildVocabulary } from '../plan/vocabulary';
import { scriptedLlm } from '../testing/llm';
import { testModel } from '../testing/model';
import type { ComputedSection, DerivedResult } from './derive';
import type { Intent } from './intent';
import { buildReferences, checkSentence, finishNarrative, writeNarrative, yearsOf, type NarrativeInput, type Reference } from './narrative';
import type { PlanSection, ReportPlan } from './plan';

const vocabulary = buildVocabulary(testModel());
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };

const intent: Intent = {
  kind: 'breakdown',
  restated: 'Spending per category in October.',
  metrics: ['spend'],
  dimensions: ['category'],
  grain: null,
  filters: [],
  period: OCTOBER,
  comparison: null,
  assumptions: ['October means October 2026.'],
  ambiguities: [],
  confidence: 'high',
  refusal: null,
};

const section = (id: string, title: string, dimensions: string[]): PlanSection => ({
  id,
  title,
  purpose: 'Shows it.',
  display: dimensions.length > 0 ? 'bar' : 'figure',
  query: {
    shape: 'aggregate',
    relation: 'reporting.spendings',
    metrics: ['spend'],
    dimensions,
    grain: null,
    filters: [],
    period: OCTOBER,
    sort: [],
    limit: null,
  },
  essential: true,
});

const plan: ReportPlan = {
  title: 'October',
  summary: 'October spending.',
  sections: [section('total', 'Total spending', []), section('by_category', 'By category', ['category'])],
  derived: [],
  crossChecks: [],
};

const results = new Map<string, ComputedSection>([
  ['total', { section: 'total', status: 'ok', columns: [{ name: 'spend', type: 'number' }], rows: [{ spend: 660.95 }], truncated: false }],
  [
    'by_category',
    {
      section: 'by_category',
      status: 'ok',
      columns: [
        { name: 'category', type: 'text' },
        { name: 'spend', type: 'number' },
      ],
      rows: [
        { category: 'Groceries', spend: 516.45 },
        { category: 'Dining', spend: 144.5 },
      ],
      truncated: false,
    },
  ],
]);

const share: DerivedResult = {
  id: 'share',
  kind: 'share_of_total',
  label: 'Share of spending',
  section: 'by_category',
  format: { kind: 'percent' },
  rows: [
    { key: { category: 'Groceries' }, value: 78.14 },
    { key: { category: 'Dining' }, value: 21.86 },
  ],
  skipped: null,
};

const input = (fields: Partial<NarrativeInput> = {}): NarrativeInput => ({
  request: 'How much did we spend per category in October?',
  intent,
  plan,
  results,
  derived: [share],
  vocabulary,
  shareValues: true,
  today: '2026-11-17',
  timeZone: 'Europe/Berlin',
  ...fields,
});

const MONEY = { kind: 'money' } as const;

describe('buildReferences', () => {
  it('lists the period, every number and date of the sections, and the derived values', () => {
    expect(buildReferences(input())).toEqual([
      { id: 'v1', label: 'First day of the period', value: '2026-10-01', format: { kind: 'date', grain: null } },
      { id: 'v2', label: 'Last day of the period', value: '2026-10-31', format: { kind: 'date', grain: null } },
      { id: 'v3', label: 'Total spending · Spend', value: 660.95, format: MONEY },
      { id: 'v4', label: 'By category · Groceries · Spend', value: 516.45, format: MONEY },
      { id: 'v5', label: 'By category · Dining · Spend', value: 144.5, format: MONEY },
      { id: 'v6', label: 'Share of spending · Groceries', value: 78.14, format: { kind: 'percent' } },
      { id: 'v7', label: 'Share of spending · Dining', value: 21.86, format: { kind: 'percent' } },
    ]);
  });

  it("names rows by position when values aren't shared", () => {
    const labels = buildReferences(input({ shareValues: false })).map((reference) => reference.label);
    expect(labels).toContain('By category · row 1 · Spend');
    expect(labels).toContain('Share of spending · row 2');
    expect(labels.some((label) => label.includes('Groceries'))).toBe(false);
  });
});

describe('checkSentence', () => {
  const references = new Map(buildReferences(input()).map((reference) => [reference.id, reference]));
  const years = new Set(['2026']);

  it('accepts references, words, and the years of the figures', () => {
    expect(checkSentence('In October 2026 you spent {v3}, {v6} of it on Groceries.', references, years)).toEqual([]);
  });

  it('rejects numbers it writes itself, unknown references, units, links and other years', () => {
    expect(checkSentence('You spent 660.95 in October.', references, years)).toEqual([
      '"You spent 660.95 in October." writes the number 660.95 itself; use a reference to a figure, or words.',
    ]);
    expect(checkSentence('You spent about 2000 in total.', references, years)[0]).toContain('writes the number 2000 itself');
    expect(checkSentence('Groceries took {v9}.', references, years)).toEqual(['"Groceries took {v9}." refers to {v9}, which isn\'t one of the figures.']);
    expect(checkSentence('Groceries took {v6}%.', references, years)[0]).toContain('puts a currency sign or %');
    expect(checkSentence('Spent €{v3}.', references, years)[0]).toContain('puts a currency sign or %');
    expect(checkSentence('See www.example.com for {v3}.', references, years)).toEqual(['"See www.example.com for {v3}." contains a link.']);
    expect(checkSentence(`${'Long '.repeat(90)}{v3}.`, references, years)[0]).toContain('longer than 400 characters');
  });

  it('takes the years from dated figures and today', () => {
    const dated: Reference[] = [{ id: 'v1', label: 'Day', value: '2024-03-02', format: { kind: 'date', grain: null } }];
    expect([...yearsOf(dated, '2026-11-17')].sort()).toEqual(['2024', '2026']);
  });
});

describe('finishNarrative', () => {
  it('puts the values in, and drops sentences that fail', () => {
    const references = buildReferences(input());
    expect(
      finishNarrative({ headline: 'You spent {v3} in October.', insights: ['Groceries took {v6}.', 'Dining was 144.50.', '  '] }, references, new Set(['2026'])),
    ).toEqual({
      headline: ['You spent ', { value: 660.95, format: MONEY }, ' in October.'],
      insights: [['Groceries took ', { value: 78.14, format: { kind: 'percent' } }, '.']],
    });
    expect(finishNarrative({ headline: 'You spent 5.', insights: [] }, references, new Set())).toBeNull();
  });
});

describe('writeNarrative', () => {
  const deps = (llm: ReturnType<typeof scriptedLlm>['llm']) => {
    const calls: string[] = [];
    return { calls, deps: { llm, cachePrefix: 'prefix', account: (records: readonly { stage: string }[]) => void calls.push(...records.map((call) => call.stage)) } };
  };

  it('writes the narrative from the figures, in one call', async () => {
    const { llm, requests } = scriptedLlm([{ output: { headline: 'You spent {v3} in October.', insights: ['Groceries took {v6}.'] } }]);
    const { calls, deps: narrativeDeps } = deps(llm);
    const narrative = await writeNarrative(input(), narrativeDeps);
    expect(narrative?.headline).toEqual(['You spent ', { value: 660.95, format: MONEY }, ' in October.']);
    expect(calls).toEqual(['narrative']);
    expect(requests[0]).toMatchObject({ stage: 'narrative', effort: 'medium', cachePrefix: 'prefix' });
    expect(requests[0]!.input).toContain('v4 = 516.45 (amount): By category · Groceries · Spend');
    expect(requests[0]!.input).toMatch(/<untrusted-figures-[0-9a-f]{16}>/);
  });

  it('retries once with the problems, then drops what still fails', async () => {
    const { llm, requests } = scriptedLlm([
      { output: { headline: 'You spent 660.95.', insights: ['Groceries took {v6}.'] } },
      { output: { headline: 'You spent 660.95 again.', insights: ['Groceries took {v6}.', 'Dining took {v7}.'] } },
    ]);
    const narrative = await writeNarrative(input(), deps(llm).deps);
    expect(requests[1]!.input).toContain('writes the number 660.95 itself');
    expect(narrative).toEqual({
      headline: null,
      insights: [
        ['Groceries took ', { value: 78.14, format: { kind: 'percent' } }, '.'],
        ['Dining took ', { value: 21.86, format: { kind: 'percent' } }, '.'],
      ],
    });
  });

  it('has no narrative when the LLM fails, or nothing was computed', async () => {
    const failing = scriptedLlm([{ fails: 'unavailable' }]);
    expect(await writeNarrative(input(), deps(failing.llm).deps)).toBeNull();
    const unused = scriptedLlm([]);
    const nothing = new Map<string, ComputedSection>([['total', { section: 'total', status: 'failed', columns: [], rows: [], truncated: false }]]);
    expect(await writeNarrative(input({ results: nothing, derived: [] }), deps(unused.llm).deps)).toBeNull();
    expect(unused.requests).toEqual([]);
  });
});
