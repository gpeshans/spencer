import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RunScreen } from '@/components/reports/run-screen';
import { isRunId } from '@/lib/reports/ids';
import { loadRun } from '@/lib/reports/store';
import { getProfile } from '@/lib/session';
import { reportsConfig } from '@/reports.config';

export default async function ReportRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!isRunId(runId)) notFound();
  const context = await getProfile();
  if (!context) notFound();
  // Read as the signed-in person: RLS hides everyone else's runs.
  const run = await loadRun(context.supabase, runId);
  if (!run) notFound();

  return (
    <div className="flex flex-col gap-4 px-4 pb-6 pt-4">
      <Link href="/reports" className="text-sm text-muted-foreground hover:text-foreground">
        ← Reports
      </Link>
      <RunScreen initial={run} pollMs={reportsConfig.pollMs} />
    </div>
  );
}
