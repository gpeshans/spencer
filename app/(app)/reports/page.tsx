import Link from 'next/link';

import { NewReport } from '@/components/reports/new-report';
import { StatusBadge } from '@/components/reports/status-badge';
import { formatShortDate } from '@/lib/format';
import { reportPresentation } from '@/lib/reports/presentation';
import { recentRuns } from '@/lib/reports/store';
import { getProfile } from '@/lib/session';
import { reportsConfig } from '@/reports.config';
import model from '@/supabase/reporting/semantic-model.json';

export default async function ReportsPage() {
  // The (app) layout has already checked the session; this reuses its cached profile.
  const context = await getProfile();
  const [runs, presentation] = await Promise.all([context ? recentRuns(context.supabase, 10) : [], reportPresentation()]);
  const suggestions = model.suggestedReports.map(({ title, request }) => ({ title, request }));

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Ask a question about your household’s spending and income, and get a report with charts and tables that
          you can download as a PDF.
        </p>
      </div>

      <NewReport suggestions={suggestions} pollMs={reportsConfig.pollMs} presentation={presentation} />

      {runs.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Recent</h2>
          <ul className="flex flex-col divide-y rounded-xl ring-1 ring-foreground/10">
            {runs.map((run) => (
              <li key={run.id}>
                <Link href={`/reports/${run.id}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50">
                  <span className="min-w-0 flex-1 truncate text-sm">{run.request}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatShortDate(run.createdAt)}</span>
                  <StatusBadge status={run.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
