import { failure, isRunId, problem, signedIn } from '@/lib/reports/http';
import { settleRun } from '@/lib/reports/runner';
import { loadRun } from '@/lib/reports/store';

/** A run's current state, for reloads and for polling while it works without a stream. */
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const me = await signedIn();
  if (me instanceof Response) return me;
  const { runId } = await params;
  if (!isRunId(runId)) return problem(404, 'not_found', 'There is no such report run.');
  try {
    // Read as the signed-in person: RLS hides everyone else's runs.
    const stored = await loadRun(me.supabase, runId);
    if (!stored) return problem(404, 'not_found', 'There is no such report run.');
    return Response.json({ run: await settleRun(stored, me.owner) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error, `GET /api/reports/runs/${runId}`);
  }
}
