/**
 * How result values come out of the executor.
 *
 * Dates, times and timestamps keep the server's text (ISO style, in the
 * session time zone), so nothing shifts with the Node process's time zone.
 * numeric and int8 become numbers when that loses nothing, and stay text
 * otherwise.
 */

export type ColumnType =
  | 'boolean'
  | 'integer'
  | 'number'
  | 'text'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'interval'
  | 'uuid'
  | 'json'
  | 'unknown';

const TYPE_BY_OID: ReadonlyMap<number, ColumnType> = new Map([
  [16, 'boolean'],
  [20, 'integer'],
  [21, 'integer'],
  [23, 'integer'],
  [700, 'number'],
  [701, 'number'],
  [1700, 'number'],
  [19, 'text'],
  [25, 'text'],
  [1042, 'text'],
  [1043, 'text'],
  [1082, 'date'],
  [1083, 'time'],
  [1266, 'time'],
  [1114, 'timestamp'],
  [1184, 'timestamp'],
  [1186, 'interval'],
  [2950, 'uuid'],
  [114, 'json'],
  [3802, 'json'],
]);

export function columnType(oid: number): ColumnType {
  return TYPE_BY_OID.get(oid) ?? 'unknown';
}

/** More significant digits than a double holds exactly. */
const MAX_EXACT_DIGITS = 15;

/** A numeric or int8 as a number when that's exact, else the server's text. */
export function exactNumber(raw: string): number | string {
  const digits = raw.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length;
  const value = Number(raw);
  return Number.isFinite(value) && digits <= MAX_EXACT_DIGITS ? value : raw;
}

/** A float as a number, or the server's text for NaN and infinities. */
export function finiteNumber(raw: string): number | string {
  const value = Number(raw);
  return Number.isFinite(value) ? value : raw;
}

const parseBoolean = (raw: string): boolean => raw === 't';
const parseInteger = (raw: string): number => Number(raw);
const parseJson = (raw: string): unknown => JSON.parse(raw);

/**
 * The parser for one result column, for postgres.js `.parsers()`: a function
 * to parse with, or `null` to keep the server's text. Every parsed type is
 * listed explicitly, because the function form of `.parsers()` has no
 * fallback to postgres.js's defaults.
 */
export function parserFor(oid: number): ((raw: string) => unknown) | null {
  switch (columnType(oid)) {
    case 'boolean':
      return parseBoolean;
    case 'integer':
      return oid === 20 ? exactNumber : parseInteger; // int2 and int4 always fit
    case 'number':
      return oid === 1700 ? exactNumber : finiteNumber;
    case 'json':
      return parseJson;
    default:
      return null; // text, uuid, dates, times, intervals and unknown types stay as written
  }
}
