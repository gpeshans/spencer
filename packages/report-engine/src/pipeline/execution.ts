import type { LlmProvider } from '../llm';
import type { ParamValue, QueryOutcome, ReportQuery, RunOutcome } from '../pg';
import type { Vocabulary } from '../plan/vocabulary';
import type { SemanticModel } from '../semantic';
import { DEFAULT_ALLOWED_FUNCTIONS, type SqlGuard } from '../sql-guard';
import { checkOutcome, checkSql, repairRequest, sqlRequest, type CheckedSql, type SectionSql, type SqlAnswer } from '../stages/sql';
import { todayIn } from './planning';
import { RunStateError, type RunState, type SectionResult } from './state';
import { track } from './tracker';

/**
 * The execution half of a run (docs/report-engine-spec.md §4, stages 4-6):
 * from an approved plan to each section's rows.
 *
 * - Stage 4: one LLM call writes the SQL for every section.
 * - Stage 5: code checks each query before it runs.
 * - Stage 6: the valid queries run together in one read-only transaction, and
 *   the columns that come back are checked against the declared ones.
 * - Repairs: failing sections go back to the LLM with their exact errors, all
 *   in one call, for up to two rounds. After a repair every section runs again,
 *   so the final results come from one snapshot.
 *
 * A section that still fails is marked failed. The run ends `succeeded`,
 * `partial` (some sections failed, none essential) or `failed`. The compiled
 * fallback between the repairs and failing (spec §4, stage 5) comes in M3.
 */

/** One version of one section's SQL, once its verdict is known (spencer: report_queries). */
export interface QueryAttempt {
  section: string;
  /** 1 for the first SQL written for the section, then 2, 3, ... for repairs. */
  attempt: number;
  source: 'llm';
  sql: string;
  params: ParamValue[];
  summary: string;
  /** rejected: failed the checks before running. failed: failed when it ran, or returned other columns. */
  verdict: 'ok' | 'rejected' | 'failed';
  problems: string[];
  fingerprint: string | null;
  /** The EXPLAIN cost estimate. */
  cost: number | null;
  rows: number | null;
  truncated: false | 'rows' | 'bytes';
  durationMs: number | null;
}

