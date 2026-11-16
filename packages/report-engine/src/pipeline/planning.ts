import type { LlmProvider, ModelPrice } from '../llm';
import type { ReportQuery, RunOutcome } from '../pg';
import type { Vocabulary } from '../plan/vocabulary';
import { feasibilityQueries, judgeFeasibility } from '../stages/feasibility';
import { checkIntent, intentRequest, type Intent } from '../stages/intent';
import { approvalReasons, checkPlan, estimateRemainingCost, planHash, planRequest, type ReportPlan } from '../stages/plan';
import { readValues, valueQueries } from '../stages/values';
import { describeStatus, RunStateError, type RunState } from './state';
import { track } from './tracker';

/**
 * The planning half of a run (docs/report-engine-spec.md §4, stages 1-3, and
 * "Run states"): from the request to an approved-or-approvable plan.
 *
 * The engine keeps no state of its own. `planRun` takes a run's state, moves it
 * forward, and hands every new state to `save`, so the run survives a closed
 * tab and every step can be audited. The functions below it make the explicit
 * moves: answering a question, approving, rejecting and expiring.
 */

export const MAX_ANSWER_LENGTH = 500;

export interface PlanningLimits {
  /** Clarifying questions a run may ask before it gives up. */
  maxClarifications: number;
  /** How long an open question or a pending approval stays open. */
  pendingHours: number;
}

export const DEFAULT_PLANNING_LIMITS: PlanningLimits = { maxClarifications: 2, pendingHours: 24 };

export interface PlanningDeps {
  vocabulary: Vocabulary;
  /** `cachePrefix(model, vocabulary)`, the same for every call. */
  cachePrefix: string;
  /** Carries the run's budget and recorder (see createAnthropicProvider). */
  llm: LlmProvider;
  /** Runs code-built queries in this run's scope: the executor with the run's signed scope. */
  query(queries: readonly ReportQuery[]): Promise<RunOutcome>;
  /** Whether the LLM may see the household's values. Spencer: yes. Library default: no. */
  shareValues: boolean;
  timeZone: string;
  now(): Date;
  /** Budget left for this run, for the approval estimate. */
  remainingUsd(): number;
  /** Price of the model that runs the remaining stages, for the estimate. */
  price: ModelPrice;
  /** Receives the state after every change; persist it here. A throw stops the run. */
  save(state: RunState): Promise<void>;
  /** False when the semantic model no longer matches the database. Default: fresh. */
  modelFresh?(): Promise<boolean>;
  signal?: AbortSignal;
  limits?: Partial<PlanningLimits>;
}

