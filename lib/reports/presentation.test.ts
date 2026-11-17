import { formatValue } from 'report-engine/report';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CURRENCY, formatMoney, LOCALE } from '@/lib/format';

vi.mock('@/lib/categories-data', () => ({
  getCategories: async () => ({
    expense: [
      { key: 'groceries', label: 'Groceries', color: '#2f9e44' },
      { key: 'odd', label: 'Odd', color: 'red; } body { display: none' },
    ],
    income: [{ key: 'salary', label: 'Salary', color: '#1c7ed6' }],
  }),
}));

vi.mock('@/lib/session', () => ({
  getGroupContext: async () => ({
    members: [
      { id: 'a', display_name: 'Ada', email: 'ada@example.com', avatar_url: null },
      { id: 'n', display_name: null, email: 'nameless@example.com', avatar_url: null },
      { id: 'b', display_name: 'Bob', email: 'bob@example.com', avatar_url: null },
    ],
  }),
}));

const { reportStyles, reportVocabulary } = await import('./presentation');

describe('reportStyles', () => {
  it("gives values Spencer's own labels and colours", async () => {
    const styles = await reportStyles();
    // A colour that isn't hex never reaches a chart's style sheet.
    expect(styles.category).toEqual({ Groceries: { color: '#2f9e44' } });
    expect(styles.income_category).toEqual({ Salary: { color: '#1c7ed6' } });
    expect(styles.bucket).toMatchObject({
      needs: { label: 'Needs', color: '#1971c2' },
      savings: { label: 'Savings & Investments' },
    });
    // Slots by join order, as on the member charts; a member without a display name has none to match.
    expect(styles.member).toEqual({ Ada: { color: '#ae3ec9' }, Bob: { color: '#0ca678' } });
  });
});

describe('reportVocabulary', () => {
  it('carries the units a report formats by, as plain data', () => {
    const vocabulary = reportVocabulary();
    const amount = vocabulary.relations.find((relation) => relation.name === 'reporting.spendings')?.columns.find((column) => column.name === 'amount');
    expect(amount).toEqual({ name: 'amount', kind: 'number', unit: 'currency' });
    expect(vocabulary.metrics.find((metric) => metric.name === 'spend')?.unit).toBe('currency');
    expect(JSON.parse(JSON.stringify(vocabulary))).toEqual(vocabulary);
  });
});

describe('money in reports', () => {
  it('reads exactly as on the rest of the app', () => {
    for (const amount of [0, 12.5, 1234.56, -80, 1e6]) {
      expect(formatValue(amount, { kind: 'money' }, { locale: LOCALE, currency: DEFAULT_CURRENCY })).toBe(formatMoney(amount));
    }
  });
});
