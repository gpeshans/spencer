import { describe, expect, it } from 'vitest';

import { columnType, exactNumber, finiteNumber, parserFor } from './values';

describe('result values', () => {
  it('names column types from their oids', () => {
    expect(columnType(1082)).toBe('date');
    expect(columnType(1184)).toBe('timestamp');
    expect(columnType(1700)).toBe('number');
    expect(columnType(20)).toBe('integer');
    expect(columnType(25)).toBe('text');
    expect(columnType(3802)).toBe('json');
    expect(columnType(600)).toBe('unknown'); // point
  });

  it('turns numerics into numbers only when that is exact', () => {
    expect(exactNumber('12.50')).toBe(12.5);
    expect(exactNumber('-0.001')).toBe(-0.001);
    expect(exactNumber('123456789012345')).toBe(123456789012345);
    expect(exactNumber('1234567890123456')).toBe('1234567890123456');
    expect(exactNumber('0.12345678901234567')).toBe('0.12345678901234567');
    expect(exactNumber('NaN')).toBe('NaN');
    expect(exactNumber('Infinity')).toBe('Infinity');
  });

  it('keeps text, uuids, dates and times as the server wrote them', () => {
    for (const oid of [25, 1043, 2950, 1082, 1083, 1114, 1184, 1186, 600]) expect(parserFor(oid)).toBeNull();
  });

  it('parses booleans, integers, floats and json', () => {
    expect(parserFor(16)?.('t')).toBe(true);
    expect(parserFor(16)?.('f')).toBe(false);
    expect(parserFor(23)?.('42')).toBe(42);
    expect(parserFor(21)?.('-7')).toBe(-7);
    expect(parserFor(701)?.('1.5')).toBe(1.5);
    expect(parserFor(701)?.('NaN')).toBe('NaN');
    expect(parserFor(3802)?.('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  it('parses numeric and int8 exactly', () => {
    expect(parserFor(1700)).toBe(exactNumber);
    expect(parserFor(20)).toBe(exactNumber);
    expect(finiteNumber('-Infinity')).toBe('-Infinity');
  });
});
