import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  answerClarification,
  approvePlan,
  buildVocabulary,
  cachePrefix,
  createAnthropicProvider,
  createPgExecutor,
  createRunBudget,
  createSqlGuard,
  executeRun,
  newRun,
  parseSemanticModel,
  planRun,
  priceOf,
  signScope,
  todayIn,
  type GenerateRequest,
  type GenerateResult,
  type LlmCallRecord,
  type LlmProvider,
  type ReportQuery,
  type RunState,
  type SpendGuard,
} from 'report-engine';

import { reportsConfig } from '../../reports.config';
import { buildCases, type EvalCase } from './cases';
import { buildFixture, FAMILY, prepareEvalDatabase } from './fixture';
import { gradeRun } from './grade';

/**
 * Runs the eval: each case through the app's own pipeline (planRun, then
 * executeRun) with production's settings, against the fixture database, then
 * grades it. One JSON line per (case, rep) in results.jsonl, written as each
 * finishes, so a rerun resumes; a full transcript per attempt in traces/; and
 * attempts the harness itself lost (a crash, the time ceiling) in
 * errors.jsonl, never scored. Layout: the Claude API skill's eval format, so
 * build-report-lite.mjs can render it.
 */

/** The model the app runs, as lib/reports/engine.ts. */
const MODEL = 'claude-opus-5-5';
/** As lib/reports/runner.ts: a run stops itself after this long. */
const RUN_DEADLINE_MS = 270_000;

export interface Turn {
  role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result';
  content: string;
  name?: string;
}

/** Makes the LLM for one attempt. The default is production's Anthropic provider. */
export type LlmFactory = (evalCase: EvalCase, guard: SpendGuard, onCall: (call: LlmCallRecord) => void) => LlmProvider;

export interface EvalOptions {
  /** The flow directory: results go in <outDir>/<variant>/. */
  outDir: string;
  variant: string;
  /** Only these case ids; all by default. */
  caseIds?: readonly string[];
  reps: number;
  concurrency: number;
  /** No new attempt starts once this much has been spent. */
  maxUsd: number;
  /** Wall-clock limit per attempt; past it, the attempt goes to errors.jsonl. */
  ceilingMs?: number;
  timeZone: string;
  llm?: LlmFactory;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface EvalRow {
  prompt_id: string;
  rep: number;
  prompt: string;
  tags: string[];
  status: 'ok';
  grade: { correct: 0 | 1; outcome: 0 | 1; isolated: 0 | 1 };
  expected: { outcome: string; facts: string[] };
  actual: { outcome: string; code: string | null; facts: Array<{ label: string; met: boolean; detail: string }> };
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  cost_usd: number;
  latency_s: number;
  llm_calls: number;
  repairs: number;
  fallback: 0 | 1;
  asked_approval: 0 | 1;
  asked_clarification: 0 | 1;
  /** Sections shown from the compiled SQL: its rows differed from the LLM's, or the LLM's SQL failed. */
  compiled_used: number;
  /** Whether the report got a narrative. */
  narrated: 0 | 1;
  /** as_of: the day the case's periods and expected values were worked out for. */
  meta: { as_of: string; run_status: string; error: string | null; approval_reasons: string[] };
}

interface ErrorRow {
  prompt_id: string;
  rep: number;
  class: 'timeout' | 'harness';
  message: string;
  cost_usd: number;
}

export interface EvalSummary {
  variant: string;
  /** The scored attempts asked for: the cases and reps of this run, including those done earlier. */
  rows: EvalRow[];
  errors: number;
  skipped: number;
}

/** The metrics and columns the report shows, in the skill's _state.json shape. */
export const STATE = {
  metrics: [
    { id: 'correct', label: 'Correct', kind: 'binary' },
    { id: 'outcome', label: 'Right outcome', kind: 'binary' },
    { id: 'isolated', label: 'Isolated', kind: 'binary' },
  ],
  perf_fields: [
    { id: 'cost_usd', label: 'Cost', unit: '$' },
    { id: 'latency_s', label: 'Time', unit: 's' },
    { id: 'llm_calls', label: 'LLM calls' },
    { id: 'repairs', label: 'Repairs' },
    { id: 'fallback', label: 'Fallback' },
    { id: 'asked_approval', label: 'Approval' },
    { id: 'compiled_used', label: 'Compiled rows' },
    { id: 'narrated', label: 'Narrative' },
  ],
} as const;

class CeilingReached extends Error {}

const readLines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as T)
    : [];

