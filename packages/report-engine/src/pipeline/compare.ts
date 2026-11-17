import type { QueryColumn } from '../pg';
import { toNumber } from '../report/format';

/**
 * The compiled cross-check's comparison (docs/report-engine-spec.md §4, stage
 * 7): do the LLM's SQL and the SQL compiled from the plan return the same
 * result? Both name their columns after the plan, so rows compare column by
 * column, in any order. Numbers may differ by rounding, and a missing sum is
 * nothing spent; everything else must be equal.
 */

export interface ComparedResult {
  columns: readonly QueryColumn[];
  rows: ReadonlyArray<Record<string, unknown>>;
}

export type Comparison = { verdict: 'match' } | { verdict: 'mismatch'; detail: string };

/** Half a cent: an average rounded to two places still matches. */
const TOLERANCE = 0.005;
const NUMERIC = new Set(['integer', 'number']);

const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE + 1e-9 * Math.max(Math.abs(a), Math.abs(b));

const NULL = '\u0000null';
const asText = (value: unknown): string =>
  value === null || value === undefined ? NULL : typeof value === 'object' ? JSON.stringify(value) : String(value);

interface Normalized {
  key: string[];
  numbers: number[];
}

function compareNormalized(a: Normalized, b: Normalized): number {
  for (let index = 0; index < a.key.length; index += 1) {
    if (a.key[index] !== b.key[index]) return a.key[index]! < b.key[index]! ? -1 : 1;
  }
  for (let index = 0; index < a.numbers.length; index += 1) {
    // Rounded to the cent, so values that differ by rounding sort alike.
    const [x, y] = [Math.round(a.numbers[index]! * 100), Math.round(b.numbers[index]! * 100)];
    if (x !== y) return x - y;
  }
  return 0;
}

export function compareResults(llm: ComparedResult, compiled: ComparedResult): Comparison {
  const mismatch = (detail: string): Comparison => ({ verdict: 'mismatch', detail });
  const names = [...new Set(llm.columns.map((column) => column.name))].sort();
  const other = [...new Set(compiled.columns.map((column) => column.name))].sort();
  if (names.join('\u0000') !== other.join('\u0000')) return mismatch(`columns ${names.join(', ')}, against ${other.join(', ')}`);
  if (llm.rows.length !== compiled.rows.length) return mismatch(`${llm.rows.length} rows, against ${compiled.rows.length}`);

  const numeric = new Set([...llm.columns, ...compiled.columns].filter((column) => NUMERIC.has(column.type)).map((column) => column.name));
  const keys = names.filter((name) => !numeric.has(name));
  const values = names.filter((name) => numeric.has(name));
  // A sum over no rows is null where the other side may say 0.
  const normalize = (row: Record<string, unknown>): Normalized => ({
    key: keys.map((name) => asText(row[name])),
    numbers: values.map((name) => toNumber(row[name]) ?? 0),
  });
  const left = llm.rows.map(normalize).sort(compareNormalized);
  const right = compiled.rows.map(normalize).sort(compareNormalized);

  const describe = (row: Normalized) =>
    keys.length === 0 ? 'the total' : keys.map((name, index) => `${name} ${row.key[index] === NULL ? 'empty' : row.key[index]}`).join(', ');
  for (let index = 0; index < left.length; index += 1) {
    const [a, b] = [left[index]!, right[index]!];
    if (a.key.some((part, at) => part !== b.key[at])) return mismatch(`a row with ${describe(a)}, against one with ${describe(b)}`);
    for (let at = 0; at < values.length; at += 1) {
      if (!near(a.numbers[at]!, b.numbers[at]!)) return mismatch(`${describe(a)}: ${values[at]} ${a.numbers[at]}, against ${b.numbers[at]}`);
    }
  }
  return { verdict: 'match' };
}
