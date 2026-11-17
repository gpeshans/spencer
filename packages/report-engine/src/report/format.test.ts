import { describe, expect, it } from 'vitest';

import { formatValue, isNumeric, reportFileName, toNumber } from './format';

const DE = { locale: 'de-DE', currency: 'EUR' };
const money = { kind: 'money' } as const;
const intl = (options: Intl.NumberFormatOptions, value: number, locale = 'de-DE') =>
  new Intl.NumberFormat(locale, options).format(value);

describe('formatValue', () => {
  it('shows money in the currency, the way the app does', () => {
    expect(formatValue(1234.5, money, DE)).toBe(intl({ style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }, 1234.5));
    expect(formatValue(1234.5, money, DE)).toMatch(/^1\.234,50\s€$/);
    expect(formatValue('1234.5', money, DE)).toMatch(/^1\.234,50\s€$/);
    expect(formatValue(-12, money, DE)).toMatch(/^-12,00\s€$/);
    expect(formatValue(1234.5, money, { locale: 'en-US', currency: 'USD' })).toBe('$1,234.50');
  });

  it('drops the cents on chart axes', () => {
    expect(formatValue(1234.5, money, { ...DE, compact: true })).toMatch(/^1\.235\s€$/);
  });

  it('shows counts, numbers and percentages', () => {
    expect(formatValue(1234, { kind: 'count' }, DE)).toBe('1.234');
    expect(formatValue(2.5, { kind: 'count' }, DE)).toBe('3');
    expect(formatValue(3.14159, { kind: 'number' }, DE)).toBe('3,14');
    expect(formatValue(12.5, { kind: 'percent' }, DE)).toBe(intl({ style: 'percent', maximumFractionDigits: 1 }, 0.125));
    expect(formatValue(12.5, { kind: 'percent' }, DE)).toMatch(/^12,5\s%$/);
  });

  it('shows a date at its grain, without shifting it', () => {
    const date = (grain: 'day' | 'week' | 'month' | 'quarter' | 'year' | null, compact = false) =>
      formatValue('2026-10-01', { kind: 'date', grain }, { ...DE, compact });
    expect(date(null)).toBe('01.10.2026');
    expect(date('day')).toBe('01.10.2026');
    expect(date('week')).toBe('01.10.2026');
    expect(date('month')).toBe('Oktober 2026');
    expect(date('month', true)).toBe('Okt. 2026');
    expect(date('quarter')).toBe('Q4 2026');
    expect(date('year')).toBe('2026');
    expect(formatValue('2026-01-01', { kind: 'date', grain: 'month' }, { locale: 'en-US', currency: 'USD' })).toBe('January 2026');
    expect(formatValue('0044-03-15', { kind: 'date', grain: 'year' }, DE)).toBe('44');
  });

  it('shows a timestamp as the server wrote it, in its own time zone', () => {
    expect(formatValue('2026-10-14 09:30:00+02', { kind: 'timestamp' }, DE)).toBe('14.10.2026, 09:30');
    expect(formatValue('2026-12-31T23:59:59.5+01', { kind: 'timestamp' }, DE)).toBe('31.12.2026, 23:59');
  });

  it('shows missing and odd values plainly', () => {
    expect(formatValue(null, money, DE)).toBe('—');
    expect(formatValue(undefined, { kind: 'text' }, DE)).toBe('—');
    expect(formatValue('NaN', money, DE)).toBe('NaN');
    expect(formatValue('infinity', { kind: 'date', grain: 'month' }, DE)).toBe('infinity');
    expect(formatValue(true, { kind: 'boolean' }, DE)).toBe('Yes');
    expect(formatValue(false, { kind: 'boolean' }, DE)).toBe('No');
    expect(formatValue({ a: 1 }, { kind: 'text' }, DE)).toBe('{"a":1}');
    expect(formatValue('Groceries', { kind: 'text' }, DE)).toBe('Groceries');
  });
});

describe('helpers', () => {
  it('reads numbers from numbers and numeric text only', () => {
    expect(toNumber(12.5)).toBe(12.5);
    expect(toNumber('12.50')).toBe(12.5);
    expect(toNumber('')).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(null)).toBeNull();
  });

  it('knows which formats are numbers', () => {
    expect(isNumeric({ kind: 'money' })).toBe(true);
    expect(isNumeric({ kind: 'percent' })).toBe(true);
    expect(isNumeric({ kind: 'date', grain: 'month' })).toBe(false);
    expect(isNumeric({ kind: 'text' })).toBe(false);
  });

  it('names a download safely', () => {
    expect(reportFileName('October spending', '2026-11-17')).toBe('october-spending-2026-11-17.pdf');
    expect(reportFileName('Ausgaben: Grüße & Spaß!', '2026-11-17')).toBe('ausgaben-grusse-spass-2026-11-17.pdf');
    expect(reportFileName('Расходы', '2026-11-17')).toBe('report-2026-11-17.pdf');
    expect(reportFileName('"quoted"\r\nheader', 'not a day')).toBe('quoted-header.pdf');
    expect(reportFileName('x'.repeat(100), '2026-11-17')).toBe(`${'x'.repeat(60)}-2026-11-17.pdf`);
  });
});
