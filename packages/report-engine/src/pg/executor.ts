import postgres from 'postgres';

import type { SqlGuard } from '../sql-guard';
import { toQueryError, type QueryError } from './errors';
import { columnType, parserFor, type ColumnType } from './values';

/**
 * Runs guard-approved SQL for one report (docs/report-engine-spec.md §5.3).
 *
 * Every report gets one REPEATABLE READ, READ ONLY transaction that always
 * ends in ROLLBACK:
 * 1. SET LOCAL ROLE to the reporting role, then the limits and session
 *    settings the guard relies on (search_path = pg_catalog,
 *    standard_conforming_strings = on), all through set_config(..., true)
 *    with bound values.
 * 2. Set the signed scope and check that the database resolves it to the
 *    expected tenant.
 * 3. For each query, in its own savepoint:
 *    - check it with the guard (unchecked SQL never runs);
 *    - gate it on EXPLAIN's cost estimate;
 *    - fetch at most maxRows + 1 rows at the protocol level, so the query's
 *      own ORDER BY and LIMIT stay intact, then cap the bytes;
 *    - run a tripwire on role, scope and settings. Any change aborts the
 *      whole run and discards every result.
 *
 * Queries always use the extended protocol (`simple: false`), which carries
 * exactly one statement, and every query sees the same snapshot.
 */

export interface ExecutorLimits {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionMs: number;
  /** Whole-transaction ceiling (Postgres 17+; ignored on older servers). */
  transactionTimeoutMs: number;
  workMem: string;
  /** Rows returned per query; one more is fetched to detect truncation. */
  maxRows: number;
  /** JSON size of the rows returned per query. */
  maxBytes: number;
  /** Highest EXPLAIN "Total Cost" allowed to run. */
  maxCost: number;
}

export const DEFAULT_EXECUTOR_LIMITS: ExecutorLimits = {
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 1_000,
  idleInTransactionMs: 15_000,
  transactionTimeoutMs: 60_000,
  workMem: '16MB',
  maxRows: 1_000,
  maxBytes: 1_000_000,
  maxCost: 1_000_000,
};

export interface ExecutorOptions {
  /** Connection URL of the reporting login (Supavisor transaction mode on Supabase). */
  url: string;
  /** Role every report runs as, via SET LOCAL ROLE. */
  role: string;
  /** Every query must pass it before it runs. */
  guard: SqlGuard;
  limits?: Partial<ExecutorLimits>;
  /** Session time zone for CURRENT_DATE and timestamp output. Default UTC. */
  timeZone?: string;
  /** Connections in the pool. Default 3. */
  maxConnections?: number;
}

export interface ReportScope {
  /** Custom setting the database reads the scope from, e.g. `reports.scope`. */
  setting: string;
  /** The signed scope (see signScope). */
  value: string;
  /** Trusted SQL returning the tenant the database resolved, in a column named `tenant_id`. */
  verifySql: string;
  /** The tenant this run is for. */
  expectedTenant: string;
}

export type ParamValue = string | number | boolean | null;

export interface ReportQuery {
  id: string;
  sql: string;
  params?: readonly ParamValue[];
}

export interface QueryColumn {
  name: string;
  type: ColumnType;
}

export type QueryOutcome =
  | {
      id: string;
      ok: true;
      columns: QueryColumn[];
      rows: Record<string, unknown>[];
      /** Why rows were cut: too many rows, too many bytes, or not cut. */
      truncated: false | 'rows' | 'bytes';
      cost: number;
      fingerprint: string;
      durationMs: number;
    }
  | { id: string; ok: false; error: QueryError; durationMs: number };

export type RunError = {
  code: 'scope_mismatch' | 'tripwire' | 'connection' | 'internal';
  message: string;
  /** The server's SQLSTATE, when it reported one (e.g. 28P01 for a wrong password). Safe to log. */
  sqlstate?: string;
};

export type RunOutcome =
  | { ok: true; queries: QueryOutcome[]; durationMs: number }
  | { ok: false; error: RunError; queries: QueryOutcome[]; durationMs: number };

export interface RunInput {
  scope: ReportScope;
  queries: readonly ReportQuery[];
  /**
   * Called after each query, e.g. to record progress. Keep it quick: the
   * report's transaction stays open meanwhile, and Postgres ends a session
   * that is idle in a transaction for longer than idleInTransactionMs.
   */
  onQuery?: (outcome: QueryOutcome) => void | Promise<void>;
}

