import { randomUUID } from 'node:crypto';

import { newRun } from 'report-engine';

import { reportsEnv } from '@/lib/reports/env';
import { failure, problem, readJson, signedIn } from '@/lib/reports/http';
import { dailyBudgetLeft, RUN_LIMIT_WINDOW_MS, streamRun } from '@/lib/reports/runner';
import { insertRun, recordEvent, runsStartedSince } from '@/lib/reports/store';
import { reportsConfig } from '@/reports.config';

// Planning runs inside this request, and so does execution when no approval is
// needed. The spec keeps a whole run under 280 s.
export const maxDuration = 300;

/** Starts a run and streams its saved states (server-sent events) until it pauses or ends. */
export async function POST(request: Request): Promise<Response> {
  const me = await signedIn();
  if (me instanceof Response) return me;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  try {
    reportsEnv();
    const state = newRun(randomUUID(), typeof body.request === 'string' ? body.request : '');
    const { runsPerHour } = reportsConfig.limits;
    if ((await runsStartedSince(me.owner.ownerId, new Date(Date.now() - RUN_LIMIT_WINDOW_MS))) >= runsPerHour) {
      return problem(429, 'rate_limited', `You can start ${runsPerHour} reports an hour. Try again later.`);
    }
    if (!(await dailyBudgetLeft())) {
      return problem(429, 'budget_exceeded', 'The daily budget for reports is used up. Try again tomorrow.');
    }
    await insertRun(state, me.owner);
    await recordEvent('create', me.owner, state.id, { length: state.request.length });
    return streamRun(state, me.owner);
  } catch (error) {
    return failure(error, 'POST /api/reports/runs');
  }
}
