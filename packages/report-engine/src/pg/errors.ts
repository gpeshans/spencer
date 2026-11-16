import type { SqlGuardIssue } from '../sql-guard';

/**
 * What a failed query reports. `message` and `hint` are safe to hand to the
 * LLM: Postgres messages that can quote row values (data exceptions, SQLSTATE
 * class 22, and anything unrecognised) are replaced with a generic message.
 * Messages that name only SQL identifiers are kept, because they are what a
 * repair needs ("column amout does not exist", "Perhaps you meant ...").
 */
export interface QueryError {
  code:
    | 'rejected'
    | 'too_expensive'
    | 'timeout'
    | 'syntax_error'
    | 'undefined_column'
    | 'undefined_table'
    | 'undefined_function'
    | 'invalid_query'
    | 'invalid_value'
    | 'permission_denied'
    | 'database_error';
  message: string;
  hint?: string;
  sqlstate?: string;
  /** 0-based offset into the query text. */
  position?: number;
  /** The guard's findings, when it rejected the SQL. */
  issues?: SqlGuardIssue[];
}

interface ServerError {
  code?: unknown;
  message?: unknown;
  hint?: unknown;
  position?: unknown;
}

/** Class 42 errors whose message and hint name identifiers, not data. */
const IDENTIFIER_ERRORS: Readonly<Record<string, QueryError['code']>> = {
  '42601': 'syntax_error',
  '42703': 'undefined_column',
  '42P01': 'undefined_table',
  '42883': 'undefined_function',
  '42702': 'invalid_query', // ambiguous column
  '42725': 'invalid_query', // ambiguous function
  '42803': 'invalid_query', // grouping error
  '42804': 'invalid_query', // datatype mismatch
  '42846': 'invalid_query', // cannot coerce
  '42P10': 'invalid_query', // invalid column reference
  '42P18': 'invalid_query', // indeterminate datatype
  '42501': 'permission_denied',
};

const DATA_MESSAGES: Readonly<Record<string, string>> = {
  '22012': 'Division by zero.',
  '22003': 'A number is out of range for its type.',
  '22008': 'A date or time is out of range.',
  '22007': 'A date or time has an invalid format.',
  '22P02': 'A value could not be converted to the requested type.',
  '22023': 'A function received an invalid argument.',
};

/**
 * Turns a Postgres error into a QueryError. `offset` is the length of any
 * prefix the executor added (e.g. "explain (format json) "), so positions
 * point into the query as written.
 */
export function toQueryError(error: ServerError, offset: number, statementTimeoutMs: number): QueryError {
  const sqlstate = typeof error.code === 'string' ? error.code : undefined;
  const raw = typeof error.position === 'string' ? Number(error.position) : NaN;
  // Postgres positions are 1-based, counted in characters of the sent text.
  const position = Number.isInteger(raw) && raw - 1 - offset >= 0 ? raw - 1 - offset : undefined;
  const where = position === undefined ? {} : { position };

  if (sqlstate === '57014') {
    return { code: 'timeout', sqlstate, message: `The query ran longer than ${statementTimeoutMs} ms.` };
  }
  if (sqlstate === '25006') {
    return { code: 'permission_denied', sqlstate, message: 'Writes are not allowed.' };
  }
  const identifierCode = sqlstate ? IDENTIFIER_ERRORS[sqlstate] : undefined;
  if (identifierCode) {
    return {
      code: identifierCode,
      sqlstate,
      message: typeof error.message === 'string' ? error.message : 'The query is invalid.',
      ...(typeof error.hint === 'string' && { hint: error.hint }),
      ...where,
    };
  }
  if (sqlstate?.startsWith('22')) {
    return {
      code: 'invalid_value',
      sqlstate,
      message: DATA_MESSAGES[sqlstate] ?? `A value caused an error (SQLSTATE ${sqlstate}).`,
      ...where,
    };
  }
  return {
    code: 'database_error',
    ...(sqlstate && { sqlstate }),
    message: `The database rejected the query${sqlstate ? ` (SQLSTATE ${sqlstate})` : ''}.`,
  };
}
