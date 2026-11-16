import { approvePlan } from 'report-engine';

import { failure, isRunId, problem, readJson, signedIn } from '@/lib/reports/http';
import { runInBackground, settleRun } from '@/lib/reports/runner';
import { claimRun, loadRun, recordEvent } from '@/lib/reports/store';

// Execution continues after the response; the page polls the run.
export const maxDuration = 300;

/**
 * Approves the plan the person saw, by its hash. The update is conditional on
 * the status and the hash, so a double click can't run the report twice and a
 * changed plan can't skip approval. Only the person who asked can see the run.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const me = await signedIn();
  if (me instanceof Response) return me;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const { runId } = await params;
  if (!isRunId(runId)) return problem(404, 'not_found', 'There is no such report run.');
  const planHash = typeof body.planHash === 'string' ? body.planHash : '';
  try {
    const stored = await loadRun(me.supabase, runId);
    if (!stored) return problem(404, 'not_found', 'There is no such report run.');
    const approved = approvePlan(await settleRun(stored, me.owner), planHash, new Date());
    if (!(await claimRun(approved, me.owner.ownerId, ['awaiting_approval'], { planHash }))) {
      return problem(409, 'conflict', 'The run has moved on. Reload it.');
    }
    await recordEvent('approve', me.owner, runId, { planHash });
    runInBackground(approved, me.owner);
    return Response.json({ run: approved }, { status: 202 });
  } catch (error) {
    return failure(error, `POST /api/reports/runs/${runId}/approve`);
  }
}