/** Wraps an LLM so every call lands in the transcript: the stage's instructions and input, then its answer. */
function recording(inner: LlmProvider, turns: Turn[]): LlmProvider {
  return {
    async generate(request) {
      turns.push({ role: 'user', name: request.stage, content: `${request.system}\n\n${request.input}` });
      const result = await inner.generate(request);
      turns.push({
        role: 'assistant',
        name: request.stage,
        content: result.ok ? JSON.stringify(result.output, null, 2) : `failed: ${result.error.code}: ${result.error.message}`,
      });
      return result;
    },
  };
}

export async function runEval(options: EvalOptions): Promise<EvalSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const fixture = buildFixture(todayIn(options.timeZone, now()));
  const all = buildCases(fixture);
  const unknown = (options.caseIds ?? []).filter((id) => !all.some((evalCase) => evalCase.id === id));
  if (unknown.length > 0) throw new Error(`unknown case id(s): ${unknown.join(', ')}`);
  const cases = options.caseIds?.length ? all.filter((evalCase) => options.caseIds!.includes(evalCase.id)) : all;

  const dir = path.join(options.outDir, options.variant);
  mkdirSync(path.join(dir, 'traces'), { recursive: true });
  writeFileSync(path.join(options.outDir, '_state.json'), `${JSON.stringify(STATE, null, 2)}\n`);
  const resultsFile = path.join(dir, 'results.jsonl');
  const errorsFile = path.join(dir, 'errors.jsonl');
  const done = new Set(readLines<EvalRow>(resultsFile).map((row) => `${row.prompt_id}#${row.rep}`));
  const tasks = cases.flatMap((evalCase) =>
    Array.from({ length: options.reps }, (_, rep) => ({ evalCase, rep })).filter(({ rep }) => !done.has(`${evalCase.id}#${rep}`)),
  );
  log(`${tasks.length} attempt(s) to run, ${done.size} already done, in ${dir}`);

  const model = parseSemanticModel(JSON.parse(readFileSync(reportsConfig.model.path, 'utf8')));
  const vocabulary = buildVocabulary(model);
  const prefix = cachePrefix(model, vocabulary);
  const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });
  const makeLlm: LlmFactory = options.llm ?? ((_case, spendGuard, onCall) => createAnthropicProvider({ guard: spendGuard, onCall }));

  let spent = 0;
  let skipped = 0;
  const prepared = tasks.length > 0 ? await prepareEvalDatabase(fixture) : null;
  const executor = prepared
    ? createPgExecutor({ url: prepared.readerUrl, role: reportsConfig.model.role, guard, timeZone: options.timeZone })
    : null;

  async function attempt(evalCase: EvalCase, rep: number): Promise<{ row: EvalRow; turns: Turn[] } | { error: ErrorRow; turns: Turn[] }> {
    const started = performance.now();
    const calls: LlmCallRecord[] = [];
    const turns: Turn[] = [
      { role: 'system', content: prefix },
      { role: 'user', content: evalCase.question },
    ];
    const budget = createRunBudget(reportsConfig.limits.runUsd);
    const llm = recording(makeLlm(evalCase, budget, (call) => void calls.push(call)), turns);
    const runId = randomUUID();
    const query = (queries: readonly ReportQuery[]) =>
      executor!.run({
        scope: {
          setting: reportsConfig.scope.setting,
          value: signScope({ tenantId: FAMILY, runId, key: prepared!.scopeKey }),
          verifySql: reportsConfig.scope.verifySql,
          expectedTenant: FAMILY,
        },
        queries,
      });
    const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
    const shared = { vocabulary, cachePrefix: prefix, llm, timeZone: options.timeZone, now, save: async () => {} };
    const planning = {
      ...shared,
      query,
      shareValues: reportsConfig.shareValues,
      remainingUsd: () => reportsConfig.limits.runUsd - budget.spentUsd(),
      price: priceOf(MODEL),
      signal: deadline,
    };
    const costOf = () => calls.reduce((sum, call) => sum + call.costUsd, 0);

    let ceiling: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async (): Promise<RunState> => {
        let state = await planRun(newRun(runId, evalCase.question), planning);
        const answers = [...(evalCase.answers ?? [])];
        while (state.status === 'needs_clarification' && answers.length > 0) {
          const answer = answers.shift()!;
          turns.push({ role: 'assistant', name: 'question', content: state.clarifications.at(-1)?.question ?? '' }, { role: 'user', content: answer });
          state = await planRun(answerClarification(state, answer, now()), planning);
        }
        if (state.status === 'awaiting_approval') {
          turns.push({ role: 'assistant', name: 'approval', content: `Asks to approve: ${state.approval?.reasons.join(' ')}` }, { role: 'user', content: 'Approve.' });
          state = approvePlan(state, state.planHash!, now());
        }
        if (state.status === 'executing') {
          state = await executeRun(state, { ...shared, model, guard, query, shareValues: reportsConfig.shareValues, signal: deadline });
        }
        return state;
      })();
      // If the ceiling wins, the run may still fail later; that's already accounted for.
      work.catch(() => undefined);
      const state = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          ceiling = setTimeout(() => reject(new CeilingReached(`no result after ${(options.ceilingMs ?? 300_000) / 1000} s`)), options.ceilingMs ?? 300_000);
        }),
      ]);

      for (const result of state.results ?? []) {
        const check = result.check ? ` (${result.source ?? 'llm'} rows, check: ${result.check}${result.mismatch ? `: ${result.mismatch}` : ''})` : '';
        turns.push(
          { role: 'tool_call', name: `sql ${result.section}`, content: `${result.sql ?? '(none)'}\n-- params: ${JSON.stringify(result.params)}` },
          {
            role: 'tool_result',
            name: `sql ${result.section}`,
            content: result.status === 'ok' ? `${JSON.stringify(result.rows.slice(0, 20), null, 2)}${check}` : `failed: ${result.problems.join(' ')}`,
          },
        );
      }
      if (state.derived?.length || state.checks?.length) {
        turns.push({ role: 'tool_result', name: 'derived and checks', content: JSON.stringify({ derived: state.derived, checks: state.checks }, null, 2) });
      }
      const graded = gradeRun(evalCase, state);
      turns.push({ role: 'assistant', name: 'outcome', content: `${state.status}${state.error ? `: ${state.error.code}: ${state.error.message}` : ''}\n${JSON.stringify(graded, null, 2)}` });

      const usage = calls.reduce(
        (sum, call) => ({
          input_tokens: sum.input_tokens + call.usage.inputTokens,
          output_tokens: sum.output_tokens + call.usage.outputTokens,
          cache_read_input_tokens: sum.cache_read_input_tokens + call.usage.cacheReadTokens,
          cache_creation_input_tokens: sum.cache_creation_input_tokens + call.usage.cacheWrite5mTokens + call.usage.cacheWrite1hTokens,
        }),
        { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      );
      const row: EvalRow = {
        prompt_id: evalCase.id,
        rep,
        prompt: evalCase.question,
        tags: evalCase.tags,
        status: 'ok',
        grade: graded.grade,
        expected: { outcome: evalCase.expect, facts: evalCase.facts.map((fact) => fact.label) },
        actual: { outcome: graded.actual, code: graded.code, facts: graded.facts },
        model: [...new Set(calls.map((call) => call.modelServed ?? call.modelRequested))].join(','),
        usage,
        cost_usd: Math.round(costOf() * 1e6) / 1e6,
        latency_s: Math.round((performance.now() - started) / 100) / 10,
        llm_calls: calls.length,
        repairs: (state.results ?? []).reduce((sum, result) => sum + Math.max(0, result.attempts - 1), 0),
        fallback: calls.some((call) => call.fallbackReason !== null) ? 1 : 0,
        asked_approval: turns.some((turn) => turn.name === 'approval') ? 1 : 0,
        asked_clarification: turns.some((turn) => turn.name === 'question') || state.status === 'needs_clarification' ? 1 : 0,
        compiled_used: (state.results ?? []).filter((result) => result.source === 'compiled').length,
        narrated: state.narrative ? 1 : 0,
        meta: { as_of: fixture.today, run_status: state.status, error: state.error?.message ?? null, approval_reasons: state.approval?.reasons ?? [] },
      };
      return { row, turns };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      turns.push({ role: 'assistant', name: 'harness error', content: message });
      return {
        error: { prompt_id: evalCase.id, rep, class: error instanceof CeilingReached ? 'timeout' : 'harness', message, cost_usd: Math.round(costOf() * 1e6) / 1e6 },
        turns,
      };
    } finally {
      clearTimeout(ceiling);
    }
  }

  try {
    const queue = [...tasks];
    const worker = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        if (spent >= options.maxUsd) {
          skipped += 1;
          continue;
        }
        const { evalCase, rep } = task;
        const outcome = await attempt(evalCase, rep);
        writeFileSync(path.join(dir, 'traces', `${evalCase.id}_rep${rep}.json`), `${JSON.stringify(outcome.turns, null, 2)}\n`);
        if ('row' in outcome) {
          spent += outcome.row.cost_usd;
          appendFileSync(resultsFile, `${JSON.stringify(outcome.row)}\n`);
          log(`${outcome.row.grade.correct ? 'pass' : 'FAIL'}  ${evalCase.id}#${rep}  ${outcome.row.actual.outcome}  $${outcome.row.cost_usd.toFixed(3)}  ${outcome.row.latency_s}s`);
        } else {
          spent += outcome.error.cost_usd;
          appendFileSync(errorsFile, `${JSON.stringify(outcome.error)}\n`);
          log(`ERROR ${evalCase.id}#${rep}  ${outcome.error.class}: ${outcome.error.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  } finally {
    await executor?.close();
    await prepared?.db.stop();
  }
  if (skipped > 0) log(`${skipped} attempt(s) not started: the $${options.maxUsd} cap was reached.`);

  // The attempts asked for, this run's and earlier ones; errors that a later success superseded don't count.
  const rows = readLines<EvalRow>(resultsFile).filter((row) => row.rep < options.reps && cases.some((evalCase) => evalCase.id === row.prompt_id));
  const scored = new Set(rows.map((row) => `${row.prompt_id}#${row.rep}`));
  const errors = readLines<ErrorRow>(errorsFile).filter((error) => !scored.has(`${error.prompt_id}#${error.rep}`)).length;
  return { variant: options.variant, rows, errors, skipped };
}

/** 95% Wilson interval for k passes in n. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const spread = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, centre - spread), Math.min(1, centre + spread)];
}

/** The summary printed after a run, also written as summary.md beside the results. */
export function summarize(summary: EvalSummary): string {
  const { rows } = summary;
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const passes = rows.filter((row) => row.grade.correct).length;
  const [low, high] = wilson(passes, rows.length);
  const byTag = new Map<string, EvalRow[]>();
  for (const row of rows) byTag.set(row.tags[0] ?? 'other', [...(byTag.get(row.tags[0] ?? 'other') ?? []), row]);
  const cost = rows.reduce((sum, row) => sum + row.cost_usd, 0);
  const leaks = rows.filter((row) => !row.grade.isolated);
  const lines = [
    `# Report eval: ${summary.variant}`,
    '',
    `**Correct: ${passes}/${rows.length} (${pct(rows.length ? passes / rows.length : 0)}, 95% interval ${pct(low)}–${pct(high)})**` +
      `${summary.errors ? `; ${summary.errors} attempt(s) lost to the harness, not scored` : ''}${summary.skipped ? `; ${summary.skipped} not run (spend cap)` : ''}.`,
    '',
    `Cost $${cost.toFixed(2)} ($${(rows.length ? cost / rows.length : 0).toFixed(3)} per attempt); median time ${median(rows.map((row) => row.latency_s))} s.`,
    leaks.length > 0 ? `\n**Isolation broken in ${leaks.length} attempt(s): ${leaks.map((row) => row.prompt_id).join(', ')}.**` : '',
    '',
    '| Kind | Correct |',
    '|---|---|',
    ...[...byTag].map(([tag, tagged]) => `| ${tag} | ${tagged.filter((row) => row.grade.correct).length}/${tagged.length} |`),
    '',
    '| Case | Rep | Correct | Expected | Got | Cost | Time | Notes |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((row) => {
      const missed = row.actual.facts.filter((fact) => !fact.met).map((fact) => `${fact.label}: ${fact.detail}`);
      const notes = [row.actual.code, ...missed, row.repairs ? `${row.repairs} repair(s)` : null, row.fallback ? 'fallback model' : null].filter(Boolean).join('; ');
      return `| ${row.prompt_id} | ${row.rep} | ${row.grade.correct ? 'yes' : '**no**'} | ${row.expected.outcome} | ${row.actual.outcome} | $${row.cost_usd.toFixed(3)} | ${row.latency_s}s | ${notes.replaceAll('|', '/')} |`;
    }),
  ];
  return `${lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')}\n`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10;
}

