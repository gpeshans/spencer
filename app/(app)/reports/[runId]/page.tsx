import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RunScreen } from '@/components/reports/run-screen';
import { isRunId } from '@/lib/reports/ids';
import { reportPresentation } from '@/lib/reports/presentation';
import { loadRun } from '@/lib/reports/store';
import { getProfile } from '@/lib/session';
import { reportsConfig } from '@/reports.config';

export default async function ReportRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!isRunId(runId)) notFound();
  const context = await getProfile();
  if (!context) notFound();
  // Read as the signed-in person: RLS hides everyone else's runs. A stalled or
  // expired run is settled by the first poll or action, through the API.
  const stored = await loadRun(context.supabase, runId);
  if (!stored) notFound();
  const presentation = await reportPresentation();

  return (
    <div className="flex flex-col gap-4 px-4 pb-6 pt-4">
      <Link href="/reports" className="text-sm text-muted-foreground hover:text-foreground">
        ← Reports
      </Link>
      <RunScreen initial={stored.state} pollMs={reportsConfig.pollMs} presentation={presentation} />
    </div>
  );
}
