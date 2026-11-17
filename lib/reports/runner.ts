import 'server-only';

import { after } from 'next/server';
import {
  allGuards,
  canTransition,
  createAnthropicProvider,
  createRunBudget,
  executeRun,
  expireRun,
  planRun,
  signScope,
  type ReportQuery,
  type RunState,
  type SpendGuard,
} from 'report-engine';

import { APP_TIMEZONE } from '@/lib/format';
import { reportsConfig } from '@/reports.config';

import { reportEngine } from './engine';
import { reportsEnv } from './env';
import { createEventStream } from './sse';
import { stalledFailure, type StoredRun } from './status';
import { claimRun, recordEvent, recordLlmCall, recordProbes, recordQuery, saveRun, spentSince, type Owner } from './store';

/**
 * Runs a report through the engine for one person: their household's signed
 * scope, the run and daily budgets, and every LLM call, query and state saved
 * as it happens (docs/report-engine-spec.md §9).
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Work on a run stops after this long, so it always ends saved, inside the
 * function's 300 s (spec §5.7). Every LLM call gets the deadline as its signal.
 * A stage that is cut off fails the run with a message saying it took too long.
 */
export const RUN_DEADLINE_MS = 270_000;

/** The household's LLM spend over the last 24 hours stays under the daily budget. */
const dailyBudget: SpendGuard = {
  async before() {
    const spent = await spentSince(new Date(Date.now() - DAY_MS));
    return spent < reportsConfig.limits.dailyUsd
      ? { ok: true }
      : { ok: false, message: `The daily budget for reports ($${reportsConfig.limits.dailyUsd.toFixed(2)}) is used up.` };
  },
  // The spend is read back from report_llm_calls, which every call is written to.
  after() {},
};

export async function dailyBudgetLeft(): Promise<boolean> {
  return (await dailyBudget.before('check')).ok;
}

/** Runs whatever comes next for the run: planning, then execution if nothing pauses it. */
async function drive(initial: RunState, owner: Owner, emit: (state: RunState) => void): Promise<RunState> {
  let latest = initial;
  const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
  try {
    const env = reportsEnv();
    const engine = reportEngine();
    const budget = createRunBudget(reportsConfig.limits.runUsd, initial.costUsd);
    const llm = createAnthropicProvider({
      apiKey: env.anthropicApiKey,
      guard: allGuards(budget, dailyBudget),
      onCall: (call) => recordLlmCall(initial.id, owner.ownerId, call),
    });
    const run = (queries: readonly ReportQuery[]) =>
      engine.executor.run({
        scope: {
          setting: reportsConfig.scope.setting,
          value: signScope({ tenantId: owner.groupId, runId: initial.id, key: env.scopeKey }),
          verifySql: reportsConfig.scope.verifySql,
          expectedTenant: owner.groupId,
        },
        queries,
      });
    const save = async (next: RunState) => {
      // A stage cut off by the deadline fails as "aborted"; say why, before the
      // failure is stored (a finished run is never written again).
      const state =
        deadline.aborted && next.status === 'failed' && next.error?.code === 'aborted'
          ? {
              ...next,
              error: {
                ...next.error,
                code: 'timeout',
                message: 'The report took too long and was stopped. Try a simpler question, or try again.',
              },
            }
          : next;
      await saveRun(state, owner.ownerId);
      latest = state;
      emit(state);
    };
    const shared = { vocabulary: engine.vocabulary, cachePrefix: engine.cachePrefix, llm, timeZone: APP_TIMEZONE, now: () => new Date(), save };

    let state = initial;
    if (state.status === 'received' || state.status === 'planning') {
      state = await planRun(state, {
        ...shared,
        query: async (queries) => {
          const outcome = await run(queries);
          await recordProbes(initial.id, queries, outcome.queries);
          return outcome;
        },
        shareValues: reportsConfig.shareValues,
        remainingUsd: () => reportsConfig.limits.runUsd - budget.spentUsd(),
        price: engine.price,
        signal: deadline,
      });
    }
    if (state.status === 'executing') {
      state = await executeRun(state, {
        ...shared,
        model: engine.model,
        guard: engine.guard,
        query: run,
        recordQuery: (attempt) => recordQuery(initial.id, attempt),
        // The narrative sees the computed figures, as planning sees the household's values.
        shareValues: reportsConfig.shareValues,
        signal: deadline,
      });
    }
    // What was stored and streamed, which may differ from the engine's copy (see save).
    return latest;
  } catch (error) {
    // A dependency failed (the database, a recorder): stop the run where it is.
    console.error(`report run ${initial.id} stopped:`, error);
    if (!canTransition(latest.status, 'failed')) return latest;
    const failed: RunState = {
      ...latest,
      status: 'failed',
      error: {
        stage: latest.stage ?? (latest.status === 'executing' ? 'writing_sql' : 'understanding'),
        code: 'internal',
        message: 'The run stopped unexpectedly. Try again in a moment.',
      },
    };
    try {
      await saveRun(failed, owner.ownerId);
    } catch (saveError) {
      console.error(`report run ${initial.id}: could not save the failure:`, saveError);
    }
    emit(failed);
    return failed;
  }
}

/**
 * Starts work on the run and streams every saved state until it pauses or
 * ends. The work goes on after the response, so a closed tab loses nothing.
 */
export function streamRun(state: RunState, owner: Owner): Response {
  const events = createEventStream();
  events.send('state', state);
  const work = drive(state, owner, (next) => events.send('state', next)).finally(() => events.close());
  after(() => work);
  return events.response;
}

/** Starts work after the response, unwatched; the page polls the run. */
export function runInBackground(state: RunState, owner: Owner): void {
  after(() => drive(state, owner, () => {}));
}

/**
 * Brings a stored run up to date before anyone acts on it: a working run that
 * stalled is marked failed, so its page stops waiting, and an open question or
 * approval that is past due expires.
 */
export async function settleRun(stored: StoredRun, owner: Owner): Promise<RunState> {
  const failed = stalledFailure(stored, new Date());
  if (!failed) return expireIfDue(stored.state, owner);
  // Only if no one has saved the run since it was read.
  const claimed = await claimRun(failed, owner.ownerId, [stored.state.status], { updatedAt: stored.updatedAt });
  return claimed ? failed : stored.state;
}

/** Expires an open question or approval that is past due, so a stale run can't be acted on. */
async function expireIfDue(state: RunState, owner: Owner): Promise<RunState> {
  const expired = expireRun(state, new Date());
  if (expired === state) return state;
  if (await claimRun(expired, owner.ownerId, [state.status])) {
    await recordEvent('expire', owner, state.id);
    return expired;
  }
  return state;
}

export const RUN_LIMIT_WINDOW_MS = HOUR_MS;
