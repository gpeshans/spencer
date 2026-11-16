import { describe, expect, it } from 'vitest';

import { toQueryError } from './errors';

describe('query errors', () => {
  it('reports timeouts with the limit', () => {
    expect(toQueryError({ code: '57014', message: 'canceling statement due to statement timeout' }, 0, 300)).toEqual({
      code: 'timeout',
      sqlstate: '57014',
      message: 'The query ran longer than 300 ms.',
    });
  });

  it('keeps identifier messages and hints, with positions into the query as written', () => {
    const error = toQueryError(
      {
        code: '42703',
        message: 'column "amout" does not exist',
        hint: 'Perhaps you meant to reference the column "spendings.amount".',
        position: '30',
      },
      22, // the length of an "explain (format json) " prefix
      5_000,
    );
    expect(error).toEqual({
      code: 'undefined_column',
      sqlstate: '42703',
      message: 'column "amout" does not exist',
      hint: 'Perhaps you meant to reference the column "spendings.amount".',
      position: 7,
    });
  });

  it('never echoes values from data errors', () => {
    const error = toQueryError(
      { code: '22P02', message: 'invalid input syntax for type integer: "Coffee beans"' },
      0,
      5_000,
    );
    expect(error.code).toBe('invalid_value');
    expect(error.message).not.toContain('Coffee');
    expect(toQueryError({ code: '22012', message: 'division by zero' }, 0, 5_000).message).toBe('Division by zero.');
  });

  it('hides messages it does not recognise', () => {
    const error = toQueryError({ code: 'XX000', message: 'internal detail with "data"' }, 0, 5_000);
    expect(error).toEqual({
      code: 'database_error',
      sqlstate: 'XX000',
      message: 'The database rejected the query (SQLSTATE XX000).',
    });
  });

  it('maps privilege and read-only errors', () => {
    expect(toQueryError({ code: '42501', message: 'permission denied for table x' }, 0, 1).code).toBe(
      'permission_denied',
    );
    expect(toQueryError({ code: '25006', message: 'cannot execute UPDATE in a read-only transaction' }, 0, 1)).toEqual({
      code: 'permission_denied',
      sqlstate: '25006',
      message: 'Writes are not allowed.',
    });
  });
});
