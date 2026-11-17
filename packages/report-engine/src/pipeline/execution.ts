import type { LlmProvider } from '../llm';
import type { ParamValue, QueryOutcome, ReportQuery, RunOutcome } from '../pg';
import type { Vocabulary } from '../plan/vocabulary';
import type { SemanticModel } from '../semantic';
import { DEFAULT_ALLOWED_FUNCTIONS, type SqlGuard } from '../sql-guard';
import { compileQuery } from '../stages/compile';
import { computeDerived, runCrossChecks } from '../stages/derive';
import { writeNarrative } from '../stages/narrative';
import { checkOutcome, checkSql, repairRequest, sqlRequest, type CheckedSql, type SectionSql, type SqlAnswer } from '../stages/sql';
import { compareResults } from './compare';
import { todayIn } from './planning';
import { describeStatus, RunStateError, type CompiledCheck, type RunState, type SectionResult } from './state';
import { track } from './tracker';

/**
 * The execution half of a run (docs/report-engine-spec.md §4, stages 4-8):
 * from an approved plan to each section's checked rows and the narrative.
 *
 * - Stage 4: one LLM call writes the SQL for every section.
 * - Stage 5: code checks each query before it runs. Code also compiles each
 *   section's structured query to SQL, checked the same way.
 * - Stage 6: the valid queries, the LLM's and the compiled ones, run together
 *   in one read-only transaction, and the columns that come back are checked
 *   against the declared ones.
 * - Repairs: the LLM's failing sections go back to it with their exact
 *   errors, all in one call, for up to two rounds. After a repair every
 *   section runs again, so the final results come from one snapshot.
 * - Stage 7: each section's rows are set against its compiled rows. When they
 *   differ, or the LLM's SQL still fails, the compiled rows are shown. Then
 *   the plan's derived values and cross-checks are computed.
 * - Stage 8: the narrative. Without one, the report still stands.
 *
 * A section that still fails is marked failed. The run ends `succeeded`,
 * `partial` (some sections failed, none essential) or `failed`.
 */

/** One version of one section's SQL, once its verdict is known (spencer: report_queries). */
export interface QueryAttempt {
  section: string;
  /** 1 for the first SQL written for the section, then 2, 3, ... for repairs. The compiled SQL is always 1. */
  attempt: number;
  /** llm: written in stage 4. compiled: built by code from the section's structured query. */
  source: 'llm' | 'compiled';
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
  /** The compiled cross-check, on the final LLM attempt that ran and on the compiled one. */
  crossCheck: { check: CompiledCheck; detail: string | null } | null;
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
  /** Whether the narrative's LLM sees the computed values, or only what each one is. Default false. */
  shareValues?: boolean;
  signal?: AbortSignal;
  limits?: Partial<ExecutionLimits>;
}

/** Ids of compiled queries in a batch, beside the sections' own ids. */
const COMPILED = 'compiled:';

type Rows = Extract<QueryOutcome, { ok: true }>;