export interface ExecutionLimits {
  /** Rounds of repair, each one LLM call for every failing section. */
  maxRepairs: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = { maxRepairs: 2 };

export interface ExecutionDeps {
  model: SemanticModel;
  vocabulary: Vocabulary;
  /** `cachePrefix(model, vocabulary)`, the same for every call. */
  cachePrefix: string;
  /** Carries the run's budget and recorder. */
  llm: LlmProvider;
  /** The executor's guard. Queries are checked here first, so a rejected one never opens a transaction. */
  guard: SqlGuard;
  /** Runs queries in one read-only transaction, in this run's scope: the executor with the run's signed scope. */
  query(queries: readonly ReportQuery[]): Promise<RunOutcome>;
  timeZone: string;
  now(): Date;
  /** Receives the state after every change; persist it here. A throw stops the run. */
  save(state: RunState): Promise<void>;
  /** Receives every SQL version once its verdict is known. */
  recordQuery?(attempt: QueryAttempt): Promise<void>;
  /** The functions the LLM is told it may use. Keep them in line with the guard's allow-list. */
  functions?: readonly string[];
  signal?: AbortSignal;
  limits?: Partial<ExecutionLimits>;
}

export async function executeRun(initial: RunState, deps: ExecutionDeps): Promise<RunState> {
  const plan = initial.plan;
  if (initial.status !== 'executing' || !plan) {
    throw new RunStateError('wrong_status', `A ${initial.status} run has no approved plan to execute.`);
  }
  const limits = { ...DEFAULT_EXECUTION_LIMITS, ...deps.limits };
  const functions = deps.functions ?? DEFAULT_ALLOWED_FUNCTIONS;
  const input = { plan, today: todayIn(deps.timeZone, deps.now()), timeZone: deps.timeZone };
  const run = track(initial, deps.save);
  const needing = plan.sections.filter((section) => section.display !== 'text');

  await run.enter('writing_sql', { results: null, error: null });
  if (needing.length === 0) {
    run.finishStage();
    await run.update({ status: 'succeeded', stage: null, results: [] });
    return run.state;
  }

  const first = await deps.llm.generate({ ...sqlRequest(deps.cachePrefix, functions, input), ...signalOf(deps) });
  run.account(first.calls);
  if (!first.ok) return run.fail('writing_sql', first.error.code, first.error.message);

  /** The latest SQL per section, and how many versions it has had. */
  const current = new Map<string, SectionSql>();
  const versions = new Map<string, number>();
  const adopt = (answer: SqlAnswer, ids: Iterable<string>) => {
    for (const id of ids) {
      const sql = answer.sections.find((candidate) => candidate.section === id);
      if (!sql) continue;
      current.set(id, sql);
      versions.set(id, (versions.get(id) ?? 0) + 1);
    }
  };
  adopt(first.output, needing.map((section) => section.id));

  const recorded = new Set<string>();
  const record = async (id: string, verdict: QueryAttempt['verdict'], problems: string[], extra: Partial<QueryAttempt> = {}) => {
    const sql = current.get(id);
    const attempt = versions.get(id) ?? 0;
    const key = `${id}#${attempt}`;
    if (!sql || !deps.recordQuery || recorded.has(key)) return;
    recorded.add(key);
    await deps.recordQuery({
      section: id,
      attempt,
      source: 'llm',
      sql: sql.sql,
      params: sql.params,
      summary: sql.summary,
      verdict,
      problems,
      fingerprint: null,
      cost: null,
      rows: null,
      truncated: false,
      durationMs: null,
      ...extra,
    });
  };

  let repairsLeft = limits.maxRepairs;
  const repair = async (problems: ReadonlyMap<string, string[]>) => {
    repairsLeft -= 1;
    await run.enter('writing_sql');
    const failures = needing
      .filter((section) => problems.has(section.id))
      .map((section) => ({ section, previous: current.get(section.id) ?? null, problems: problems.get(section.id)! }));
    const result = await deps.llm.generate({
      ...repairRequest(deps.cachePrefix, functions, { ...input, failures, model: deps.model }),
      ...signalOf(deps),
    });
    run.account(result.calls);
    // Without an answer, the failing sections stay failed; the others still run.
    if (!result.ok) repairsLeft = 0;
    else adopt(result.output, problems.keys());
  };

  let checked: { valid: Map<string, CheckedSql>; problems: Map<string, string[]> };
  let outcomes: QueryOutcome[];
  let failedRunning: Map<string, string[]>;
  for (;;) {
    await run.enter('validating');
    checked = await checkSql(current, plan, deps.vocabulary, deps.guard);
    for (const [id, problems] of checked.problems) await record(id, 'rejected', problems);
    if (checked.problems.size > 0 && repairsLeft > 0) {
      await repair(checked.problems);
      continue;
    }

    await run.enter('executing');
    const queries = [...checked.valid.values()].map((sql) => ({ id: sql.section, sql: sql.sql, params: sql.params }));
    const ran: RunOutcome = queries.length > 0 ? await deps.query(queries) : { ok: true, queries: [], durationMs: 0 };
    if (!ran.ok) return run.fail('executing', 'database', ran.error.message);
    outcomes = ran.queries;
    failedRunning = new Map();
    for (const outcome of outcomes) {
      const problems = checkOutcome(checked.valid.get(outcome.id)!, outcome);
      if (problems.length === 0) continue;
      failedRunning.set(outcome.id, problems);
      await record(outcome.id, 'failed', problems, measured(checked.valid.get(outcome.id)!, outcome));
    }
    if (failedRunning.size > 0 && repairsLeft > 0) {
      await repair(failedRunning);
      continue;
    }
    break;
  }
  run.finishStage();

  const results: SectionResult[] = [];
  for (const section of needing) {
    const sql = current.get(section.id) ?? null;
    const outcome = outcomes.find((candidate) => candidate.id === section.id);
    const problems = checked.problems.get(section.id) ?? failedRunning.get(section.id) ?? [];
    const ok = outcome?.ok === true && problems.length === 0;
    if (ok) await record(section.id, 'ok', [], measured(checked.valid.get(section.id)!, outcome));
    results.push({
      section: section.id,
      status: ok ? 'ok' : 'failed',
      sql: sql?.sql ?? null,
      params: sql?.params ?? [],
      summary: sql?.summary ?? null,
      columns: ok ? outcome.columns : [],
      rows: ok ? outcome.rows : [],
      truncated: ok ? outcome.truncated : false,
      attempts: versions.get(section.id) ?? 0,
      problems,
    });
  }

  const failed = results.filter((result) => result.status === 'failed');
  const essential = failed.filter((result) => needing.find((section) => section.id === result.section)?.essential);
  if (failed.length === 0) {
    await run.update({ status: 'succeeded', stage: null, results });
    return run.state;
  }
  if (essential.length > 0 || failed.length === results.length) {
    await run.update({ results });
    return run.fail(
      'executing',
      'sections_failed',
      `${failed.length} of ${results.length} sections failed${essential.length > 0 ? ', including an essential one' : ''}.`,
      failed.map((result) => `${result.section}: ${result.problems.join(' ')}`),
    );
  }
  await run.update({ status: 'partial', stage: null, results });
  return run.state;
}

function signalOf(deps: ExecutionDeps): { signal?: AbortSignal } {
  return deps.signal ? { signal: deps.signal } : {};
}

function measured(sql: CheckedSql, outcome: QueryOutcome): Partial<QueryAttempt> {
  return outcome.ok
    ? {
        fingerprint: sql.fingerprint,
        cost: outcome.cost,
        rows: outcome.rows.length,
        truncated: outcome.truncated,
        durationMs: outcome.durationMs,
      }
    : { fingerprint: sql.fingerprint, durationMs: outcome.durationMs };
}