export interface ReportExecutor {
  run(input: RunInput): Promise<RunOutcome>;
  close(): Promise<void>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const CUSTOM_SETTING = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const EXPLAIN = 'explain (format json) ';
/** Extended protocol only; never prepared by name (poolers in transaction mode). */
const EXTENDED = { simple: false, prepare: false } as const;

/** Ends the run; `discard` drops every result gathered so far. */
class RunAbort extends Error {
  constructor(
    readonly code: RunError['code'],
    message: string,
    readonly discard: boolean,
  ) {
    super(message);
  }
}

type Tx = postgres.TransactionSql;
type SessionState = Record<string, unknown>;

export function createPgExecutor(options: ExecutorOptions): ReportExecutor {
  if (!IDENTIFIER.test(options.role)) {
    throw new Error(`pg executor: role "${options.role}" must be a lowercase identifier`);
  }
  const limits: ExecutorLimits = { ...DEFAULT_EXECUTOR_LIMITS, ...options.limits };
  const timeZone = options.timeZone ?? 'UTC';
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 3,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  let serverVersion: number | undefined;

  async function settle(tx: Tx): Promise<void> {
    await tx`select
      set_config('statement_timeout', ${`${limits.statementTimeoutMs}ms`}, true),
      set_config('lock_timeout', ${`${limits.lockTimeoutMs}ms`}, true),
      set_config('idle_in_transaction_session_timeout', ${`${limits.idleInTransactionMs}ms`}, true),
      set_config('work_mem', ${limits.workMem}, true),
      set_config('search_path', 'pg_catalog', true),
      set_config('standard_conforming_strings', 'on', true),
      set_config('DateStyle', 'ISO, YMD', true),
      set_config('TimeZone', ${timeZone}, true)`;
  }

  async function sessionState(tx: Tx, setting: string): Promise<SessionState> {
    const [state] = await tx`select
      current_user::text as role,
      current_setting(${setting}, true) as scope,
      current_setting('transaction_read_only') as read_only,
      current_setting('statement_timeout') as statement_timeout,
      current_setting('lock_timeout') as lock_timeout,
      current_setting('idle_in_transaction_session_timeout') as idle_timeout,
      current_setting('work_mem') as work_mem,
      current_setting('search_path') as search_path,
      current_setting('standard_conforming_strings') as standard_conforming_strings,
      current_setting('TimeZone') as time_zone`;
    return state ?? {};
  }

  async function runQuery(tx: Tx, query: ReportQuery, expected: SessionState, setting: string): Promise<QueryOutcome> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const params = [...(query.params ?? [])];

    const check = await options.guard.check(query.sql, { paramCount: params.length });
    if (!check.ok) {
      return {
        id: query.id,
        ok: false,
        error: { code: 'rejected', message: 'The SQL was rejected before it ran.', issues: check.issues },
        durationMs: elapsed(),
      };
    }

    let offset = 0;
    try {
      return await tx.savepoint(async (sp) => {
        await settle(sp);

        offset = EXPLAIN.length;
        const [plan] = await sp.unsafe(EXPLAIN + check.sql, params, EXTENDED);
        const cost = totalCost(plan);
        if (!(cost <= limits.maxCost)) {
          return {
            id: query.id,
            ok: false as const,
            error: {
              code: 'too_expensive' as const,
              message: `The estimated cost is ${Math.round(cost)}; the limit is ${limits.maxCost}.`,
              hint: 'Filter earlier, aggregate in the database, or join on indexed columns.',
            },
            durationMs: elapsed(),
          };
        }

        offset = 0;
        const statement = await sp.unsafe(check.sql, params, EXTENDED).describe();
        const columns = statement.columns.map((column) => ({ name: column.name, type: columnType(column.type) }));
        // Rows come back as objects, so a repeated column name would silently lose a value.
        const duplicates = columns
          .map((column) => column.name)
          .filter((name, index, names) => names.indexOf(name) !== index);
        if (duplicates.length > 0) {
          return {
            id: query.id,
            ok: false as const,
            error: {
              code: 'invalid_query' as const,
              message: `Column names must be unique; repeated: ${[...new Set(duplicates)].join(', ')}.`,
              hint: 'Give each output column its own alias.',
            },
            durationMs: elapsed(),
          };
        }

        const fetched: Record<string, unknown>[] = [];
        await sp
          .unsafe(check.sql, params, EXTENDED)
          .parsers((column) => parserFor(column.type))
          .cursor(limits.maxRows + 1, (batch) => {
            fetched.push(...(batch as Record<string, unknown>[]));
            return sql.CLOSE;
          });

        let truncated: false | 'rows' | 'bytes' = false;
        if (fetched.length > limits.maxRows) {
          fetched.length = limits.maxRows;
          truncated = 'rows';
        }
        let bytes = 0;
        const rows: Record<string, unknown>[] = [];
        for (const row of fetched) {
          bytes += JSON.stringify(row).length;
          if (bytes > limits.maxBytes) {
            truncated = 'bytes';
            break;
          }
          rows.push(row);
        }

        return {
          id: query.id,
          ok: true as const,
          columns,
          rows,
          truncated,
          cost,
          fingerprint: check.fingerprint,
          durationMs: elapsed(),
        };
      });
    } catch (error) {
      if (!(error instanceof postgres.PostgresError)) throw error;
      return {
        id: query.id,
        ok: false,
        error: toQueryError(error, offset, limits.statementTimeoutMs),
        durationMs: elapsed(),
      };
    } finally {
      await tripwire(tx, expected, setting);
    }
  }