export async function executeRun(initial: RunState, deps: ExecutionDeps): Promise<RunState> {
  const plan = initial.plan;
  if (initial.status !== 'executing' || !plan) {
    throw new RunStateError('wrong_status', `This run is ${describeStatus(initial.status)}, so it has no approved plan to execute.`);
  }
  const limits = { ...DEFAULT_EXECUTION_LIMITS, ...deps.limits };
  const functions = deps.functions ?? DEFAULT_ALLOWED_FUNCTIONS;
  const input = { plan, today: todayIn(deps.timeZone, deps.now()), timeZone: deps.timeZone };
  const run = track(initial, deps.save);
  const needing = plan.sections.filter((section) => section.display !== 'text');

  await run.enter('writing_sql', { results: null, derived: null, checks: null, narrative: null, error: null });
  if (needing.length === 0) {
    run.finishStage();
    await run.update({ status: 'succeeded', stage: null, results: [], derived: [], checks: [] });
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

  // The compiled SQL: written by code from each structured query, checked once like the LLM's.
  const compiled = new Map<string, SectionSql>();
  const compileErrors = new Map<string, string[]>();
  for (const section of needing) {
    if (!section.query) continue;
    try {
      compiled.set(section.id, compileQuery(section.id, section.query, deps.vocabulary));
    } catch (error) {
      compileErrors.set(section.id, [error instanceof Error ? error.message : String(error)]);
    }
  }
  const compiledChecked = await checkSql(
    compiled,
    { ...plan, sections: plan.sections.filter((section) => compiled.has(section.id)) },
    deps.vocabulary,
    deps.guard,
  );

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
      crossCheck: null,
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
  let compiledOutcomes: Map<string, QueryOutcome>;
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
    const queries = [
      ...[...checked.valid.values()].map((sql) => ({ id: sql.section, sql: sql.sql, params: sql.params })),
      ...[...compiledChecked.valid.values()].map((sql) => ({ id: `${COMPILED}${sql.section}`, sql: sql.sql, params: sql.params })),
    ];
    const ran: RunOutcome = queries.length > 0 ? await deps.query(queries) : { ok: true, queries: [], durationMs: 0 };
    if (!ran.ok) return run.fail('executing', 'database', ran.error.message);
    outcomes = ran.queries.filter((outcome) => !outcome.id.startsWith(COMPILED));
    compiledOutcomes = new Map(
      ran.queries.filter((outcome) => outcome.id.startsWith(COMPILED)).map((outcome) => [outcome.id.slice(COMPILED.length), outcome]),
    );
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
    const llmRows: Rows | null = outcome?.ok === true && problems.length === 0 ? outcome : null;

    const compiledSql = compiledChecked.valid.get(section.id);
    const compiledOutcome = compiledOutcomes.get(section.id);
    const compiledProblems = compiledSql && compiledOutcome ? checkOutcome(compiledSql, compiledOutcome) : [];
    const compiledRows: Rows | null = compiledOutcome?.ok === true && compiledProblems.length === 0 ? compiledOutcome : null;

    let check: CompiledCheck = 'unavailable';
    let mismatch: string | null = null;
    if (!section.query) check = 'none';
    else if (llmRows && compiledRows) {
      if (!llmRows.truncated && !compiledRows.truncated) {
        const comparison = compareResults(llmRows, compiledRows);
        check = comparison.verdict;
        if (comparison.verdict === 'mismatch') mismatch = comparison.detail;
      }
    } else if (compiledRows) check = 'fallback';
    const useCompiled = check === 'mismatch' || check === 'fallback';
    const shown = useCompiled ? compiledRows : llmRows;
    const used = useCompiled ? compiledSql! : sql;

    const crossCheck = { check, detail: mismatch };
    if (llmRows) await record(section.id, 'ok', [], { ...measured(checked.valid.get(section.id)!, llmRows), crossCheck });
    if (section.query) {
      const compiledProblem = compileErrors.get(section.id) ?? compiledChecked.problems.get(section.id);
      await deps.recordQuery?.({
        section: section.id,
        attempt: 1,
        source: 'compiled',
        sql: (compiledSql ?? compiled.get(section.id))?.sql ?? '',
        params: (compiledSql ?? compiled.get(section.id))?.params ?? [],
        summary: (compiledSql ?? compiled.get(section.id))?.summary ?? '',
        verdict: compiledProblem ? 'rejected' : compiledRows ? 'ok' : 'failed',
        problems: compiledProblem ?? compiledProblems,
        fingerprint: null,
        cost: null,
        rows: null,
        truncated: false,
        durationMs: null,
        crossCheck,
        ...(compiledSql && compiledOutcome ? measured(compiledSql, compiledOutcome) : {}),
      });
    }

    results.push({
      section: section.id,
      status: shown ? 'ok' : 'failed',
      sql: used?.sql ?? null,
      params: used?.params ?? [],
      summary: used?.summary ?? null,
      columns: shown ? shown.columns : [],
      rows: shown ? shown.rows : [],
      truncated: shown ? shown.truncated : false,
      attempts: versions.get(section.id) ?? 0,
      problems: shown ? [] : problems,
      source: useCompiled ? 'compiled' : 'llm',
      check,
      ...(mismatch !== null && { mismatch }),
    });
  }

  const failed = results.filter((result) => result.status === 'failed');
  const essential = failed.filter((result) => needing.find((section) => section.id === result.section)?.essential);
  if (essential.length > 0 || failed.length === results.length) {
    await run.update({ results });
    return run.fail(
      'executing',
      'sections_failed',
      `${failed.length} of ${results.length} sections failed${essential.length > 0 ? ', including an essential one' : ''}.`,
      failed.map((result) => `${result.section}: ${result.problems.join(' ')}`),
    );
  }

  // Stage 7: derived values and cross-checks, from the rows that will be shown.
  await run.enter('verifying', { results });
  const computed = new Map(results.map((result) => [result.section, result]));
  const derived = computeDerived(plan, computed, deps.vocabulary);
  const checks = runCrossChecks(plan, computed, deps.vocabulary);

  // Stage 8: the narrative.
  await run.enter('narrating', { derived, checks });
  const narrative = await writeNarrative(
    {
      request: run.state.request,
      intent: run.state.intent,
      plan,
      results: computed,
      derived,
      vocabulary: deps.vocabulary,
      shareValues: deps.shareValues ?? false,
      today: input.today,
      timeZone: deps.timeZone,
    },
    { llm: deps.llm, cachePrefix: deps.cachePrefix, ...signalOf(deps), account: (calls) => run.account(calls) },
  );
  run.finishStage();
  await run.update({ status: failed.length === 0 ? 'succeeded' : 'partial', stage: null, narrative });
  return run.state;
}

function signalOf(deps: Pick<ExecutionDeps, 'signal'>): { signal?: AbortSignal } {
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
