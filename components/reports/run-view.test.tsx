import { newRun, type RunState } from 'report-engine';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunView } from './run-view';

const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };
const later = new Date(Date.now() + 3_600_000).toISOString();

const plan: NonNullable<RunState['plan']> = {
  title: 'October spending',
  summary: 'Spending per category in October.',
  sections: [
    {
      id: 'by_category',
      title: 'By category',
      purpose: 'Where the money went.',
      display: 'bar',
      query: { shape: 'aggregate', relation: 'reporting.spendings', metrics: ['spend'], dimensions: ['category'], grain: null, filters: [], period: OCTOBER, sort: [], limit: null },
      essential: true,
    },
    { id: 'big_days', title: 'Big days', purpose: 'Days over 100.', display: 'table', query: null, essential: false },
  ],
  derived: [],
  crossChecks: [],
};

const base = (fields: Partial<RunState>): RunState => ({
  ...newRun('3f0c7a52-6b1e-4d2a-9c8e-1b2a3c4d5e6f', 'How much did we spend per category in October?'),
  ...fields,
});

const render = (run: RunState) =>
  renderToStaticMarkup(<RunView run={run} sending={false} onAnswer={() => {}} onApprove={() => {}} onReject={() => {}} />);

describe('RunView', () => {
  it('shows where a working run is', () => {
    const html = render(base({ status: 'planning', stage: 'checking' }));
    expect(html).toContain('How much did we spend per category in October?');
    expect(html).toContain('Checking the data');
    expect(html).toContain('Planning the report');
    expect(html).not.toContain('Writing the SQL');
  });

  it('asks the open question with its options', () => {
    const html = render(
      base({
        status: 'needs_clarification',
        pendingUntil: later,
        clarifications: [{ question: 'Which month?', options: ['October', 'November'], answer: null, askedAt: later }],
      }),
    );
    expect(html).toContain('Which month?');
    expect(html).toContain('October');
    expect(html).toContain('Or answer in your own words');
  });

  it('shows the plan, why it asks, and the way to approve it', () => {
    const html = render(
      base({
        status: 'awaiting_approval',
        plan,
        planHash: 'a'.repeat(64),
        pendingUntil: later,
        approval: { reasons: ['The plan has 5 sections, more than 4.'], estimateUsd: 0.21 },
      }),
    );
    expect(html).toContain('October spending');
    expect(html).toContain('The plan has 5 sections, more than 4.');
    expect(html).toContain('Bar chart');
    expect(html).toContain('Approve and run');
    expect(html).toContain('$0.21');
  });

  it("won't offer an approval that has expired", () => {
    const html = render(base({ status: 'awaiting_approval', plan, pendingUntil: '2020-01-01T00:00:00.000Z' }));
    expect(html).toContain('has expired');
    expect(html).not.toContain('Approve and run');
  });

  it('shows the rows, the SQL, and why a section failed', () => {
    const html = render(
      base({
        status: 'partial',
        plan,
        unchecked: ['big_days'],
        results: [
          {
            section: 'by_category',
            status: 'ok',
            sql: 'select category_label as category, sum(amount) as spend from reporting.spendings',
            params: ['2026-10-01', '2026-11-01'],
            summary: 'Spending per category.',
            columns: [
              { name: 'category', type: 'text' },
              { name: 'spend', type: 'number' },
            ],
            rows: [{ category: 'Groceries', spend: 412.5 }],
            truncated: false,
            attempts: 1,
            problems: [],
          },
          {
            section: 'big_days',
            status: 'failed',
            sql: null,
            params: [],
            summary: null,
            columns: [],
            rows: [],
            truncated: false,
            attempts: 3,
            problems: ['No SQL was written for this section.'],
          },
        ],
      }),
    );
    expect(html).toContain('Groceries');
    expect(html).toMatch(/412[.,]5/);
    expect(html).toContain('select category_label as category');
    expect(html).toContain('No SQL was written for this section.');
    expect(html).toContain('Some sections couldn’t be computed');
  });

  it('explains a failure with its details', () => {
    const html = render(
      base({
        status: 'failed',
        error: {
          stage: 'checking',
          code: 'infeasible',
          message: 'reporting.spendings has no data from 2026-10-01 to 2026-10-31.',
          details: ['Ask about 2026-03-01 to 2026-08-31, where reporting.spendings has data.'],
        },
      }),
    );
    expect(html).toContain('has no data from 2026-10-01');
    expect(html).toContain('Ask about 2026-03-01 to 2026-08-31');
  });
});
