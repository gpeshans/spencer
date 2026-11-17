import type { NarrativeText, ReportPeriod, ValueFormat } from './document';

/**
 * Shows a report value the way its column says: money in the report's currency,
 * dates at their grain, and so on. The app's page and the PDF both use this, so
 * a value reads the same in both.
 */

export interface FormatOptions {
  /** BCP 47, e.g. de-DE. */
  locale: string;
  /** ISO 4217, e.g. EUR: the currency of every money value. */
  currency: string;
  /** Shorter forms, for chart axes and labels: no cents, short month names. */
  compact?: boolean;
}

/** Shown for a missing value. */
export const MISSING = '—';

const formatters = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter as Intl.NumberFormat;
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    // Dates are built in UTC from the server's text, so nothing shifts with the time zone.
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    formatters.set(key, formatter);
  }
  return formatter as Intl.DateTimeFormat;
}

/** The day before an ISO date: the last day of a period whose `to` is not included. */
export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** A finite number, from a number or numeric text; null for anything else. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/;

function parseDate(value: unknown, withTime: boolean): Date | null {
  if (typeof value !== 'string') return null;
  const match = DAY.exec(value);
  if (!match || (withTime && match[4] === undefined)) return null;
  const [year, month, day, hour, minute] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number];
  // setUTCFullYear, not Date.UTC, which reads years 0-99 as 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(withTime ? hour : 0, withTime ? minute : 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value: unknown, format: Extract<ValueFormat, { kind: 'date' }>, { locale, compact }: FormatOptions): string {
  const date = parseDate(value, false);
  if (!date) return String(value);
  switch (format.grain) {
    case 'year':
      return String(date.getUTCFullYear());
    case 'quarter':
      return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
    case 'month':
      return dateFormat(locale, { month: compact ? 'short' : 'long', year: 'numeric' }).format(date);
    default:
      // A day, or the first day of a week.
      return compact
        ? dateFormat(locale, { day: 'numeric', month: 'short' }).format(date)
        : dateFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  }
}

export function formatValue(value: unknown, format: ValueFormat, options: FormatOptions): string {
  if (value === null || value === undefined) return MISSING;
  const { locale, currency, compact = false } = options;
  switch (format.kind) {
    case 'money':
    case 'count':
    case 'number':
    case 'percent': {
      const number = toNumber(value);
      if (number === null) return String(value);
      if (format.kind === 'money') {
        // The same options as the app's formatMoney, so a report's amounts match its other screens.
        return numberFormat(
          locale,
          compact
            ? { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }
            : { style: 'currency', currency, maximumFractionDigits: 2 },
        ).format(number);
      }
      if (format.kind === 'percent') {
        return numberFormat(locale, { style: 'percent', maximumFractionDigits: compact ? 0 : 1 }).format(number / 100);
      }
      return numberFormat(locale, { maximumFractionDigits: format.kind === 'count' || compact ? 0 : 2 }).format(number);
    }
    case 'date':
      return formatDate(value, format, options);
    case 'timestamp': {
      // The server's text is already in the session's time zone.
      const date = parseDate(value, true);
      return date
        ? dateFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
        : String(value);
    }
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'text':
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** A period as its days: "1–31 Oct 2026", or one day when it is one. */
export function formatPeriod(period: ReportPeriod, { locale }: Pick<FormatOptions, 'locale'>): string {
  const [first, last] = [parseDate(period.first, false), parseDate(period.last, false)];
  if (!first || !last) return `${period.first} – ${period.last}`;
  const days = dateFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  return first.getTime() === last.getTime() ? days.format(first) : days.formatRange(first, last);
}

/** The narrative's words with its values in their formats. */
export function formatNarrative(text: NarrativeText, options: FormatOptions): string {
  return text.map((part) => (typeof part === 'string' ? part : formatValue(part.value, part.format, options))).join('');
}

/** Whether values in this format are numbers, shown right-aligned and charted. */
export function isNumeric(format: ValueFormat): boolean {
  return format.kind === 'money' || format.kind === 'count' || format.kind === 'number' || format.kind === 'percent';
}

/**
 * A safe download name: the title as lowercase ASCII words joined by dashes,
 * then the day, e.g. `october-spending-2026-11-17.pdf`.
 */
export function reportFileName(title: string, day: string): string {
  const slug = title
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? `-${day}` : '';
  return `${slug || 'report'}${date}.pdf`;
}