  async function tripwire(tx: Tx, expected: SessionState, setting: string): Promise<void> {
    const actual = await sessionState(tx, setting);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new RunAbort('tripwire', 'The session changed during a query; the run was stopped.', true);
    }
  }

  async function run({ scope, queries, onQuery }: RunInput): Promise<RunOutcome> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    if (!CUSTOM_SETTING.test(scope.setting)) {
      throw new Error(`pg executor: scope setting "${scope.setting}" must look like prefix.name`);
    }
    const outcomes: QueryOutcome[] = [];

    try {
      await sql.begin('isolation level repeatable read read only', async (tx) => {
        await tx.unsafe(`set local role ${options.role}`, [], EXTENDED);
        await settle(tx);
        serverVersion ??= Number((await tx`select current_setting('server_version_num') as v`)[0]?.v);
        if (serverVersion >= 170_000) {
          await tx`select set_config('transaction_timeout', ${`${limits.transactionTimeoutMs}ms`}, true)`;
        }
        await tx`select set_config(${scope.setting}, ${scope.value}, true)`;

        const [resolved] = await tx.unsafe(scope.verifySql, [], EXTENDED);
        if (String(resolved?.tenant_id ?? '') !== scope.expectedTenant) {
          throw new RunAbort('scope_mismatch', 'The scope did not resolve to the expected tenant.', true);
        }

        const expected = await sessionState(tx, scope.setting);
        for (const query of queries) {
          const outcome = await runQuery(tx, query, expected, scope.setting);
          outcomes.push(outcome);
          await onQuery?.(outcome);
        }
        await tx.rollback();
      });
      return { ok: true, queries: outcomes, durationMs: elapsed() };
    } catch (error) {
      if (error instanceof RunAbort) {
        return {
          ok: false,
          error: { code: error.code, message: error.message },
          queries: error.discard ? [] : outcomes,
          durationMs: elapsed(),
        };
      }
      const sqlstate = error instanceof postgres.PostgresError ? error.code : undefined;
      const connection = sqlstate !== undefined || isConnectionError(error);
      return {
        ok: false,
        error: connection
          ? { code: 'connection', message: 'Could not run the report on the database.', ...(sqlstate && { sqlstate }) }
          : { code: 'internal', message: 'The report run failed unexpectedly.' },
        queries: [],
        durationMs: elapsed(),
      };
    }
  }

  return {
    run,
    close: () => sql.end({ timeout: 5 }),
  };
}

function totalCost(plan: Record<string, unknown> | undefined): number {
  const document = plan?.['QUERY PLAN'] as Array<{ Plan?: { 'Total Cost'?: unknown } }> | undefined;
  const cost = document?.[0]?.Plan?.['Total Cost'];
  return typeof cost === 'number' ? cost : Number.POSITIVE_INFINITY;
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^(E[A-Z]+|CONNECT_TIMEOUT|CONNECTION_\w+)$/.test(code);
}