/** The case list for review, as of today: questions, expected outcomes and every gold value. */
export function casesMarkdown(cases: readonly EvalCase[], today: string): string {
  const money = (value: number) => value.toFixed(2);
  const lines = [
    '# Report eval: the cases',
    '',
    `Generated by \`npm run reports:eval -- --list\` on ${today}. Periods are relative to today, so the months and values move with the calendar; the shape stays the same.`,
    '',
    '| Case | Kind | Expected | Question |',
    '|---|---|---|---|',
    ...cases.map((evalCase) => `| ${evalCase.id} | ${evalCase.tags.join(', ')} | ${evalCase.expect} | ${evalCase.question} |`),
    '',
  ];
  for (const evalCase of cases) {
    lines.push(`## ${evalCase.id}`, '', `> ${evalCase.question}`, '', `Expected: **${evalCase.expect}**.${evalCase.note ? ` ${evalCase.note}` : ''}`);
    if (evalCase.answers?.length) lines.push('', `If it asks, the answer is: ${evalCase.answers.map((answer) => `"${answer}"`).join(', then ')}.`);
    for (const fact of evalCase.facts) {
      lines.push('', `- ${fact.label}:`);
      const shown = (value: number) => (fact.kind !== 'rows' && fact.percent ? `${value.toFixed(2)} % (±${fact.tolerance ?? 0.01})` : money(value));
      if (fact.kind === 'scalar') lines.push(`  ${shown(fact.value)}`);
      if (fact.kind === 'map') lines.push(...Object.entries(fact.entries).map(([key, value]) => `  - ${key.replace('|', ' / ')}: ${shown(value)}`));
      if (fact.kind === 'series') lines.push(...Object.entries(fact.points).map(([month, value]) => `  - ${month}: ${shown(value)}`));
      if (fact.kind === 'rows') {
        lines.push(`  ${fact.ordered ? 'in this order' : 'in any order, and no others'}:`);
        lines.push(...fact.rows.map((row) => `  - ${money(row.amount)}${row.date ? ` on ${row.date}` : ''}${row.text ? ` ("${row.text.length > 40 ? `${row.text.slice(0, 40)}…` : row.text}")` : ''}`));
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * An LLM without the API, to check the harness: `answer` gives each call's
 * output, which must fit the stage's schema as the API's would. Costs nothing.
 */
export function offlineLlm(answer: (evalCase: EvalCase, stage: string) => unknown): LlmFactory {
  return (evalCase, _guard, onCall) => ({
    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const output = request.schema.parse(answer(evalCase, request.stage));
      const call: LlmCallRecord = {
        stage: request.stage,
        attempt: 1,
        provider: 'offline',
        modelRequested: 'offline',
        modelServed: 'offline',
        fallbackReason: null,
        effort: request.effort,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        ttftMs: null,
        stopReason: 'end_turn',
        requestId: null,
        errorClass: null,
      };
      onCall(call);
      return { ok: true, output, calls: [call] };
    },
  });
}

/** --fake-llm: refuses every question at stage 1, so every run ends refused; `failFor` makes that case's attempt crash. */
export function fakeLlm(failFor?: string): LlmFactory {
  return offlineLlm((evalCase, stage) => {
    if (evalCase.id === failFor) throw new Error('fake harness failure');
    if (stage !== 'intent') throw new Error(`the fake LLM only answers stage 1, not ${stage}`);
    return {
      kind: 'out_of_scope',
      restated: evalCase.question,
      metrics: [],
      dimensions: [],
      grain: null,
      filters: [],
      period: null,
      comparison: null,
      assumptions: [],
      ambiguities: [],
      confidence: 'high',
      refusal: 'The fake LLM refuses everything.',
    };
  });
}

export { buildCases, buildFixture };
