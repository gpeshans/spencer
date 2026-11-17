import type { StructuredQuery } from '../plan/query';
import type { ColumnRole, ReportVocabulary } from './columns';
import type { ChartPoint, ChartSeries, ChartSpec, ReportStyles, ValueFormat } from './document';
import { isNumeric, toNumber } from './format';

/**
 * The chart of a section the plan wants drawn: which column runs along the x
 * axis, which values are series, and their colours. Shapes that wouldn't read
 * well as a chart get none, and the section shows its table instead.
 */

/** More series than this is a table, not a chart. */
export const MAX_SERIES = 10;
/** More bars than this is a line over time, or else a table. */
export const MAX_BARS = 40;
/** More slices than this is a bar chart. */
export const MAX_SLICES = 8;

export interface ChartInput {
  display: 'bar' | 'line' | 'pie';
  query: StructuredQuery | null;
  /** One per result column, in order. */
  roles: readonly ColumnRole[];
  rows: ReadonlyArray<Record<string, unknown>>;
  metrics: ReportVocabulary['metrics'];
  styles: ReportStyles;
  palette: readonly string[];
}

interface Layout {
  x: ColumnRole;
  /** A dimension whose values become the series. */
  split: ColumnRole | null;
  values: ColumnRole[];
}

const present = <T>(items: ReadonlyArray<T | undefined>): items is T[] => items.every((item) => item !== undefined);

function layoutOf({ query, roles }: ChartInput): Layout | null {
  const byKey = (key: string) => roles.find((role) => role.column.key === key);
  if (query?.shape === 'aggregate') {
    const values = query.metrics.map(byKey);
    const dimensions = query.dimensions.map(byKey);
    if (values.length === 0 || !present(values) || !present(dimensions)) return null;
    const time = roles.find((role) => role.time);
    if (time) {
      if (dimensions.length === 0) return { x: time, split: null, values };
      return dimensions.length === 1 && values.length === 1 ? { x: time, split: dimensions[0]!, values } : null;
    }
    if (dimensions.length === 1) return { x: dimensions[0]!, split: null, values };
    return dimensions.length === 2 && values.length === 1 ? { x: dimensions[0]!, split: dimensions[1]!, values } : null;
  }
  // A listing is a table.
  if (query) return null;
  // Without a structured query: one column of names or dates, then numbers.
  const values = roles.filter((role) => isNumeric(role.column.format));
  const others = roles.filter((role) => !isNumeric(role.column.format));
  return others.length === 1 && values.length > 0 ? { x: others[0]!, split: null, values } : null;
}

/**
 * A colour as #rgb, #rrggbb or #rrggbbaa. Colours can come from data people
 * edit (a category's colour), and the app writes them into a style sheet, so
 * anything else is dropped.
 */
export const isColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);

/** The key a value groups under: the database's text for it. */
const keyOf = (value: unknown) => (value === null || value === undefined ? '' : String(value));

const sameFormat = (a: ValueFormat, b: ValueFormat) => a.kind === b.kind;

/** A sum or count adds up across a split, so its bars can stack and its parts make its total. An average can't. */
export function additive(metric: string | null, metrics: ReportVocabulary['metrics']): boolean {
  const expression = metrics.find((candidate) => candidate.name === metric)?.expression;
  return expression !== undefined && /^\s*(sum|count)\s*\(/i.test(expression);
}

export function chartFor(input: ChartInput): ChartSpec | null {
  const layout = layoutOf(input);
  if (!layout) return null;
  const value = layout.values[0]!.column.format;
  if (!layout.values.every((role) => sameFormat(role.column.format, value))) return null;

  const { rows, styles, palette } = input;
  const colorAt = (index: number) => palette[index % palette.length]!;
  const xKey = layout.x.column.key;
  const timeX = layout.x.column.format.kind === 'date';
  let series: ChartSeries[];
  let points: ChartPoint[];

  if (!layout.split) {
    series = layout.values.map((role, index) => ({ key: `s${index}`, label: role.column.label, color: colorAt(index) }));
    points = rows.map((row) => ({
      x: row[xKey],
      values: Object.fromEntries(layout.values.map((role, index) => [`s${index}`, toNumber(row[role.column.key])])),
    }));
  } else {
    const split = layout.split;
    const valueKey = layout.values[0]!.column.key;
    const names = [...new Set(rows.map((row) => keyOf(row[split.column.key])))];
    if (names.length > MAX_SERIES) return null;
    const splitStyles = split.dimension ? styles[split.dimension] : undefined;
    series = names.map((name, index) => {
      const style = splitStyles?.[name];
      return { key: `s${index}`, label: style?.label ?? (name === '' ? '—' : name), color: isColor(style?.color) ? style.color : colorAt(index) };
    });
    const byX = new Map<string, ChartPoint>();
    for (const row of rows) {
      const at = keyOf(row[xKey]);
      let point = byX.get(at);
      if (!point) {
        point = { x: row[xKey], values: Object.fromEntries(series.map((entry) => [entry.key, null])) };
        byX.set(at, point);
      }
      point.values[series[names.indexOf(keyOf(row[split.column.key]))]!.key] = toNumber(row[valueKey]);
    }
    points = [...byX.values()];
  }
  if (series.length > MAX_SERIES) return null;

  // Time runs left to right, whatever order the query sorted it in. Dates are ISO
  // text, so plain text order is time order. A missing date goes last.
  if (timeX) {
    const rank = (point: ChartPoint) => (point.x === null || point.x === undefined ? '\uffff' : keyOf(point.x));
    points.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  }

  let type = input.display;
  const single = series.length === 1 && !layout.split;
  if (type === 'pie' && (!single || points.length > MAX_SLICES || points.some((point) => (point.values.s0 ?? 0) < 0))) {
    type = 'bar';
  }
  if (type === 'bar' && points.length > MAX_BARS) {
    if (!timeX) return null;
    type = 'line';
  }

  // The x values' own labels and colours: a bucket's name, a category's colour.
  const xStyles = layout.x.dimension ? styles[layout.x.dimension] : undefined;
  points.forEach((point, index) => {
    const style = xStyles?.[keyOf(point.x)];
    if (style?.label) point.label = style.label;
    // With one series, each bar or slice can wear its value's colour; slices always differ.
    if (!single) return;
    if (isColor(style?.color)) point.color = style.color;
    else if (type === 'pie') point.color = colorAt(index);
  });

  return {
    type,
    orientation: type === 'bar' && !timeX ? 'horizontal' : 'vertical',
    stacked: type === 'bar' && layout.split !== null && additive(layout.values[0]!.metric, input.metrics),
    x: layout.x.column,
    value,
    series,
    points,
  };
}
