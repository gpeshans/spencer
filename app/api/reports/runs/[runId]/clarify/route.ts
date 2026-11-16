import { answerClarification } from 'report-engine';

import { failure, isRunId, problem, readJson, signedIn } from '@/lib/reports/http';
import { expireIfDue, streamRun } from '@/lib/reports/runner';
import { claimRun, loadRun, recordEvent } from '@/lib/reports/store';

// The answer sends the run back through planning, inside this request.
export const maxDuration = 300;

/** Answers the run's open question and streams the planning that follows. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const me = await signedIn();
  if (me instanceof Response) return me;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const { runId } = await params;
  if (!isRunId(runId)) return problem(404, 'not_found', 'There is no such report run.');
  try {
    const state = await loadRun(me.supabase, runId);
    if (!state) return problem(404, 'not_found', 'There is no such report run.');
    const current = await expireIfDue(state, me.owner);
    const answered = answerClarification(current, typeof body.answer === 'string' ? body.answer : '', new Date());
    // Of two answers racing, only one moves the run on.
    if (!(await claimRun(answered, me.owner.ownerId, ['needs_clarification']))) {
      return problem(409, 'conflict', 'The run has moved on. Reload it.');
    }
    await recordEvent('clarify', me.owner, runId, { length: answered.clarifications.at(-1)?.answer?.length ?? 0 });
    return streamRun(answered, me.owner);
  } catch (error) {
    return failure(error, `POST /api/reports/runs/${runId}/clarify`);
  }
}
