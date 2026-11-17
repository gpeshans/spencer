import { describe, expect, it } from 'vitest';

import type { QueryColumn } from '../pg';
import { compareResults } from './compare';

const COLUMNS: QueryColumn[] = [
  { name: 'category', type: 'text' },
  { name: 'spend', type: 'number' },
];
const result = (rows: Array<Record<string, unknown>>, columns = COLUMNS) => ({ columns, rows });

describe('compareResults', () => {
  const rows = [
    { category: 'Groceries', spend: 516.45 },
    { category: 'Dining', spend: 144.5 },
  ];

  it('matches the same rows in any order, numbers from text or numbers', () => {
    expect(compareResults(result(rows), result([...rows].reverse()))).toEqual({ verdict: 'match' });
    expect(compareResults(result(rows), result(rows.map((row) => ({ ...row, spend: row.spend.toFixed(2) }))))).toEqual({ verdict: 'match' });
  });

  it('allows rounding to the cent, and an integer against a number', () => {
    const counted: QueryColumn[] = [{ name: 'expense_count', type: 'integer' }];
    expect(compareResults(result([{ expense_count: 51 }], counted), result([{ expense_count: '51' }], [{ name: 'expense_count', type: 'number' }]))).toEqual({
      verdict: 'match',
    });
    const averages: QueryColumn[] = [{ name: 'average_expense', type: 'number' }];
    expect(compareResults(result([{ average_expense: 45.67 }], averages), result([{ average_expense: '45.6709803921568627' }], averages))).toEqual({
      verdict: 'match',
    });
    expect(compareResults(result([{ average_expense: 45.68 }], averages), result([{ average_expense: 45.6709 }], averages)).verdict).toBe('mismatch');
  });

  it('treats a missing sum as nothing spent', () => {
    const total: QueryColumn[] = [{ name: 'spend', type: 'number' }];
    expect(compareResults(result([{ spend: null }], total), result([{ spend: 0 }], total))).toEqual({ verdict: 'match' });
  });

  it('says what differs', () => {
    expect(compareResults(result(rows), result([{ category: 'Groceries', spend: 516.45 }, { category: 'Dining', spend: 150 }]))).toEqual({
      verdict: 'mismatch',
      detail: 'category Dining: spend 144.5, against 150',
    });
    expect(compareResults(result(rows), result(rows.slice(1)))).toEqual({ verdict: 'mismatch', detail: '2 rows, against 1' });
    expect(compareResults(result(rows), result([{ category: 'Groceries', spend: 516.45 }, { category: 'Travel', spend: 144.5 }]))).toEqual({
      verdict: 'mismatch',
      detail: 'a row with category Dining, against one with category Groceries',
    });
    expect(compareResults(result(rows), result([{ spend: 1 }], [{ name: 'spend', type: 'number' }]))).toEqual({
      verdict: 'mismatch',
      detail: 'columns category, spend, against spend',
    });
    expect(compareResults(result([{ category: null, spend: 1 }]), result([{ category: 'Other', spend: 1 }]))).toMatchObject({
      detail: 'a row with category empty, against one with category Other',
    });
  });

  it('compares a total and listings with repeated text', () => {
    const total: QueryColumn[] = [{ name: 'spend', type: 'number' }];
    expect(compareResults(result([{ spend: 10 }], total), result([{ spend: 11 }], total))).toEqual({
      verdict: 'mismatch',
      detail: 'the total: spend 10, against 11',
    });
    const listing: QueryColumn[] = [
      { name: 'description', type: 'text' },
      { name: 'amount', type: 'number' },
    ];
    const bought = [
      { description: 'Supermarket', amount: 30 },
      { description: 'Supermarket', amount: 12.5 },
    ];
    expect(compareResults(result(bought, listing), result([...bought].reverse(), listing))).toEqual({ verdict: 'match' });
  });
});
