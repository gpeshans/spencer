import { describe, expect, it } from 'vitest';

import type { ReportDocument, ReportSection } from '../report/document';
import { extent, labelEvery, niceTicks, pieSlices } from './geometry';
import { renderReportPdf } from './render';

describe('chart geometry', () => {
  it('spans zero and the values, summing stacks', () => {
    const points = [
      { x: 'a', values: { s0: 10, s1: 5 } },
      { x: 'b', values: { s0: -4, s1: null } },
    ];
    expect(extent({ points, stacked: false })).toEqual([-4, 10]);
    expect(extent({ points, stacked: true })).toEqual([-4, 15]);
    expect(extent({ points: [{ x: 'a', values: { s0: 3 } }], stacked: false })).toEqual([0, 3]);
  });

  it('picks round ticks', () => {
    expect(niceTicks(0, 1234.5)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(-50, 300)).toEqual([-100, 0, 100, 200, 300]);
    expect(niceTicks(0, 0.37)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(0, 3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(5, 5)).toEqual([0, 2, 4, 6]);
    expect(niceTicks(Number.NaN, 1)).toEqual([0, 1]);
  });

  it('thins labels to the room there is', () => {
    expect(labelEvery(12, 10)).toBe(2);
    expect(labelEvery(5, 10)).toBe(1);
    expect(labelEvery(100, 0)).toBe(100);
  });

  it('cuts slices clockwise from twelve o’clock, skipping empty ones', () => {
    const [first, empty, second] = pieSlices([1, 0, 1], 50, 50, 40, 20);
    expect(empty).toBeNull();
    // The first half starts straight up and ends straight down.
    expect(first).toMatch(/^M 50\.00 10\.00 A 40 40 0 0 1 50\.00 90\.00 L 50\.00 70\.00 A 20 20 0 0 0 50\.00 30\.00 Z$/);
    expect(second).toMatch(/^M 50\.00 90\.00 /);
    expect(pieSlices([-1, 0], 50, 50, 40)).toEqual([null, null]);
  });

  it('draws a whole circle as two halves', () => {
    const [whole] = pieSlices([7], 50, 50, 40);
    expect(whole!.match(/M /g)).toHaveLength(2);
  });
});

/** One section unverified, the rest checked. */
const withChecks = (sections: Array<Omit<ReportSection, 'verification'>>): ReportSection[] =>
  sections.map((section) => ({
    ...section,
    verification: section.id === 'by_category' ? 'unverified' : section.block.kind === 'text' || section.block.kind === 'failed' ? null : 'verified',
  }));

const report = (rows: number): ReportDocument => ({
  version: 2,
  title: 'October spending',
  summary: 'Where the money went.',
  request: 'How much did we spend in October?',
  status: 'partial',
  currency: 'EUR',
  period: { first: '2026-10-01', last: '2026-10-31' },
  comparison: { first: '2025-10-01', last: '2025-10-31' },
  assumptions: ['October means October 2026.'],
  narrative: {
    headline: ['You spent ', { value: 1234.5, format: { kind: 'money' } }, ' in October.'],
    insights: [['Groceries took ', { value: 24.3, format: { kind: 'percent' } }, ' of it.']],
  },
  sources: [
    { section: 'total', title: 'Total', summary: 'Spend, from 2026-10-01 to 2026-10-31.' },
    { section: 'by_category', title: 'By category', summary: 'Spending per category in October.' },
  ],
  sections: withChecks([
    { id: 'total', title: 'Total', description: 'All of October.', block: { kind: 'figures', figures: [{ label: 'Spend', value: 1234.5, format: { kind: 'money' } }] } },
    {
      id: 'by_category',
      title: 'By category',
      description: null,
      block: {
        kind: 'chart',
        chart: {
          type: 'bar',
          orientation: 'horizontal',
          stacked: false,
          x: { key: 'category', label: 'Category', format: { kind: 'text' } },
          value: { kind: 'money' },
          series: [{ key: 's0', label: 'Spend', color: '#1c7ed6' }],
          points: [
            { x: 'Groceries', color: '#2f9e44', values: { s0: 300 } },
            { x: 'Refunds', values: { s0: -20 } },
          ],
        },
        table: {
          columns: [
            { key: 'category', label: 'Category', format: { kind: 'text' } },
            { key: 'spend', label: 'Spend', format: { kind: 'money' } },
          ],
          rows: [
            { category: 'Groceries', spend: 300 },
            { category: 'Refunds', spend: -20 },
          ],
          truncated: false,
        },
      },
    },
    {
      id: 'trend',
      title: 'Trend',
      description: null,
      block: {
        kind: 'chart',
        chart: {
          type: 'line',
          orientation: 'vertical',
          stacked: false,
          x: { key: 'month', label: 'Month', format: { kind: 'date', grain: 'month' } },
          value: { kind: 'money' },
          series: [
            { key: 's0', label: 'Ada', color: '#ae3ec9' },
            { key: 's1', label: 'Bob', color: '#e8590c' },
          ],
          points: [
            { x: '2026-09-01', values: { s0: 10, s1: 4 } },
            { x: '2026-10-01', values: { s0: null, s1: 6 } },
          ],
        },
        table: { columns: [], rows: [], truncated: false },
      },
    },
    {
      id: 'shares',
      title: 'Shares',
      description: null,
      block: {
        kind: 'chart',
        chart: {
          type: 'pie',
          orientation: 'vertical',
          stacked: false,
          x: { key: 'bucket', label: 'Bucket', format: { kind: 'text' } },
          value: { kind: 'money' },
          series: [{ key: 's0', label: 'Spend', color: '#1c7ed6' }],
          points: [
            { x: 'needs', label: 'Needs', color: '#1971c2', values: { s0: 3 } },
            { x: 'wants', label: 'Wants', color: '#f08c00', values: { s0: 1 } },
          ],
        },
        table: { columns: [], rows: [], truncated: false },
      },
    },
    { id: 'note', title: 'Note', description: null, block: { kind: 'text', text: 'Refunds count as negative spending.' } },
    {
      id: 'list',
      title: 'Every expense',
      description: null,
      block: {
        kind: 'table',
        table: {
          columns: [
            { key: 'day', label: 'Day', format: { kind: 'date', grain: null } },
            { key: 'description', label: 'Description', format: { kind: 'text' } },
            { key: 'amount', label: 'Amount', format: { kind: 'money' } },
          ],
          rows: Array.from({ length: rows }, (_, index) => ({ day: '2026-10-01', description: `Expense ${index}`, amount: index })),
          truncated: 'rows',
        },
      },
    },
    { id: 'gone', title: 'Gone', description: null, block: { kind: 'failed' } },
    { id: 'none', title: 'None', description: null, block: { kind: 'empty' } },
  ]),
});

const pages = (pdf: Buffer) => pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;

describe('renderReportPdf', () => {
  it('renders every kind of section into a PDF', async () => {
    const pdf = await renderReportPdf(report(3), { locale: 'de-DE', brand: 'Spencer', asOf: '2026-11-17T13:05:00Z', timeZone: 'Europe/Berlin' });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pages(pdf)).toBeGreaterThanOrEqual(1);
  });

  it('runs a long table on over pages', async () => {
    const short = await renderReportPdf(report(3), { locale: 'de-DE' });
    const long = await renderReportPdf(report(200), { locale: 'de-DE' });
    expect(pages(long)).toBeGreaterThan(pages(short));
  });

  it('fetches nothing and links nowhere', async () => {
    const pdf = (await renderReportPdf(report(3), { locale: 'de-DE' })).toString('latin1');
    expect(pdf).not.toMatch(/\/URI|\/Subtype \/Image|\/Launch|\/JavaScript/);
  });
});
