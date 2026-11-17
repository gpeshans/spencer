import { newRun, type RunState, type SemanticModel } from 'report-engine';
import { buildVocabulary } from 'report-engine/report';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ReportPresentation } from '@/lib/reports/presentation';
import modelFile from '@/supabase/reporting/semantic-model.json';

import { RunView } from './run-view';

const { relations, metrics, dimensions } = buildVocabulary(modelFile as unknown as SemanticModel);
const presentation: ReportPresentation = {
  vocabulary: { relations, metrics, dimensions },
  styles: { category: { Groceries: { color: '#2f9e44' } } },
};

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
  renderToStaticMarkup(
    <RunView run={run} presentation={presentation} sending={false} onAnswer={() => {}} onApprove={() => {}} onReject={() => {}} />,
  );

/** The part of the page after the collapsed "Details" line, and the part before it. */
const split = (html: string) => {
  const at = html.indexOf('>Details</summary>');
  return at < 0 ? { body: html, details: '' } : { body: html.slice(0, at), details: html.slice(at) };
};

describe('RunView', () => {
  it('shows where a working run is', () => {
    const html = render(base({ status: 'planning', stage: 'checking' }));
    expect(html).toContain('How much did we spend per category in October?');
    expect(html).toContain('Checking the data');
    expect(html).toContain('Planning the report');
    expect(html).not.toContain('Writing the queries');
    expect(html).not.toMatch(/SQL/);
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

  it('shows the report in the currency, with a chart and the PDF, and keeps the internals out of sight', () => {
    const html = render(
      base({
        status: 'partial',
        plan,
        unchecked: ['big_days'],
        costUsd: 0.1234,
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
    const { body, details } = split(html);
    expect(body).toContain('Groceries');
    expect(body).toMatch(/412,50\s€/);
    expect(body).toContain('Show the numbers');
    expect(body).toContain('Download PDF');
    expect(body).toContain('Some sections couldn’t be computed');
    expect(body).toContain('couldn’t be computed.');
    // The SQL stays in the logs; cost and the failure's cause wait in Details.
    expect(html).not.toContain('select category_label');
    expect(html).not.toContain('2026-11-01');
    expect(html).not.toContain('cross-check');
    expect(body).not.toContain('$0.12');
    expect(body).not.toContain('No SQL was written');
    expect(details).toContain('$0.12');
    expect(details).toContain('Big days couldn’t be computed:');
    expect(details).toContain('No SQL was written for this section.');
  });

  it('shows the narrative, the period and how far the numbers are checked', () => {
    const html = render(
      base({
        status: 'succeeded',
        plan,
        intent: {
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
        },
        narrative: {
          headline: ['You spent ', { value: 412.5, format: { kind: 'money' } }, ' in October.'],
          insights: [['Groceries took ', { value: 100, format: { kind: 'percent' } }, ' of it.']],
        },
        results: [
          {
            section: 'by_category',
            status: 'ok',
            sql: 'select …',
            params: [],
            summary: 'Spend by category, from 2026-10-01 to 2026-10-31.',
            columns: [
              { name: 'category', type: 'text' },
              { name: 'spend', type: 'number' },
            ],
            rows: [{ category: 'Groceries', spend: 412.5 }],
            truncated: false,
            attempts: 1,
            problems: [],
            source: 'compiled',
            check: 'mismatch',
          },
          {
            section: 'big_days',
            status: 'ok',
            sql: 'select …',
            params: [],
            summary: 'Days over 100.',
            columns: [{ name: 'day', type: 'date' }],
            rows: [{ day: '2026-10-01' }],
            truncated: false,
            attempts: 1,
            problems: [],
            source: 'llm',
            check: 'none',
          },
        ],
      }),
    );
    expect(html).toMatch(/You spent 412,50\s€ in October\./);
    expect(html).toMatch(/Groceries took 100\s%/);
    expect(html).toContain('October means October 2026.');
    expect(html).toMatch(/1\.–31\. Okt\. 2026/);
    // The section the compiled SQL checked has no badge; the one nothing could check has.
    expect(html.match(/>Unverified</g)).toHaveLength(1);
    expect(html).toContain('How these numbers were computed');
    expect(html).toContain('Spend by category, from 2026-10-01 to 2026-10-31.');
  });

  it('shows the checking and writing steps while a run finishes', () => {
    const html = render(base({ status: 'executing', stage: 'narrating', plan }));
    expect(html).toContain('Checking the numbers');
    expect(html).toContain('Writing the summary');
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

  it('keeps the inner workings of a failure in Details', () => {
    const { body, details } = split(
      render(
        base({
          status: 'failed',
          costUsd: 0.05,
          error: { stage: 'planning', code: 'invalid_output', message: "Couldn't make a valid plan.", details: ['sections.0.query: unknown view'] },
        }),
      ),
    );
    expect(body).toContain('make a valid plan.');
    expect(body).not.toContain('unknown view');
    expect(details).toContain('sections.0.query: unknown view');
    expect(details).toContain('$0.050');
  });

  it('shows no Details when there is nothing to tell', () => {
    expect(render(base({ status: 'planning', stage: 'understanding' }))).not.toContain('Details');
  });
});
