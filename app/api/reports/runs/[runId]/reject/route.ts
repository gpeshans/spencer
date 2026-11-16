import { rejectRun } from 'report-engine';

import { failure, isRunId, problem, readJson, signedIn } from '@/lib/reports/http';
import { expireIfDue } from '@/lib/reports/runner';
import { claimRun, loadRun, recordEvent } from '@/lib/reports/store';

/** Declines the open question or the plan; the run ends `rejected`. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const me = await signedIn();
  if (me instanceof Response) return me;
  // An empty JSON body, but JSON all the same: no cross-site form can send it.
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const { runId } = await params;
  if (!isRunId(runId)) return problem(404, 'not_found', 'There is no such report run.');
  try {
    const state = await loadRun(me.supabase, runId);
    if (!state) return problem(404, 'not_found', 'There is no such report run.');
    const rejected = rejectRun(await expireIfDue(state, me.owner));
    if (!(await claimRun(rejected, me.owner.ownerId, ['needs_clarification', 'awaiting_approval']))) {
      return problem(409, 'conflict', 'The run has moved on. Reload it.');
    }
    await recordEvent('reject', me.owner, runId);
    return Response.json({ run: rejected });
  } catch (error) {
    return failure(error, `POST /api/reports/runs/${runId}/reject`);
  }
}