/** Today as YYYY-MM-DD in `timeZone`. */
export function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const hoursAfter = (now: Date, hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

/**
 * Runs stages 1-3 for a run that is `received`, or `planning` after an answer.
 * It ends `needs_clarification`, `awaiting_approval`, `executing` (ready for
 * stages 4-6) or `failed`. Errors from the dependencies are thrown, not
 * caught: the caller marks the run failed.
 */
export async function planRun(initial: RunState, deps: PlanningDeps): Promise<RunState> {
  if (initial.status !== 'received' && initial.status !== 'planning') {
    throw new RunStateError('wrong_status', `This run is ${describeStatus(initial.status)}, so it can't be planned.`);
  }
  const limits = { ...DEFAULT_PLANNING_LIMITS, ...deps.limits };
  const now = deps.now();
  const today = todayIn(deps.timeZone, now);
  const run = track(initial, deps.save);

  await run.enter('understanding', { status: 'planning', error: null, pendingUntil: null });

  const valuesRun = await deps.query(valueQueries(deps.vocabulary));
  if (!valuesRun.ok) return run.fail('understanding', 'database', valuesRun.error.message);
  const values = readValues(deps.vocabulary, valuesRun.queries);
  const shared = deps.shareValues ? values : null;

  // Stage 1: understand the request. An answer that doesn't fit the model gets one more try.
  let intent: Intent | null = null;
  let flags: string[] = [];
  let issues: string[] | undefined;
  const clarifications = run.state.clarifications.flatMap((entry) =>
    entry.answer === null ? [] : [{ question: entry.question, answer: entry.answer }],
  );
  for (let attempt = 0; attempt < 2 && !intent; attempt += 1) {
    const result = await deps.llm.generate({
      ...intentRequest(deps.vocabulary, deps.cachePrefix, {
        request: run.state.request,
        clarifications,
        values: shared,
        today,
        timeZone: deps.timeZone,
        ...(issues && { issues }),
      }),
      ...(deps.signal && { signal: deps.signal }),
    });
    run.account(result.calls);
    if (!result.ok) return run.fail('understanding', result.error.code, result.error.message);
    const verdict = checkIntent(result.output, { vocabulary: deps.vocabulary, values, today });
    if (verdict.verdict === 'invalid') {
      issues = verdict.issues;
      continue;
    }
    if (verdict.verdict === 'refuse') return run.fail('understanding', verdict.code, verdict.reason);
    if (verdict.verdict === 'clarify') {
      const asked = run.state.clarifications.length;
      if (asked >= limits.maxClarifications) {
        return run.fail('understanding', 'unclear', `The request is still unclear after ${asked} questions.`, [
          verdict.question,
        ]);
      }
      run.finishStage();
      await run.update({
        status: 'needs_clarification',
        clarifications: [
          ...run.state.clarifications,
          { question: verdict.question, options: verdict.options, answer: null, askedAt: now.toISOString() },
        ],
        pendingUntil: hoursAfter(now, limits.pendingHours),
      });
      return run.state;
    }
    intent = verdict.intent;
    flags = verdict.flags;
  }
  if (!intent) {
    return run.fail('understanding', 'invalid_output', "The request couldn't be turned into a valid intent.", issues);
  }

  // Stage 2: check that the data is there.
  await run.enter('checking', { intent, flags });
  const fresh = deps.modelFresh ? await deps.modelFresh() : true;
  const probes = feasibilityQueries(intent, deps.vocabulary);
  const probed = probes.length > 0 ? await deps.query(probes) : null;
  if (probed && !probed.ok) return run.fail('checking', 'database', probed.error.message);
  const feasibility = judgeFeasibility(intent, deps.vocabulary, probed?.queries ?? [], { modelFresh: fresh });
  if (feasibility.status === 'no') {
    await run.update({ feasibility });
    return run.fail('checking', 'infeasible', feasibility.gaps.join(' '), feasibility.alternatives);
  }
  if (feasibility.status === 'partial') flags = [...flags, ...feasibility.gaps];

  // Stage 3: plan. A plan that fails its checks gets one more try, with the problems listed.
  await run.enter('planning', { feasibility, flags });
  let plan: ReportPlan | null = null;
  let unchecked: string[] = [];
  let planIssues: string[] | undefined;
  for (let attempt = 0; attempt < 2 && !plan; attempt += 1) {
    const result = await deps.llm.generate({
      ...planRequest(deps.vocabulary, deps.cachePrefix, {
        request: run.state.request,
        intent,
        feasibility,
        values: shared,
        today,
        timeZone: deps.timeZone,
        ...(planIssues && { issues: planIssues }),
      }),
      ...(deps.signal && { signal: deps.signal }),
    });
    run.account(result.calls);
    if (!result.ok) return run.fail('planning', result.error.code, result.error.message);
    const verdict = checkPlan(result.output, { vocabulary: deps.vocabulary, values });
    if (verdict.verdict === 'invalid') {
      planIssues = verdict.issues;
      continue;
    }
    plan = verdict.plan;
    unchecked = verdict.unchecked;
  }
  if (!plan) return run.fail('planning', 'invalid_output', "Couldn't make a valid plan.", planIssues);
  run.finishStage();

  const estimateUsd = estimateRemainingCost(plan, deps.price, Math.ceil(deps.cachePrefix.length / 3.5));
  const reasons = approvalReasons({ flags, plan, estimateUsd, remainingUsd: deps.remainingUsd() });
  const planned = { plan, planHash: planHash(plan), unchecked };
  if (reasons.length > 0) {
    await run.update({
      ...planned,
      status: 'awaiting_approval',
      approval: { reasons, estimateUsd },
      pendingUntil: hoursAfter(now, limits.pendingHours),
    });
  } else {
    await run.update({ ...planned, status: 'executing', stage: null, approval: null, pendingUntil: null });
  }
  return run.state;
}

const isPastDue = (state: RunState, now: Date) =>
  state.pendingUntil !== null && now.getTime() >= Date.parse(state.pendingUntil);

/** Records the answer to the open question. Call planRun with the result. */
export function answerClarification(state: RunState, answer: string, now: Date): RunState {
  if (state.status !== 'needs_clarification') {
    throw new RunStateError('wrong_status', `This run is ${describeStatus(state.status)}, so it has no open question.`);
  }
  if (isPastDue(state, now)) throw new RunStateError('expired', 'The question has expired.');
  const text = answer.trim();
  if (text.length === 0 || text.length > MAX_ANSWER_LENGTH) {
    throw new RunStateError('bad_request', `An answer is 1 to ${MAX_ANSWER_LENGTH} characters.`);
  }
  const open = state.clarifications.at(-1);
  if (!open || open.answer !== null) throw new RunStateError('wrong_status', 'There is no open question.');
  // Everything after the question is worked out again from the answer.
  return {
    ...state,
    status: 'planning',
    clarifications: [...state.clarifications.slice(0, -1), { ...open, answer: text }],
    intent: null,
    flags: [],
    feasibility: null,
    plan: null,
    planHash: null,
    unchecked: [],
    approval: null,
    pendingUntil: null,
  };
}

/**
 * Approves the plan the person saw, identified by its hash. Persist it with a
 * conditional update on the same status and hash, so a double click can't run
 * the report twice and an edited plan can't skip approval. The caller checks
 * that the person approving is the one who asked.
 */
export function approvePlan(state: RunState, seenHash: string, now: Date): RunState {
  if (state.status !== 'awaiting_approval') {
    throw new RunStateError('wrong_status', `This run is ${describeStatus(state.status)}, so there is nothing to approve.`);
  }
  if (!state.planHash || seenHash !== state.planHash) {
    throw new RunStateError('plan_changed', 'The plan changed since it was shown. Review it again.');
  }
  if (isPastDue(state, now)) throw new RunStateError('expired', 'The approval has expired.');
  return { ...state, status: 'executing', stage: null, pendingUntil: null };
}

/** The person declines the open question or the plan. */
export function rejectRun(state: RunState): RunState {
  if (state.status !== 'needs_clarification' && state.status !== 'awaiting_approval') {
    throw new RunStateError('wrong_status', `This run is ${describeStatus(state.status)}, so it can't be rejected.`);
  }
  return { ...state, status: 'rejected', pendingUntil: null };
}

/** Expires an open question or approval that is past due; anything else comes back unchanged. */
export function expireRun(state: RunState, now: Date): RunState {
  const pending = state.status === 'needs_clarification' || state.status === 'awaiting_approval';
  return pending && isPastDue(state, now) ? { ...state, status: 'expired' } : state;
}
