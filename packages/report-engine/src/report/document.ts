import type { Grain } from '../plan/vocabulary';

/**
 * A finished report, ready to show (docs/report-engine-spec.md §8). The app's
 * page and the PDF both render this one document, so they always agree.
 *
 * Values stay as the database returned them; each column says how to show
 * them (`formatValue`), so the document carries no locale.
 */

export type ValueFormat =
  | { kind: 'money' }
  | { kind: 'count' }
  | { kind: 'number' }
  /** Percentage points: 12.5 shows as 12.5 %. */
  | { kind: 'percent' }
  /** A day, or the first day of a week, month, quarter or year. */
  | { kind: 'date'; grain: Grain | null }
  | { kind: 'timestamp' }
  | { kind: 'text' }
  | { kind: 'boolean' };

export interface ReportColumn {
  /** The result column's name. */
  key: string;
  label: string;
  format: ValueFormat;
}

export interface ReportTable {
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  /** Why rows were cut: too many rows, too many bytes, or not cut. */
  truncated: false | 'rows' | 'bytes';
}

export interface Figure {
  label: string;
  value: unknown;
  format: ValueFormat;
}

export interface ChartSeries {
  /** s0, s1, …: safe in a CSS custom property name. */
  key: string;
  label: string;
  color: string;
}

export interface ChartPoint {
  /** The x value as the result has it: a name, or a date. */
  x: unknown;
  /** Shown instead of the formatted x value, e.g. a budget bucket's name. */
  label?: string;
  /** A colour of its own: one bar of a single series, or a pie slice. */
  color?: string;
  /** By series key. */
  values: Record<string, number | null>;
}

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie';
  /** Bars stand up from the x axis (vertical) or run across the page (horizontal). */
  orientation: 'vertical' | 'horizontal';
  /** Bars of several series stack, rather than stand side by side. */
  stacked: boolean;
  x: ReportColumn;
  /** How every series' values are shown. */
  value: ValueFormat;
  series: ChartSeries[];
  points: ChartPoint[];
}

export type ReportBlock =
  | { kind: 'figures'; figures: Figure[] }
  /** The chart, and its numbers as a table. */
  | { kind: 'chart'; chart: ChartSpec; table: ReportTable }
  | { kind: 'table'; table: ReportTable }
  | { kind: 'text'; text: string }
  /** The query ran and found nothing. */
  | { kind: 'empty' }
  /** The section couldn't be computed. Why is in the run, not in the report. */
  | { kind: 'failed' };

export interface ReportSection {
  id: string;
  title: string;
  /** One plain sentence on what the numbers are. */
  description: string | null;
  block: ReportBlock;
}

export interface ReportDocument {
  version: 1;
  title: string;
  summary: string;
  /** The question, as asked. */
  request: string;
  /** partial: some sections couldn't be computed. */
  status: 'succeeded' | 'partial';
  /** ISO 4217 code that every money value is in. */
  currency: string;
  sections: ReportSection[];
}

/** Labels and colours for a dimension's values, e.g. a category's colour. */
export interface ValueStyle {
  label?: string;
  color?: string;
}

/** By dimension name, then by value as the database returns it. */
export type ReportStyles = Readonly<Record<string, Readonly<Record<string, ValueStyle>>>>;
