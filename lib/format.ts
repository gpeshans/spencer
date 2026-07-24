import {
  addMonths,
  addYears,
  endOfMonth,
  endOfYear,
  format,
  parseISO,
  startOfMonth,
  startOfYear,
} from 'date-fns';

const LOCALE = process.env.NEXT_PUBLIC_LOCALE || 'de-DE';
export const DEFAULT_CURRENCY = process.env.NEXT_PUBLIC_CURRENCY || 'EUR';
export const APP_TIMEZONE = process.env.NEXT_PUBLIC_TIMEZONE || 'Europe/Berlin';

/** Today's date as 'yyyy-MM-dd' in the app's timezone (not the server's). */
export function todayISO(tz: string = APP_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** First day of the current month as 'yyyy-MM-01' in the app's timezone. */
export function currentMonthStartISO(tz: string = APP_TIMEZONE): string {
  return `${todayISO(tz).slice(0, 7)}-01`;
}

/** Format a number as currency (default EUR, de-DE grouping). */
export function formatMoney(
  amount: number | string | null | undefined,
  currency: string = DEFAULT_CURRENCY,
): string {
  const n = typeof amount === 'string' ? Number(amount) : amount ?? 0;
  const safe = Number.isFinite(n) ? (n as number) : 0;
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(safe);
}

// The decimal separator for the app's locale ("," for de-DE, "." for en-US).
const DECIMAL_SEP =
  new Intl.NumberFormat(LOCALE).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? '.';

/**
 * Parse a user-typed amount using the app locale's convention, so a value the
 * UI displays round-trips. de-DE ("." groups, "," decimals): "3.500" -> 3500,
 * "3.500,50" -> 3500.5, "12,50" -> 12.5. en ("," groups, "." decimals):
 * "3,500.50" -> 3500.5. Returns NaN when empty/invalid.
 */
export function parseAmount(raw: string): number {
  let s = raw.trim().replace(/[^\d.,]/g, '');
  if (DECIMAL_SEP === ',') {
    s = s.replace(/\./g, '').replace(',', '.'); // "." groups, "," is the decimal
  } else {
    s = s.replace(/,/g, ''); // "," groups, "." is the decimal
  }
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** A Postgres `date` string ('yyyy-MM-dd') or a Date -> Date. */
export function toDate(d: string | Date): Date {
  return typeof d === 'string' ? parseISO(d) : d;
}

/** e.g. "Mon, 14 July" — used as the day group heading in lists. */
export function formatDayHeading(d: string | Date): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(toDate(d));
}

/** e.g. "July 2026" — used as month titles. */
export function formatMonthTitle(d: Date): string {
  return new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }).format(d);
}

/** e.g. "14.07.2026". */
export function formatShortDate(d: string | Date): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(toDate(d));
}

/** 'yyyy-MM-dd' — for query bounds and inserts. */
export const isoDate = (d: Date): string => format(d, 'yyyy-MM-dd');

/** Inclusive month bounds as ISO date strings. */
export function monthRange(d: Date): { start: string; end: string } {
  return { start: isoDate(startOfMonth(d)), end: isoDate(endOfMonth(d)) };
}

/** Inclusive year bounds as ISO date strings. */
export function yearRange(d: Date): { start: string; end: string } {
  return { start: isoDate(startOfYear(d)), end: isoDate(endOfYear(d)) };
}

export { addMonths, addYears, startOfMonth, startOfYear };
